const DAOCoursePlatform = artifacts.require("DAOCoursePlatform");
const { expectRevert, BN } = require('@openzeppelin/test-helpers');

contract("DAOCoursePlatform", accounts => {
  const [boardMember, teacher, student] = accounts;

  let dao;

  beforeEach(async () => {
    dao = await DAOCoursePlatform.new([boardMember]);
  });

  it("should have initial board member", async () => {
    const role = await dao.getRole(boardMember);
    assert.equal(role.toString(), "0", "Initial board member should be role 0 (BOARD)");
  });

  it("board can create proposal to add teacher", async () => {
    const tx = await dao.createProposal(teacher, 2, "Add Teacher", {from: boardMember});
    assert(tx.receipt.status, "Proposal creation failed");
  });

  it("student cannot vote on teacher proposals", async () => {
    await dao.createProposal(teacher, 2, "Add Teacher", {from: boardMember});
    await expectRevert(
      dao.voteProposal(0, true, {from: student}),
      "Not allowed to vote on this proposal"
    );
  });

  it("teacher can create course", async () => {
    await dao.addTeacher(teacher, {from: boardMember});
    const tx = await dao.createCourse("Math 101", web3.utils.toWei("1", "ether"), {from: teacher});
    assert(tx.receipt.status, "Course creation failed");
  });

});