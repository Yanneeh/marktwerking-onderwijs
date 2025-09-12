import React, { useEffect, useState, useCallback } from "react";
import { ethers } from "ethers";
import contractAbi from "./abi/DAOCoursePlatform.json";

import './index.css';

// This file is a single-file React dashboard for the DAOCoursePlatform contract.
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


export default function DAODashboard() {
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
        } catch {}
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

  const [courses, setCourses] = useState([]);
  const [createCourseForm, setCreateCourseForm] = useState({ title: "", price: "0", teachers: "", shares: "" });

  // Removed unused selectedCourse and setSelectedCourse
  const [enrollmentStatus, setEnrollmentStatus] = useState({}); // courseId -> enrollment info
  // enrollmentStatus is now used for tracking enrollment state per course
  const [tokenAddress, setTokenAddress] = useState(null);

  // Helper: connect wallet
  async function connectWallet() {
    if (!window.ethereum) return alert("No Web3 wallet detected (MetaMask recommended)");
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
        alert("ENS names are not supported for contract address. Please use a valid Ethereum address.");
        return;
      } else {
        alert("Invalid contract address. Please set a valid Ethereum address in NEXT_PUBLIC_DAO_CONTRACT.");
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

  // Create admission proposal
  async function createProposal() {
    if (!contract) return alert("Not connected");
    if (!ethers.isAddress(newProposal.candidate)) return alert("Invalid address");
    const roleEnum = { BOARD: 1, TEACHER: 2, STUDENT: 3 };
    try {
      const tx = await contract.createAdmissionProposal(newProposal.candidate, roleEnum[newProposal.role]);
      await tx.wait();
      alert("Proposal created");
      await loadProposalsFromEvents(contract);
    } catch (err) {
      console.error(err);
      alert("Create proposal failed: " + (err?.reason || err.message || err));
    }
  }

  // Cast vote on proposal
  async function castVote(proposalId, support) {
    if (!contract) return;
    try {
      const tx = await contract.castVote(proposalId, support);
      await tx.wait();
      alert("Voted");
    } catch (err) {
      console.error(err);
      alert("Vote failed: " + (err?.reason || err.message || err));
    }
  }

  async function executeProposal(proposalId) {
    if (!contract) return;
    try {
      const tx = await contract.executeProposal(proposalId);
      await tx.wait();
      alert("Executed");
      await loadMembers(contract);
    } catch (err) {
      console.error(err);
      alert("Execute failed: " + (err?.reason || err.message || err));
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
      alert("Course created");
      await loadEventsAndCourses(contract);
    } catch (err) {
      console.error(err);
      alert("Create course failed: " + (err?.reason || err.message || err));
    }
  }

  async function removeCourse(courseId) {
    if (!contract) return;
    try {
      const tx = await contract.removeCourse(courseId);
      await tx.wait();
      alert("Course removed");
      await loadEventsAndCourses(contract);
    } catch (err) {
      console.error(err);
      alert("Remove failed: " + (err?.reason || err.message || err));
    }
  }

  // Enrollment flows
  async function applyToCourse(courseId) {
    if (!contract) return;
    try {
      const tx = await contract.applyToCourse(courseId);
      await tx.wait();
      setEnrollmentStatus(prev => ({ ...prev, [courseId]: { status: "applied" } }));
      alert("Applied to course");
    } catch (err) {
      console.error(err);
      alert("Apply failed: " + (err?.reason || err.message || err));
    }
  }

  // Teacher votes on enrollment
  async function teacherVoteOnEnrollment(courseId, studentAddr, support) {
    if (!contract) return;
    try {
      const tx = await contract.teacherVoteOnEnrollment(courseId, studentAddr, support);
      await tx.wait();
      setEnrollmentStatus(prev => ({ ...prev, [courseId]: { ...prev[courseId], teacherVote: support ? "approved" : "rejected" } }));
      alert("Teacher vote recorded");
    } catch (err) {
      console.error(err);
      alert("Teacher vote failed: " + (err?.reason || err.message || err));
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
      alert("Enrollment confirmed and paid");
    } catch (err) {
      console.error(err);
      alert("Confirm enrollment failed: " + (err?.reason || err.message || err));
    }
  }

  // Complete course & distribute fees
  async function completeCourseAndDistribute(courseId, studentAddr) {
    if (!contract) return;
    try {
      const tx = await contract.completeCourseAndDistribute(courseId, studentAddr);
      await tx.wait();
      alert("Course completed and funds distributed");
    } catch (err) {
      console.error(err);
      alert("Complete failed: " + (err?.reason || err.message || err));
    }
  }

  // Ratings
  async function giveRating(courseId, teacherAddr, ratingValue) {
    if (!contract) return;
    try {
      const tx = await contract.giveRating(courseId, teacherAddr, ratingValue);
      await tx.wait();
      alert("Rating submitted");
    } catch (err) {
      console.error(err);
      alert("Rating failed: " + (err?.reason || err.message || err));
    }
  }

  // Bonus distribution by board
  async function distributeBonusByRating(courseId, amountTokens) {
  if (!contract || !TOKEN_ADDRESS) return;
    try {
      const amountWei = ethers.parseUnits(String(amountTokens), 18);
      const tx = await contract.distributeBonusByRating(courseId, amountWei);
      await tx.wait();
      alert("Bonus distributed");
    } catch (err) {
      console.error(err);
      alert("Bonus failed: " + (err?.reason || err.message || err));
    }
  }

  // Board payout from treasury
  async function boardPayout(to, amountTokens) {
    if (!contract) return;
    try {
      const amountWei = ethers.parseUnits(String(amountTokens), 18);
      const tx = await contract.boardPayout(to, amountWei);
      await tx.wait();
      alert("Payout executed");
    } catch (err) {
      console.error(err);
      alert("Payout failed: " + (err?.reason || err.message || err));
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

    contract.on("CourseCreated", onCourseCreated);
    contract.on("ProposalCreated", onProposalCreated);

    return () => {
      try {
        contract.off("CourseCreated", onCourseCreated);
        contract.off("ProposalCreated", onProposalCreated);
      } catch (e) {}
    };
  }, [contract, provider]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Hogeschool Utrecht DAO</h1>
      <div className="mb-4 p-4 border rounded bg-gray-50 flex flex-col md:flex-row justify-between items-center gap-2">
        <div>
          <span className="font-semibold">Treasury ETH Balance:</span>
          <span className="font-mono text-lg ml-2">{treasuryBalance !== null ? `${treasuryBalance} ETH` : "-"}</span>
        </div>
        <div>
          <span className="font-semibold">Treasury Token Balance:</span>
          <span className="font-mono text-lg ml-2">{treasuryTokenBalance !== null ? treasuryTokenBalance : "-"}</span>
        </div>
      </div>

      {!account ? (
        <div>
          <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={connectWallet}>
            Connect Wallet
          </button>
          <p className="mt-2 text-sm text-gray-600">Make sure MetaMask is installed.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 border rounded flex justify-between items-center">
            <div>
              <div className="text-sm text-gray-600">Connected address</div>
              <div className="font-mono">{account} ({role})</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Payment token</div>
              <div className="font-mono">{tokenAddress || TOKEN_ADDRESS || "-"}</div>
            </div>
          </div>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 border rounded">
              <h2 className="font-semibold mb-2">Members</h2>
              <div className="text-sm">Boards ({boards.length}): {boards.map(b=> <span key={b} className="mr-2">{short(b)}</span>)}</div>
              <div className="text-sm">Teachers ({teachers.length}): {teachers.map(t=> <span key={t} className="mr-2">{short(t)}</span>)}</div>
              <div className="text-sm">Students ({students.length}): {students.map(s=> <span key={s} className="mr-2">{short(s)}</span>)}</div>
            </div>

            <div className="p-4 border rounded">
              <h2 className="font-semibold mb-2">Create Admission Proposal</h2>
              <label className="block text-sm">Candidate address</label>
              <input className="w-full p-2 border rounded" value={newProposal.candidate} onChange={e=>setNewProposal({...newProposal, candidate: e.target.value})} />
              <label className="block text-sm mt-2">Role</label>
              <select className="w-full p-2 border rounded" value={newProposal.role} onChange={e=>setNewProposal({...newProposal, role: e.target.value})}>
                <option value="BOARD">BOARD</option>
                <option value="TEACHER">TEACHER</option>
                <option value="STUDENT">STUDENT</option>
              </select>
              <button className="mt-3 px-3 py-2 bg-green-600 text-white rounded" onClick={createProposal}>Create Proposal</button>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 border rounded">
              <h2 className="font-semibold mb-2">Active Proposals</h2>
              {proposals.length === 0 && <div className="text-sm text-gray-500">No proposals yet</div>}
              {proposals.map(p=> (
                <div key={p.id} className="p-2 border rounded mb-2">
                  <div className="text-sm">ID: {p.id} — Candidate: {short(p.candidate)}</div>
                  <div className="text-sm">Role: {String(p.role)}</div>
                  <div className="text-sm">Start: {p.start?.toString?.() || "-"}</div>
                  <div className="text-sm">End: {p.end?.toString?.() || "-"}</div>
                  <div className="mt-2 flex gap-2">
                    <button className="px-2 py-1 bg-blue-500 text-white rounded" onClick={()=>castVote(p.id, true)}>Vote For</button>
                    <button className="px-2 py-1 bg-red-500 text-white rounded" onClick={()=>castVote(p.id, false)}>Vote Against</button>
                    <button className="px-2 py-1 bg-gray-700 text-white rounded" onClick={()=>executeProposal(p.id)}>Execute</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 border rounded">
              <h2 className="font-semibold mb-2">Courses</h2>
              {role === "TEACHER" && (
                <div className="p-2 border rounded mb-3">
                  <h3 className="font-medium">Create Course</h3>
                  <input placeholder="Title" className="w-full p-2 border rounded mt-1" value={createCourseForm.title} onChange={e=>setCreateCourseForm({...createCourseForm, title: e.target.value})} />
                  <input placeholder="Price (tokens)" className="w-full p-2 border rounded mt-1" value={createCourseForm.price} onChange={e=>setCreateCourseForm({...createCourseForm, price: e.target.value})} />
                  <input placeholder="Teachers (comma-separated addresses)" className="w-full p-2 border rounded mt-1" value={createCourseForm.teachers} onChange={e=>setCreateCourseForm({...createCourseForm, teachers: e.target.value})} />
                  <input placeholder="Shares (comma-separated, sum=10000)" className="w-full p-2 border rounded mt-1" value={createCourseForm.shares} onChange={e=>setCreateCourseForm({...createCourseForm, shares: e.target.value})} />
                  <button className="mt-2 px-3 py-2 bg-indigo-600 text-white rounded" onClick={createCourse}>Create</button>
                </div>
              )}

              {courses.length === 0 && <div className="text-sm text-gray-500">No courses yet (check contract events)</div>}
              {courses.map(c => (
                <div key={c.id} className="p-2 border rounded mb-2">
                  <div className="font-medium">{c.title} (ID: {c.id})</div>
                  <div className="text-sm">Price: {ethers.formatUnits(c.price || "0", 18)} tokens</div>
                  <div className="text-sm">Teachers: {c.teachers.map(t=> short(t)).join(", ")}</div>
                  <div className="mt-2 flex gap-2">
                    {role === "STUDENT" && <button className="px-2 py-1 bg-green-600 text-white rounded" onClick={()=>applyToCourse(c.id)}>Apply</button>}
                    {(role === "TEACHER" || role === "BOARD") && <button className="px-2 py-1 bg-red-600 text-white rounded" onClick={()=>removeCourse(c.id)}>Remove</button>}
                    {role === "STUDENT" && <button className="px-2 py-1 bg-yellow-600 text-white rounded" onClick={()=>confirmEnrollment(c)}>Confirm & Pay</button>}
                    {/* Enrollment status display for students and teachers */}
                    {(role === "STUDENT" || role === "TEACHER") && enrollmentStatus[c.id] && (
                      <span className="ml-2 text-xs text-gray-700">Status: {enrollmentStatus[c.id].status || "applied"} {enrollmentStatus[c.id].teacherVote && ` (Teacher: ${enrollmentStatus[c.id].teacherVote})`}</span>
                    )}
                  </div>
                  {/* Teacher voting UI */}
                  {role === "TEACHER" && (
                    <div className="mt-2">
                      <input placeholder="Student address" id={`vote_student_${c.id}`} className="p-2 border rounded mr-2" />
                      <button className="px-2 py-1 bg-blue-600 text-white rounded mr-2" onClick={() => {
                        const studentAddr = document.getElementById(`vote_student_${c.id}`).value;
                        teacherVoteOnEnrollment(c.id, studentAddr, true);
                      }}>Vote For Enrollment</button>
                      <button className="px-2 py-1 bg-red-600 text-white rounded" onClick={() => {
                        const studentAddr = document.getElementById(`vote_student_${c.id}`).value;
                        teacherVoteOnEnrollment(c.id, studentAddr, false);
                      }}>Vote Against Enrollment</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="p-4 border rounded">
            <h2 className="font-semibold mb-2">Admin actions (Board)</h2>
            {role !== "BOARD" && <div className="text-sm text-gray-500">You must be a board member to use these actions.</div>}
            {role === "BOARD" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input placeholder="Recipient address" id="payoutTo" className="p-2 border rounded" />
                  <input placeholder="Amount tokens" id="payoutAmount" className="p-2 border rounded" />
                  <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={()=>{
                    const to = document.getElementById("payoutTo").value;
                    const amt = document.getElementById("payoutAmount").value;
                    boardPayout(to, amt);
                  }}>Payout</button>
                </div>

                <div className="flex gap-2">
                  <input placeholder="Course ID" id="bonusCourseId" className="p-2 border rounded" />
                  <input placeholder="Amount tokens" id="bonusAmount" className="p-2 border rounded" />
                  <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={()=>{
                    const cid = document.getElementById("bonusCourseId").value;
                    const amt = document.getElementById("bonusAmount").value;
                    distributeBonusByRating(Number(cid), amt);
                  }}>Distribute Bonus</button>
                </div>
              </div>
            )}
          </section>

          <section className="p-4 border rounded">
            <h2 className="font-semibold mb-2">Ratings & Completion</h2>
            <div className="text-sm mb-2">Students can rate the teachers after completing a course.</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {courses.map(c => (
                <div key={c.id} className="p-2 border rounded">
                  <div className="font-medium">{c.title} (ID: {c.id})</div>
                  <div className="text-sm">Teachers: {c.teachers.map(t=> <div key={t} className="flex items-center gap-2"><span className="font-mono">{short(t)}</span>
                    <select onChange={(e)=>giveRating(c.id, t, Number(e.target.value))} defaultValue="0">
                      <option value="0">Rate</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                  </div>)}</div>
                  <div className="mt-2">
                    <input placeholder="Complete for student address" id={`complete_${c.id}`} className="p-2 border rounded mr-2" />
                    <button className="px-2 py-1 bg-indigo-600 text-white rounded" onClick={()=>{
                      const studentAddr = document.getElementById(`complete_${c.id}`).value;
                      completeCourseAndDistribute(c.id, studentAddr);
                    }}>Complete & Distribute</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
