// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DAOCoursePlatform
 * @notice Een onderwijs-DAO contract met rol-gebaseerde toelatings-votes, course management,
 *         betalingen in ERC20-stablecoin, en distributie + rating mechanics.
 *
 * Rollen:
 *  - BOARD (bestuurders)
 *  - TEACHER (docenten)
 *  - STUDENT (studenten)
 *
 * Toelatingen/votes:
 *  - STUDENTS stemmen over toevoeging van BOARD members
 *  - TEACHERS stemmen over toevoeging van STUDENTS
 *  - BOARD stemmen over toevoeging van TEACHERS
 *
 * Initial board members worden door de deployer opgegeven.
 * Board members kunnen uit de treasury betalen aan studenten.
 * Docenten kunnen courses maken/ verwijderen, studenten kunnen zich aanmelden.
 * Nadat docenten stemmen en student bevestigt, wordt betaling uitgevoerd (student moet eerst approve geven).
 * Na voltooiing wordt cursusgeld verdeeld onder docenten volgens shares.
 * Studenten kunnen docenten beoordelen; daaruit kan een bonusregeling gedistribueerd worden.
 */
contract DAOCoursePlatform is Ownable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    enum Role { NONE, BOARD, TEACHER, STUDENT }

    IERC20 public immutable paymentToken;

    // Role sets
    EnumerableSet.AddressSet private _boards;
    EnumerableSet.AddressSet private _teachers;
    EnumerableSet.AddressSet private _students;

    // --- Voting proposals for role admission ---
    struct Proposal {
        uint256 id;
        address candidate;
        Role roleToAdd;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 start; // block.timestamp
        uint256 end;   // block.timestamp + duration
        bool executed;
        mapping(address => bool) voted;
    }

    uint256 public proposalDuration = 3 minutes;
    uint256 private _nextProposalId = 1;
    mapping(uint256 => Proposal) private _proposals;
    // track active proposal per candidate (proposal id) to prevent multiple open proposals
    mapping(address => uint256) private _activeProposal;

    // --- Course management ---
    struct Course {
        uint256 id;
        string title;
        uint256 price; // in paymentToken (token decimals respected externally)
        address[] teachers;
        mapping(address => uint256) teacherShares; // shares in basis points (sum to 10000)
        bool exists;
    }

    uint256 private _nextCourseId = 1;
    mapping(uint256 => Course) private _courses;

    // Enrollment request per course per student
    struct EnrollmentRequest {
        bool exists;
        uint256 votesFor;
        uint256 votesAgainst;
        mapping(address => bool) teacherVoted;
        bool acceptedByTeachers;
        bool enrolled; // after student confirms and pays
    }

    // courseId => student => EnrollmentRequest
    mapping(uint256 => mapping(address => EnrollmentRequest)) private _enrollments;

    // Ratings: courseId -> student -> teacher -> rating (1-5)
    mapping(uint256 => mapping(address => mapping(address => uint8))) public rating;
    // Aggregate teacher rating data: teacher -> sumRatings, countRatings
    mapping(address => uint256) public teacherRatingSum;
    mapping(address => uint256) public teacherRatingCount;

    // Events
    event ProposalCreated(uint256 indexed id, address indexed candidate, Role roleToAdd, uint256 start, uint256 end);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId, bool success);

    event CourseCreated(uint256 indexed courseId, string title, uint256 price, address[] teachers);
    event CourseRemoved(uint256 indexed courseId);
    event AppliedToCourse(uint256 indexed courseId, address indexed student);
    event TeacherVotedOnEnrollment(uint256 indexed courseId, address indexed teacher, address indexed student, bool support);
    event EnrollmentConfirmed(uint256 indexed courseId, address indexed student);
    event CourseCompleted(uint256 indexed courseId, address indexed student);
    event RatingGiven(uint256 indexed courseId, address indexed student, address indexed teacher, uint8 ratingValue);
    event BonusDistributed(uint256 indexed courseId, uint256 amount);
    event TreasuryPayout(address indexed to, uint256 amount);

    // Modifiers
    modifier onlyBoard() {
        require(_boards.contains(msg.sender), "Only board");
        _;
    }
    modifier onlyTeacher() {
        require(_teachers.contains(msg.sender), "Only teacher");
        _;
    }
    modifier onlyStudent() {
        require(_students.contains(msg.sender), "Only student");
        _;
    }

    constructor(IERC20 _paymentToken, address[] memory initialBoards) Ownable(msg.sender) {
        require(initialBoards.length > 0, "Need at least one initial board");
        paymentToken = _paymentToken;
        for (uint256 i = 0; i < initialBoards.length; i++) {
            _boards.add(initialBoards[i]);
        }
    }

    // ---------- Role helpers ----------
    function roleOf(address who) public view returns (Role) {
        if (_boards.contains(who)) return Role.BOARD;
        if (_teachers.contains(who)) return Role.TEACHER;
        if (_students.contains(who)) return Role.STUDENT;
        return Role.NONE;
    }

    function boards() external view returns (address[] memory) {
        return _boards.values();
    }
    function teachers() external view returns (address[] memory) {
        return _teachers.values();
    }
    function students() external view returns (address[] memory) {
        return _students.values();
    }

    // ---------- Proposal logic ----------
    function createAdmissionProposal(address candidate, Role roleToAdd) external returns (uint256) {
        require(candidate != address(0), "Invalid candidate");
        require(roleToAdd == Role.BOARD || roleToAdd == Role.TEACHER || roleToAdd == Role.STUDENT, "Invalid role");

        // Prevent candidate having more than one active (not yet closed/executed) proposal
        uint256 existingPid = _activeProposal[candidate];
        if (existingPid != 0) {
            Proposal storage op = _proposals[existingPid];
            // if existing proposal is still within its voting window and not executed -> reject
            if (!op.executed && block.timestamp <= op.end) {
                revert("Candidate already has an active proposal");
            }
            // otherwise the previous proposal is closed/executed and we allow creating a new one
        }

        // Validate that candidate isn't already in that role
        if (roleToAdd == Role.BOARD) require(!_boards.contains(candidate), "Already board");
        if (roleToAdd == Role.TEACHER) require(!_teachers.contains(candidate), "Already teacher");
        if (roleToAdd == Role.STUDENT) require(!_students.contains(candidate), "Already student");

        uint256 pid = _nextProposalId++;
        Proposal storage p = _proposals[pid];
        p.id = pid;
        p.candidate = candidate;
        p.roleToAdd = roleToAdd;
        p.start = block.timestamp;
        p.end = block.timestamp + proposalDuration;
        p.executed = false;

        emit ProposalCreated(pid, candidate, roleToAdd, p.start, p.end);
        // mark as active proposal for the candidate
        _activeProposal[candidate] = pid;
        return pid;
    }

    function _electorateOf(Role r) internal view returns (address[] memory) {
        if (r == Role.BOARD) return _boards.values();
        if (r == Role.TEACHER) return _teachers.values();
        if (r == Role.STUDENT) return _students.values();
        return new address[](0);
    }

    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "No such proposal");
        require(block.timestamp >= p.start && block.timestamp <= p.end, "Voting closed");
        Role electorateRole;
        // STUDENTS vote on BOARD; TEACHERS vote on STUDENTS; BOARD vote on TEACHERS
        if (p.roleToAdd == Role.BOARD) electorateRole = Role.STUDENT;
        else if (p.roleToAdd == Role.STUDENT) electorateRole = Role.TEACHER;
        else if (p.roleToAdd == Role.TEACHER) electorateRole = Role.BOARD;
        else revert("Bad role");

        require(roleOf(msg.sender) == electorateRole, "Not in electorate");
        require(!p.voted[msg.sender], "Already voted");

        p.voted[msg.sender] = true;
        if (support) p.votesFor += 1;
        else p.votesAgainst += 1;

        emit Voted(proposalId, msg.sender, support);
    }

    function executeProposal(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "No such proposal");
        require(block.timestamp > p.end, "Voting still open");
        require(!p.executed, "Already executed");

        p.executed = true;

        // Determine electorate size and majority

        bool success = false;
        // Simple rule: votesFor > votesAgainst and at least one vote OR quorum of >0. Use majority of votes cast.
        if (p.votesFor > p.votesAgainst && (p.votesFor + p.votesAgainst) > 0) {
            // add role
            if (p.roleToAdd == Role.BOARD) _boards.add(p.candidate);
            else if (p.roleToAdd == Role.TEACHER) _teachers.add(p.candidate);
            else if (p.roleToAdd == Role.STUDENT) _students.add(p.candidate);
            success = true;
        }

        // clear active proposal entry for candidate so they may have new proposals later
        if (_activeProposal[p.candidate] == proposalId) {
            _activeProposal[p.candidate] = 0;
        }

        emit ProposalExecuted(proposalId, success);
    }

    // ---------- Treasury & payouts ----------
    // The contract itself acts as treasury holding paymentToken.

    function treasuryBalance() public view returns (uint256) {
        return paymentToken.balanceOf(address(this));
    }

    // Board can payout directly to student (e.g., scholarship)
    function boardPayout(address to, uint256 amount) external onlyBoard {
        require(to != address(0), "Bad addr");
        require(amount > 0, "Zero amount");
        paymentToken.safeTransfer(to, amount);
        emit TreasuryPayout(to, amount);
    }

    // ---------- Course creation / removal ----------
    function createCourse(string calldata title, uint256 price, address[] calldata courseTeachers, uint256[] calldata shares) external onlyTeacher returns (uint256) {
        require(courseTeachers.length > 0, "Need teacher(s)");
        require(courseTeachers.length == shares.length, "Teachers/shares len mismatch");

        uint256 sumShares = 0;
        for (uint256 i = 0; i < shares.length; i++) sumShares += shares[i];
        require(sumShares == 10000, "Shares must sum to 10000 (100%)");

        uint256 cid = _nextCourseId++;
        Course storage c = _courses[cid];
        c.id = cid;
        c.title = title;
        c.price = price;
        c.exists = true;

        for (uint256 i = 0; i < courseTeachers.length; i++) {
            address t = courseTeachers[i];
            require(_teachers.contains(t), "Teacher not registered");
            c.teachers.push(t);
            c.teacherShares[t] = shares[i];
        }

        emit CourseCreated(cid, title, price, courseTeachers);
        return cid;
    }

    function removeCourse(uint256 courseId) external onlyTeacher {
        Course storage c = _courses[courseId];
        require(c.exists, "No such course");
        // Only a teacher of that course or board can remove
        bool isTeacherOfCourse = false;
        for (uint256 i = 0; i < c.teachers.length; i++) if (c.teachers[i] == msg.sender) isTeacherOfCourse = true;
        require(isTeacherOfCourse || _boards.contains(msg.sender), "Not authorized to remove");

        // delete mapping data (note: teacherShares mapping entries remain but course will be marked non-existent)
        c.exists = false;
        emit CourseRemoved(courseId);
    }

    // ---------- Enrollment flow ----------
    // Student applies
    function applyToCourse(uint256 courseId) external {
        require(_students.contains(msg.sender), "Only registered student");
        Course storage c = _courses[courseId];
        require(c.exists, "Course doesn't exist");

        EnrollmentRequest storage er = _enrollments[courseId][msg.sender];
        require(!er.exists || (!er.enrolled && !er.acceptedByTeachers), "Already applied/enrolled");

        if (!er.exists) {
            er.exists = true;
            er.votesFor = 0;
            er.votesAgainst = 0;
            er.acceptedByTeachers = false;
            er.enrolled = false;
        }

        emit AppliedToCourse(courseId, msg.sender);
    }

    // A teacher of the course votes on the enrollment
    function teacherVoteOnEnrollment(uint256 courseId, address studentAddr, bool support) external onlyTeacher {
        Course storage c = _courses[courseId];
        require(c.exists, "No course");
        // must be teacher of this course
        bool isTeacherOfCourse = false;
        for (uint256 i = 0; i < c.teachers.length; i++) if (c.teachers[i] == msg.sender) isTeacherOfCourse = true;
        require(isTeacherOfCourse, "Not teacher of course");

        EnrollmentRequest storage er = _enrollments[courseId][studentAddr];
        require(er.exists, "No application");
        require(!er.teacherVoted[msg.sender], "Already voted");
        require(!er.enrolled, "Already enrolled");

        er.teacherVoted[msg.sender] = true;
        if (support) er.votesFor += 1; else er.votesAgainst += 1;

        emit TeacherVotedOnEnrollment(courseId, msg.sender, studentAddr, support);

        // if majority of teachers have voted and votesFor > votesAgainst then accept
        uint256 totalTeachers = c.teachers.length;
        uint256 votesCast = er.votesFor + er.votesAgainst;
        if (votesCast == totalTeachers) {
            if (er.votesFor > er.votesAgainst) {
                er.acceptedByTeachers = true;
            } else {
                er.acceptedByTeachers = false;
            }
        }
    }

    // After acceptance by teachers, student confirms and pays. Student must approve contract for price.
    function confirmEnrollment(uint256 courseId) external {
        require(_students.contains(msg.sender), "Only student");
        Course storage c = _courses[courseId];
        require(c.exists, "No course");

        EnrollmentRequest storage er = _enrollments[courseId][msg.sender];
        require(er.exists && !er.enrolled, "Not pending enrollment");
        require(er.acceptedByTeachers, "Not accepted by teachers yet");

        // transfer price from student to contract
        require(c.price > 0, "Course price zero");
        paymentToken.safeTransferFrom(msg.sender, address(this), c.price);
        er.enrolled = true;

        emit EnrollmentConfirmed(courseId, msg.sender);
    }

    // Course completion — called by any teacher of course or board (or owner) to distribute fees
    function completeCourseAndDistribute(uint256 courseId, address studentAddr) external {
        Course storage c = _courses[courseId];
        require(c.exists, "No course");

        // Only teacher of course, board or owner can mark complete
        bool allowed = _boards.contains(msg.sender) || owner() == msg.sender;
        bool isTeacherOfCourse = false;
        for (uint256 i = 0; i < c.teachers.length; i++) if (c.teachers[i] == msg.sender) isTeacherOfCourse = true;
        require(allowed || isTeacherOfCourse, "Not authorized to complete");

        EnrollmentRequest storage er = _enrollments[courseId][studentAddr];
        require(er.exists && er.enrolled, "Student not enrolled");

        uint256 total = c.price;
        require(paymentToken.balanceOf(address(this)) >= total, "Insufficient contract balance");

        // distribute according to shares
        for (uint256 i = 0; i < c.teachers.length; i++) {
            address t = c.teachers[i];
            uint256 shareBp = c.teacherShares[t];
            uint256 amount = (total * shareBp) / 10000;
            if (amount > 0) paymentToken.safeTransfer(t, amount);
        }

        emit CourseCompleted(courseId, studentAddr);
    }

    // ---------- Ratings & Bonus ----------
    function giveRating(uint256 courseId, address teacherAddr, uint8 ratingValue) external onlyStudent {
        require(ratingValue >= 1 && ratingValue <= 5, "Rating 1-5");
        Course storage c = _courses[courseId];
        require(c.exists, "No course");

        // student must have been enrolled in this course
        EnrollmentRequest storage er = _enrollments[courseId][msg.sender];
        require(er.exists && er.enrolled, "Not enrolled student");

        // teacher must be part of course
        bool teacherInCourse = false;
        for (uint256 i = 0; i < c.teachers.length; i++) if (c.teachers[i] == teacherAddr) teacherInCourse = true;
        require(teacherInCourse, "Teacher not in course");

        // if student already rated this teacher for this course, update aggregates
        uint8 previous = rating[courseId][msg.sender][teacherAddr];
        rating[courseId][msg.sender][teacherAddr] = ratingValue;

        if (previous == 0) {
            teacherRatingSum[teacherAddr] += ratingValue;
            teacherRatingCount[teacherAddr] += 1;
        } else {
            teacherRatingSum[teacherAddr] = teacherRatingSum[teacherAddr] + ratingValue - previous;
        }

        emit RatingGiven(courseId, msg.sender, teacherAddr, ratingValue);
    }

    // Board can distribute a bonus pool for a course to its teachers proportional to average rating
    function distributeBonusByRating(uint256 courseId, uint256 amount) external onlyBoard {
        Course storage c = _courses[courseId];
        require(c.exists, "No course");
        require(amount > 0, "Zero amount");
        require(paymentToken.balanceOf(address(this)) >= amount, "Insufficient treasury");

        // compute total weighted rating for teachers in this course
        uint256 totalWeight = 0;
        uint256[] memory teacherWeight = new uint256[](c.teachers.length);
        for (uint256 i = 0; i < c.teachers.length; i++) {
            address t = c.teachers[i];
            uint256 count = teacherRatingCount[t];
            uint256 sum = teacherRatingSum[t];
            uint256 avgBp = 0; // average * 100 (to avoid fractions)
            if (count > 0) {
                // average rating in basis points (rating 1-5 mapped to 100-500)
                avgBp = (sum * 100) / count; // 100..500
            } else {
                avgBp = 100; // default minimal weight
            }
            teacherWeight[i] = avgBp;
            totalWeight += avgBp;
        }
        require(totalWeight > 0, "No weight to distribute");

        // distribute amount proportionally
        for (uint256 i = 0; i < c.teachers.length; i++) {
            address t = c.teachers[i];
            uint256 share = (amount * teacherWeight[i]) / totalWeight;
            if (share > 0) paymentToken.safeTransfer(t, share);
        }

        emit BonusDistributed(courseId, amount);
    }

    // ---------- Admin utilities ----------
    function setProposalDuration(uint256 secondsDuration) external onlyOwner {
        proposalDuration = secondsDuration;
    }

    // emergency: owner can rescue tokens
    function rescueTokens(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
