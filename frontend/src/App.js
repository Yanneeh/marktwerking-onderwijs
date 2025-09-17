import React, { useEffect, useState, useCallback, useMemo, createContext, useContext } from "react";
import { ethers } from "ethers";
import contractAbi from "./abi/DAOCoursePlatform.json";

import './index.css';

// Toast system
const ToastsContext = createContext();

function ToastsProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const showToast = (msg, type = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => {
      setToasts(t => t.filter(toast => toast.id !== id));
    }, 3500);
  };
  return (
    <ToastsContext.Provider value={showToast}>
      {children}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </ToastsContext.Provider>
  );
}

function useToast() {
  return useContext(ToastsContext);
}
// It implements:
// - Wallet connection (MetaMask)
// - Role detection
// - Proposals: create / vote / execute
// - Courses: list (from events), create (teacher), remove (teacher/board)
// - Enrollment: apply (student), teacher votes, student confirm (approve token), complete & distribute
// - Ratings: students can rate teachers; board can distribute bonus by rating; board payouts
//
// Notes before using:
// - Set CONTRACT_ADDRESS to your deployed contract address.
// - Ensure you have the contract ABI at ../abi/DAOCoursePlatform.json in your project.
// - This uses ethers v6. Adjust if you use v5.
// - Styling is minimal; adapt to your UI library (Tailwind/shadcn used in the project skeleton).

const CONTRACT_ADDRESS = process.env.REACT_APP_DAO_CONTRACT;
const TOKEN_ADDRESS = process.env.REACT_APP_TOKEN_ADDRESS; // Example ERC20 token address for payments


export function DAODashboard() {
  // Toast hook
  const showToast = useToast();
  // UI state
  const TABS = ["Dashboard", "Proposals", "Courses", "Treasury"];
  const [activeTab, setActiveTab] = useState("Dashboard");

  // Fetch ERC20 token balance for treasury (helper)
  const fetchTreasuryTokenBalance = useCallback(async (prov, tokenAddr) => {
    if (tokenAddr && ethers.isAddress(tokenAddr)) {
      try {
        const tokenContract = new ethers.Contract(tokenAddr, [
          "function balanceOf(address) view returns (uint256)",
          "function symbol() view returns (string)"
        ], prov);
        const bal = await tokenContract.balanceOf(CONTRACT_ADDRESS);
        let symbol = "HUT";
        try {
          symbol = await tokenContract.symbol();
        } catch { }
        setTreasuryTokenBalance(`${ethers.formatUnits(bal, 18)} ${symbol}`);
      } catch (err) {
        setTreasuryTokenBalance(null);
        console.warn("Could not fetch ERC20 treasury balance", err);
      }
    } else {
      setTreasuryTokenBalance(null);
    }
  }, []);
  const [treasuryTokenBalance, setTreasuryTokenBalance] = useState(null);
  const [treasuryBalance, setTreasuryBalance] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState(null);
  const [role, setRole] = useState("NONE");

  // App state
  const [boards, setBoards] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);

  const [proposals, setProposals] = useState([]);
  const [newProposal, setNewProposal] = useState({ candidate: "", role: "BOARD" });
  const [proposalVotes, setProposalVotes] = useState({}); // { [id]: { for: n, against: n } }

  const [courses, setCourses] = useState([]);
  const [createCourseForm, setCreateCourseForm] = useState({ title: "", price: "0", teachers: "", shares: "" });

  // Removed unused selectedCourse and setSelectedCourse
  const [enrollmentStatus, setEnrollmentStatus] = useState({}); // courseId -> enrollment info
  // enrollmentStatus is now used for tracking enrollment state per course
  const [tokenAddress, setTokenAddress] = useState(null);

  // Helper: connect wallet
  async function connectWallet() {
    if (!window.ethereum) return showToast("No Web3 wallet detected (MetaMask recommended)", "error");
    const prov = new ethers.BrowserProvider(window.ethereum);
    await prov.send("eth_requestAccounts", []);
    const signer = await prov.getSigner();
    const address = await signer.getAddress();

    setProvider(prov);
    setSigner(signer);
    setAccount(address);

    // Fetch treasury balance (contract ETH balance)
    try {
      const bal = await prov.getBalance(CONTRACT_ADDRESS);
      setTreasuryBalance(ethers.formatEther(bal));
    } catch (err) {
      setTreasuryBalance(null);
      console.warn("Could not fetch treasury balance", err);
    }

    // Fetch ERC20 token balance for treasury
    await fetchTreasuryTokenBalance(prov, TOKEN_ADDRESS);

    // Check contract address validity
    if (!ethers.isAddress(CONTRACT_ADDRESS)) {
      // If it's an ENS name, ethers.isAddress will return false
      if (CONTRACT_ADDRESS.endsWith('.eth')) {
        showToast("ENS names are not supported for contract address. Please use a valid Ethereum address.", "error");
        return;
      } else {
        showToast("Invalid contract address. Please set a valid Ethereum address in NEXT_PUBLIC_DAO_CONTRACT.", "error");
        return;
      }
    }

    const c = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, signer);
    setContract(c);

    // load role
    try {
      const roleNum = await c.roleOf(address);
      const roleName = ["NONE", "BOARD", "TEACHER", "STUDENT"][Number(roleNum)];
      setRole(roleName);
    } catch (err) {
      console.error("roleOf failed", err);
    }

    // token address
    try {
      const token = await c.paymentToken();
      setTokenAddress(token);
    } catch (err) {
      console.warn("Could not read paymentToken", err);
    }

    // load initial data
    await loadMembers(c);
    await loadEventsAndCourses(c);
    await loadProposalsFromEvents(c);
  }

  // Load role sets via contract view functions we created (boards(), teachers(), students())
  async function loadMembers(c) {
    try {
      const b = await c.boards();
      const t = await c.teachers();
      const s = await c.students();
      setBoards(b);
      setTeachers(t);
      setStudents(s);
    } catch (err) {
      console.warn("loadMembers failed", err);
    }
  }

  // --- Events-based course listing ---
  // The contract emits CourseCreated(courseId, title, price, teachers[])
  // We'll query past events to build the course list. We also listen for new ones.
  async function loadEventsAndCourses(c) {
    if (!c || !provider) return;
    try {
      const filter = c.filters.CourseCreated();
      const logs = await c.queryFilter(filter, 0, "latest");
      const parsed = logs.map((l) => {
        const ev = l.args;
        return {
          id: Number(ev[0]),
          title: ev[1],
          price: ev[2].toString(),
          teachers: ev[3],
        };
      });
      setCourses(parsed);
    } catch (err) {
      console.warn("loadEventsAndCourses err", err);
    }
  }

  async function loadProposalsFromEvents(c) {
    if (!c) return;
    try {
      const filter = c.filters.ProposalCreated();
      const logs = await c.queryFilter(filter, 0, "latest");
      const parsed = logs.map((l) => {
        const ev = l.args;
        return {
          id: Number(ev[0]),
          candidate: ev[1],
          role: ev[2],
          start: new Date(Number(ev[3]) * 1000),
          end: new Date(Number(ev[4]) * 1000),
        };
      });
      setProposals(parsed);
    } catch (err) {
      console.warn("loadProposalsFromEvents err", err);
    }
  }

  // Load proposal vote tallies from events
  async function loadVotesFromEvents(c) {
    if (!c) return;
    try {
      const filter = c.filters.Voted();
      const logs = await c.queryFilter(filter, 0, "latest");
      const counts = {};
      for (const l of logs) {
        const id = Number(l.args[0]);
        const support = Boolean(l.args[2]);
        if (!counts[id]) counts[id] = { for: 0, against: 0 };
        if (support) counts[id].for += 1; else counts[id].against += 1;
      }
      setProposalVotes(counts);
    } catch (err) {
      console.warn("loadVotesFromEvents err", err);
    }
  }

  // Create admission proposal
  async function createProposal() {
    if (!contract) return showToast("Not connected", "error");
    if (!ethers.isAddress(newProposal.candidate)) return showToast("Invalid address", "error");
    const roleEnum = { BOARD: 1, TEACHER: 2, STUDENT: 3 };
    try {
      const tx = await contract.createAdmissionProposal(newProposal.candidate, roleEnum[newProposal.role]);
      await tx.wait();
      showToast("Proposal created", "success");
      await loadProposalsFromEvents(contract);
    } catch (err) {
      console.error(err);
      showToast("Create proposal failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Cast vote on proposal
  async function castVote(proposalId, support) {
    if (!contract) return;
    try {
      const tx = await contract.castVote(proposalId, support);
      await tx.wait();
      showToast("Voted", "success");
    } catch (err) {
      console.error(err);
      showToast("Vote failed: " + (err?.reason || err.message || err), "error");
    }
  }

  async function executeProposal(proposalId) {
    if (!contract) return;
    try {
      const tx = await contract.executeProposal(proposalId);
      await tx.wait();
      showToast("Executed", "success");
      await loadMembers(contract);
    } catch (err) {
      console.error(err);
      showToast("Execute failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Create course (teacher only)
  async function createCourse() {
    if (!contract) return;
    try {
      const teachers = createCourseForm.teachers.split(",").map((s) => s.trim());
      const shares = createCourseForm.shares.split(",").map((s) => Number(s.trim()));
      const price = ethers.parseUnits(createCourseForm.price || "0", 18);
      const tx = await contract.createCourse(createCourseForm.title, price, teachers, shares);
      await tx.wait();
      showToast("Course created", "success");
      await loadEventsAndCourses(contract);
    } catch (err) {
      console.error(err);
      showToast("Create course failed: " + (err?.reason || err.message || err), "error");
    }
  }

  async function removeCourse(courseId) {
    if (!contract) return;
    try {
      const tx = await contract.removeCourse(courseId);
      await tx.wait();
      showToast("Course removed", "success");
      await loadEventsAndCourses(contract);
    } catch (err) {
      console.error(err);
      showToast("Remove failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Enrollment flows
  async function applyToCourse(courseId) {
    if (!contract) return;
    try {
      const tx = await contract.applyToCourse(courseId);
      await tx.wait();
      setEnrollmentStatus(prev => ({ ...prev, [courseId]: { status: "applied" } }));
      showToast("Applied to course", "success");
    } catch (err) {
      console.error(err);
      showToast("Apply failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Teacher votes on enrollment
  async function teacherVoteOnEnrollment(courseId, studentAddr, support) {
    if (!contract) return;
    try {
      const tx = await contract.teacherVoteOnEnrollment(courseId, studentAddr, support);
      await tx.wait();
      setEnrollmentStatus(prev => ({ ...prev, [courseId]: { ...prev[courseId], teacherVote: support ? "approved" : "rejected" } }));
      showToast("Teacher vote recorded", "success");
    } catch (err) {
      console.error(err);
      showToast("Teacher vote failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Student confirms enrollment -> must approve token first for price
  async function confirmEnrollment(course) {
    if (!contract || !TOKEN_ADDRESS) return;
    try {
      // get price from course.price (string of number in wei)
      const priceWei = course.price;
      const token = new ethers.Contract(TOKEN_ADDRESS, [
        // minimal ABI for approve
        "function approve(address spender, uint256 amount) public returns (bool)",
      ], signer);
      // approve contract
      const tx1 = await token.approve(CONTRACT_ADDRESS, priceWei);
      await tx1.wait();
      const tx2 = await contract.confirmEnrollment(course.id);
      await tx2.wait();
      setEnrollmentStatus(prev => ({ ...prev, [course.id]: { ...prev[course.id], status: "confirmed" } }));
      showToast("Enrollment confirmed and paid", "success");
    } catch (err) {
      console.error(err);
      showToast("Confirm enrollment failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Complete course & distribute fees
  async function completeCourseAndDistribute(courseId, studentAddr) {
    if (!contract) return;
    try {
      const tx = await contract.completeCourseAndDistribute(courseId, studentAddr);
      await tx.wait();
      showToast("Course completed and funds distributed", "success");
    } catch (err) {
      console.error(err);
      showToast("Complete failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Ratings
  async function giveRating(courseId, teacherAddr, ratingValue) {
    if (!contract) return;
    try {
      const tx = await contract.giveRating(courseId, teacherAddr, ratingValue);
      await tx.wait();
      showToast("Rating submitted", "success");
    } catch (err) {
      console.error(err);
      showToast("Rating failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Bonus distribution by board
  async function distributeBonusByRating(courseId, amountTokens) {
    if (!contract || !TOKEN_ADDRESS) return;
    try {
      const amountWei = ethers.parseUnits(String(amountTokens), 18);
      const tx = await contract.distributeBonusByRating(courseId, amountWei);
      await tx.wait();
      showToast("Bonus distributed", "success");
    } catch (err) {
      console.error(err);
      showToast("Bonus failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Board payout from treasury
  async function boardPayout(to, amountTokens) {
    if (!contract) return;
    try {
      const amountWei = ethers.parseUnits(String(amountTokens), 18);
      const tx = await contract.boardPayout(to, amountWei);
      await tx.wait();
      showToast("Payout executed", "success");
    } catch (err) {
      console.error(err);
      showToast("Payout failed: " + (err?.reason || err.message || err), "error");
    }
  }

  // Utility: render address short
  function short(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  // Initial auto-connect if wallet already connected
  useEffect(() => {
    if (window.ethereum && !provider) {
      // do nothing until user clicks connect for safety
    }
  }, [provider]);

  // Update token balance if tokenAddress changes and wallet is connected
  useEffect(() => {
    if (provider && tokenAddress) {
      fetchTreasuryTokenBalance(provider, tokenAddress);
    }
  }, [provider, tokenAddress, fetchTreasuryTokenBalance]);

  // Listen to events for new courses/proposals
  useEffect(() => {
    if (!contract) return;
    const onCourseCreated = (courseId, title, price, teachers) => {
      setCourses((prev) => {
        // avoid duplicates
        if (prev.find((c) => c.id === Number(courseId))) return prev;
        return [...prev, { id: Number(courseId), title, price: price.toString(), teachers }];
      });
    };

    const onProposalCreated = (id, candidate, role, start, end) => {
      setProposals((prev) => {
        if (prev.find((p) => p.id === Number(id))) return prev;
        return [...prev, { id: Number(id), candidate, role, start: new Date(Number(start) * 1000), end: new Date(Number(end) * 1000) }];
      });
    };

    const onVoted = (id, voter, support) => {
      const pid = Number(id);
      setProposalVotes((prev) => {
        const cur = prev[pid] || { for: 0, against: 0 };
        // We don't de-duplicate per voter here; event stream already enforces once per voter
        return { ...prev, [pid]: { for: cur.for + (support ? 1 : 0), against: cur.against + (!support ? 1 : 0) } };
      });
    };

    contract.on("CourseCreated", onCourseCreated);
    contract.on("ProposalCreated", onProposalCreated);
    contract.on("Voted", onVoted);

    return () => {
      try {
        contract.off("CourseCreated", onCourseCreated);
        contract.off("ProposalCreated", onProposalCreated);
        contract.off("Voted", onVoted);
      } catch (e) { }
    };
  }, [contract, provider]);

  // Initial load of votes after proposals load
  useEffect(() => {
    if (contract) loadVotesFromEvents(contract);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract]);

  // Derived: role-specific tagline
  const roleTag = useMemo(() => {
    if (!account) return "";
    if (role === "BOARD") return "Board member dashboard";
    if (role === "TEACHER") return "Teacher dashboard";
    if (role === "STUDENT") return "Student dashboard";
    return "Guest";
  }, [role, account]);

  const Welcome = (
    <div className="max-w-4xl mx-auto text-center mt-16">
      <img src={process.env.PUBLIC_URL + "/dao-logo-text.png"} alt="CourseDAO Logo" className="mx-auto h-32 md:h-48" />
      <p className="mt-3 text-gray-600">Collaborative course platform with proposals, treasury, and role-based workflows.</p>
      <div className="mt-8">
        <button className="btn text-base md:text-lg px-8 py-3" onClick={connectWallet}>Connect to MetaMask</button>
      </div>
      <p className="mt-2 text-sm text-gray-500">Make sure MetaMask is installed.</p>
    </div>
  );

  // Admission proposal form for Quest users (role NONE, but connected)
  const AdmissionProposalForm = (
    <div className="max-w-xl mx-auto mt-12 card">
      <h2 className="section-title text-center">Request Admission</h2>
      <p className="text-sm text-gray-600 mb-4 text-center">You are connected but not yet admitted. Submit a proposal to join as Board, Teacher, or Student.</p>
      <label className="block text-sm">Your address</label>
      <input className="input mb-2" value={account} disabled />
      <label className="block text-sm mt-2">Role you want to request</label>
      <select className="input" value={newProposal.role} onChange={e => setNewProposal({ ...newProposal, role: e.target.value, candidate: account })}>
        <option value="BOARD">BOARD</option>
        <option value="TEACHER">TEACHER</option>
        <option value="STUDENT">STUDENT</option>
      </select>
      <button className="btn mt-4 w-full" onClick={() => createProposal()}>Submit Admission Proposal</button>
    </div>
  );

  const Header = (
    <header className="max-w-6xl mx-auto px-6 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <img src={process.env.PUBLIC_URL + "/dao-logo-text.png"} alt="CourseDAO Logo" className="h-20 md:h-28" />
          <div className="text-xs text-gray-600 mt-1">{roleTag}</div>
        </div>
        <div className="flex items-center gap-3">
          {account ? (
            <span className="badge badge-pink">{short(account)} • {role}</span>
          ) : (
            <button className="btn" onClick={connectWallet}>Connect</button>
          )}
        </div>
      </div>
      {account && role !== 'NONE' && (
        <div className="mt-4 tabs">
          {TABS.map(t => (
            <button key={t} className={`tab ${activeTab === t ? 'tab-active' : ''}`} onClick={() => setActiveTab(t)}>{t}</button>
          ))}
        </div>
      )}
    </header>
  );

  function ProposalCard({ p }) {
    const counts = proposalVotes[p.id] || { for: 0, against: 0 };
    const total = counts.for + counts.against;
    const forPct = total ? Math.round((counts.for / total) * 100) : 0;
    const againstPct = total ? 100 - forPct : 0;
    const now = Date.now();
    const open = p.end && now < p.end.getTime();
    return (
      <div className="card mb-3">
        <div className="flex items-center justify-between">
          <div className="font-medium">Proposal #{p.id}</div>
          <div className="text-xs text-gray-600">{open ? 'Open' : 'Closed'}</div>
        </div>
        <div className="mt-1 text-sm">Candidate: <span className="font-mono">{short(p.candidate)}</span></div>
        <div className="text-sm">Role: <span className="badge badge-purple">{
          (() => {
            const roles = ['NONE', 'BOARD', 'TEACHER', 'STUDENT'];
            if (typeof p.role === 'number') return roles[p.role] || p.role;
            if (!isNaN(Number(p.role))) return roles[Number(p.role)] || p.role;
            if (roles.includes(p.role)) return p.role;
            return String(p.role);
          })()
        }</span></div>
        <div className="mt-3">
          <div className="vote-bar">
            <div className="vote-for" style={{ width: `${forPct}%` }} />
            <div className="vote-against" style={{ width: `${againstPct}%` }} />
          </div>
          <div className="mt-1 text-xs text-gray-700 flex justify-between">
            <span>For: {counts.for}</span>
            <span>Against: {counts.against}</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-outline" disabled={!open} onClick={() => castVote(p.id, true)}>Vote For</button>
          <button className="btn-outline" disabled={!open} onClick={() => castVote(p.id, false)}>Vote Against</button>
          <button className="btn-outline" onClick={() => executeProposal(p.id)}>Execute</button>
        </div>
        <div className="mt-2 text-xs text-gray-500">Start: {p.start?.toLocaleString?.() || '-'} • End: {p.end?.toLocaleString?.() || '-'}</div>
      </div>
    );
  }

  const DashboardTab = (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <div className="section-title">Members</div>
          <div className="text-sm">Boards ({boards.length}): {boards.map(b => <span key={b} className="mr-2 badge">{short(b)}</span>)}</div>
          <div className="text-sm mt-1">Teachers ({teachers.length}): {teachers.map(t => <span key={t} className="mr-2 badge">{short(t)}</span>)}</div>
          <div className="text-sm mt-1">Students ({students.length}): {students.map(s => <span key={s} className="mr-2 badge">{short(s)}</span>)}</div>
        </div>
        <div className="card">
          <div className="section-title">Payment token</div>
          <div className="font-mono text-sm break-all">{tokenAddress || TOKEN_ADDRESS || '-'}</div>
        </div>
        <div className="card">
          <div className="section-title">Quick actions</div>
          {!account && <button className="btn w-full" onClick={connectWallet}>Connect</button>}
          {role === 'BOARD' && <a href="#treasury" className="btn-outline w-full text-center" onClick={() => setActiveTab('Treasury')}>Open Treasury</a>}
          {role === 'TEACHER' && <a href="#courses" className="btn-outline w-full text-center" onClick={() => setActiveTab('Courses')}>Create Course</a>}
          {role === 'STUDENT' && <a href="#courses" className="btn-outline w-full text-center" onClick={() => setActiveTab('Courses')}>Browse Courses</a>}
        </div>
      </div>

      {role !== 'NONE' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card">
            <div className="section-title">Create Admission Proposal</div>
            <label className="block text-sm">Candidate address</label>
            <input className="input" value={newProposal.candidate} onChange={e => setNewProposal({ ...newProposal, candidate: e.target.value })} />
            <label className="block text-sm mt-2">Role</label>
            <select className="input" value={newProposal.role} onChange={e => setNewProposal({ ...newProposal, role: e.target.value })}>
              <option value="BOARD">BOARD</option>
              <option value="TEACHER">TEACHER</option>
              <option value="STUDENT">STUDENT</option>
            </select>
            <button className="btn mt-3" onClick={createProposal}>Create Proposal</button>
          </div>

          <div className="card">
            <div className="section-title">Recent Proposals</div>
            {proposals.length === 0 && <div className="text-sm text-gray-500">No proposals yet</div>}
            {proposals.slice(-3).reverse().map(p => <ProposalCard key={p.id} p={p} />)}
          </div>
        </div>
      )}
    </div>
  );

  const ProposalsTab = (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="card">
        <div className="section-title">All Proposals</div>
        {proposals.length === 0 && <div className="text-sm text-gray-500">No proposals yet</div>}
        {proposals.sort((a, b) => a.id - b.id).map(p => <ProposalCard key={p.id} p={p} />)}
      </div>
    </div>
  );

  const CoursesTab = (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      {role === 'TEACHER' && (
        <div className="card">
          <div className="section-title">Create Course</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Title" className="input" value={createCourseForm.title} onChange={e => setCreateCourseForm({ ...createCourseForm, title: e.target.value })} />
            <input placeholder="Price (tokens)" className="input" value={createCourseForm.price} onChange={e => setCreateCourseForm({ ...createCourseForm, price: e.target.value })} />
            <input placeholder="Teachers (comma-separated addresses)" className="input" value={createCourseForm.teachers} onChange={e => setCreateCourseForm({ ...createCourseForm, teachers: e.target.value })} />
            <input placeholder="Shares (comma-separated, sum=10000)" className="input" value={createCourseForm.shares} onChange={e => setCreateCourseForm({ ...createCourseForm, shares: e.target.value })} />
          </div>
          <div className="mt-3">
            <button className="btn" onClick={createCourse}>Create</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-title">Courses</div>
        {courses.length === 0 && <div className="text-sm text-gray-500">No courses yet (check contract events)</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {courses.map(c => (
            <div key={c.id} className="card">
              <div className="font-semibold">{c.title} <span className="text-xs text-gray-500">(ID: {c.id})</span></div>
              <div className="text-sm mt-1">Price: {ethers.formatUnits(c.price || "0", 18)} tokens</div>
              <div className="text-sm mt-1">Teachers: {c.teachers.map(t => short(t)).join(", ")}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {role === "STUDENT" && <button className="btn-outline" onClick={() => applyToCourse(c.id)}>Apply</button>}
                {(role === "TEACHER" || role === "BOARD") && <button className="btn-outline" onClick={() => removeCourse(c.id)}>Remove</button>}
                {role === "STUDENT" && <button className="btn-outline" onClick={() => confirmEnrollment(c)}>Confirm & Pay</button>}
                {(role === "STUDENT" || role === "TEACHER") && enrollmentStatus[c.id] && (
                  <span className="ml-2 text-xs text-gray-700">Status: {enrollmentStatus[c.id].status || "applied"} {enrollmentStatus[c.id].teacherVote && ` (Teacher: ${enrollmentStatus[c.id].teacherVote})`}</span>
                )}
              </div>
              {role === "TEACHER" && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input placeholder="Student address" id={`vote_student_${c.id}`} className="input" />
                    <button className="btn-outline" onClick={() => {
                      const studentAddr = document.getElementById(`vote_student_${c.id}`).value;
                      teacherVoteOnEnrollment(c.id, studentAddr, true);
                    }}>Vote For</button>
                    <button className="btn-outline" onClick={() => {
                      const studentAddr = document.getElementById(`vote_student_${c.id}`).value;
                      teacherVoteOnEnrollment(c.id, studentAddr, false);
                    }}>Vote Against</button>
                  </div>
                </div>
              )}
              <div className="mt-3">
                <div className="text-sm">Rate teachers:</div>
                {c.teachers.map(t => (
                  <div key={t} className="flex items-center gap-2 mt-1">
                    <span className="font-mono text-xs">{short(t)}</span>
                    <select className="input" onChange={(e) => giveRating(c.id, t, Number(e.target.value))} defaultValue="0">
                      <option value="0">Rate</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <div className="flex gap-2">
                  <input placeholder="Complete for student address" id={`complete_${c.id}`} className="input" />
                  <button className="btn-outline" onClick={() => {
                    const studentAddr = document.getElementById(`complete_${c.id}`).value;
                    completeCourseAndDistribute(c.id, studentAddr);
                  }}>Complete & Distribute</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );


  // Helper: get all participants for dropdown
  const allParticipants = useMemo(() => {
    // Remove duplicates
    const set = new Set([...boards, ...teachers, ...students]);
    return Array.from(set);
  }, [boards, teachers, students]);

  // Treasury payout state
  const [selectedRecipient, setSelectedRecipient] = useState("");
  const [payoutAmount, setPayoutAmount] = useState("");

  // Bonus distribution state
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [bonusAmount, setBonusAmount] = useState("");

  const TreasuryTab = (
    <div id="treasury" className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <div className="section-title">Treasury Balances</div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">ETH:</span>
            <span className="font-mono">{treasuryBalance !== null ? `${treasuryBalance} ETH` : '-'}</span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="text-gray-600">Token:</span>
            <span className="font-mono">{treasuryTokenBalance !== null ? treasuryTokenBalance : '-'}</span>
          </div>
        </div>
        <div className="card">
          <div className="section-title">Payment Token</div>
          <div className="font-mono text-sm break-all">{tokenAddress || TOKEN_ADDRESS || '-'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Board Payout Card */}
        <div className="card">
          <div className="section-title">Board Payout</div>
          {role !== 'BOARD' && <div className="text-sm text-gray-500">You must be a board member to use these actions.</div>}
          {role === 'BOARD' && (
            <div className="space-y-2">
              <label className="block text-sm">Recipient</label>
              <select
                className="input w-full"
                value={selectedRecipient}
                onChange={e => setSelectedRecipient(e.target.value)}
              >
                <option value="">Select recipient</option>
                {allParticipants.map(addr => (
                  <option key={addr} value={addr}>{short(addr)} ({addr})</option>
                ))}
              </select>
              <label className="block text-sm mt-2">Amount (tokens)</label>
              <input
                className="input w-full"
                type="number"
                min="0"
                value={payoutAmount}
                onChange={e => setPayoutAmount(e.target.value)}
                placeholder="Amount tokens"
              />
              <button
                className="btn mt-3 w-full"
                onClick={() => {
                  if (!selectedRecipient || !payoutAmount) return showToast("Select recipient and amount", "error");
                  boardPayout(selectedRecipient, payoutAmount);
                }}
              >Payout</button>
            </div>
          )}
        </div>

        {/* Bonus Distribution Card */}
        <div className="card">
          <div className="section-title">Bonus Distribution</div>
          {role !== 'BOARD' && <div className="text-sm text-gray-500">You must be a board member to use these actions.</div>}
          {role === 'BOARD' && (
            <div className="space-y-2">
              <label className="block text-sm">Course</label>
              <select
                className="input w-full"
                value={selectedCourseId}
                onChange={e => setSelectedCourseId(e.target.value)}
              >
                <option value="">Select course</option>
                {courses.map(c => (
                  <option key={c.id} value={c.id}>{c.title} (ID: {c.id})</option>
                ))}
              </select>
              <label className="block text-sm mt-2">Amount (tokens)</label>
              <input
                className="input w-full"
                type="number"
                min="0"
                value={bonusAmount}
                onChange={e => setBonusAmount(e.target.value)}
                placeholder="Amount tokens"
              />
              <button
                className="btn mt-3 w-full"
                onClick={() => {
                  if (!selectedCourseId || !bonusAmount) return showToast("Select course and amount", "error");
                  distributeBonusByRating(Number(selectedCourseId), bonusAmount);
                }}
              >Distribute Bonus</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {Header}
      {!account ? (
        Welcome
      ) : role === 'NONE' ? (
        AdmissionProposalForm
      ) : (
        <main>
          {activeTab === 'Dashboard' && DashboardTab}
          {activeTab === 'Proposals' && ProposalsTab}
          {activeTab === 'Courses' && CoursesTab}
          {activeTab === 'Treasury' && TreasuryTab}
        </main>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastsProvider>
      <DAODashboard />
    </ToastsProvider>
  );
}
