/* Scope Technologies - Online Exam Portal
   All data lives on the server (Netlify Function + Blobs), so a student can take the exam on any
   device and the result shows up in Admin -> Results automatically.
   The admin password is NOT in this file: set ADMIN_PASSWORD in Netlify environment variables. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let admin = false, pw = "";
try { pw = sessionStorage.getItem("adm") || ""; admin = !!pw; } catch (e) {}

/* ---------- API ---------- */
async function API(action, data = {}, useAdmin = false, pwOverride) {
  const headers = { "Content-Type": "application/json" };
  if (useAdmin) headers["x-admin-password"] = pwOverride ?? pw;
  let r, j = {};
  try {
    r = await fetch("/api", { method: "POST", headers, body: JSON.stringify({ action, ...data }) });
  } catch (e) { throw new Error("No internet connection"); }
  try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && useAdmin && pwOverride === undefined) { logout(); throw new Error("Please login again"); }
  if (!r.ok) throw new Error(j.error || "Server error (" + r.status + ")");
  return j;
}

let toastH;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastH); toastH = setTimeout(() => t.classList.add("hide"), 3500);
}

/* ---------- views ---------- */
const VIEWS = ["home", "details", "exam", "thanks", "login", "admin"];
let curTab = 1;
function go(v) {
  VIEWS.forEach((x) => $("v-" + x).classList.toggle("hide", x !== v));
  $("navAdmin").classList.toggle("hide", ["details", "exam", "thanks"].includes(v));
  if (v !== "admin") stopPoll();
  if (v === "home") loadHome();
  if (v === "admin") tab(curTab);
  window.scrollTo(0, 0);
}

/* =====================  STUDENT  ===================== */
let cur = null, stu = null, running = false, endAt = 0, startedAt = 0, timerH, payload = null;

async function loadHome() {
  const box = $("examList");
  box.innerHTML = '<p class="muted">Loading exams…</p>';
  try {
    const { exams } = await API("listExams");
    box.innerHTML = exams.length
      ? exams.map((e) => `<div class="ex"><h3>${esc(e.title)}</h3><div class="muted">⏱ ${e.minutes} min · ${e.count} questions</div><button onclick="openDetails('${e.id}')">Start →</button></div>`).join("")
      : '<p class="muted">No exams available right now.</p>';
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function openDetails(examId, student) {
  try {
    const { exam } = await API("getExam", { id: examId });
    cur = exam; stu = student || null;
    $("dTitle").textContent = exam.title;
    $("dMeta").textContent = `⏱ ${exam.minutes} minutes · ${exam.questions.length} questions`;
    $("sName").value = stu ? stu.name : ""; $("sRoll").value = stu ? stu.roll : "";
    $("sCls").value = stu ? stu.cls : ""; $("sContact").value = stu ? stu.contact : "";
    ["sName", "sRoll", "sCls", "sContact"].forEach((id) => ($(id).readOnly = !!stu));
    $("bBack").classList.toggle("hide", LOCKED);
    go("details");
  } catch (e) { toast(e.message, true); }
}

function startExam() {
  if (!cur) return;
  if (!$("sName").value.trim() || !$("sRoll").value.trim()) return toast("Name and Roll Number are required", true);
  $("eTitle").textContent = cur.title;
  $("qs").innerHTML = cur.questions.map((q, i) => `
    <div class="card q"><h4>Q${i + 1}. ${esc(q.q)}</h4>
    ${q.type === "mcq"
      ? q.opts.map((o, k) => (o ? `<label class="opt"><input type="radio" name="q${i}" value="${k}"> <span><b>${"ABCDEF"[k]}.</b> ${esc(o)}</span></label>` : "")).join("")
      : `<input type="text" id="ta${i}" placeholder="Type your answer" autocomplete="off">`}
    </div>`).join("");
  running = true; startedAt = Date.now();
  endAt = startedAt + cur.minutes * 60000;
  go("exam");
  tick(); timerH = setInterval(tick, 500);
  window.addEventListener("beforeunload", warnUnload);
}

function tick() {
  const left = Math.max(0, endAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  const t = $("timer");
  t.textContent = `⏱ ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  t.classList.toggle("low", left < 60000);
  if (left <= 0) finish("Time up");
}

const warnUnload = (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } };
function leftWindow() {
  if (running && Date.now() - startedAt > 1500) finish("Left the exam window / switched tab");
}
document.addEventListener("visibilitychange", () => { if (document.hidden) leftWindow(); });
window.addEventListener("blur", leftWindow);

function collectAnswers() {
  return cur.questions.map((q, i) => {
    if (q.type === "mcq") { const c = document.querySelector(`input[name="q${i}"]:checked`); return c ? c.value : ""; }
    return ($("ta" + i)?.value || "").trim();
  });
}

async function finish(reason) {
  if (!running) return;
  running = false; clearInterval(timerH);
  window.removeEventListener("beforeunload", warnUnload);
  payload = {
    examId: cur.id, studentId: stu ? stu.id : "", reason,
    name: $("sName").value.trim(), roll: $("sRoll").value.trim(), cls: $("sCls").value.trim(), contact: $("sContact").value.trim(),
    answers: collectAnswers(),
  };
  go("thanks");
  $("thanksBox").innerHTML = "<h2>Submitting your answers…</h2><p class='muted'>Please do not close this page.</p>";
  await send(0);
}

async function send(attempt) {
  try {
    showThanks(await API("submit", payload));
  } catch (e) {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return send(attempt + 1); }
    $("thanksBox").innerHTML = `<h2>⚠️ Could not submit</h2><p class="err">${esc(e.message)}</p><p class="muted">Your answers are saved on this page. Check your internet and press Retry. Do not close this page.</p><button onclick="send(0)">🔄 Retry</button>`;
  }
}

function showThanks(r) {
  const box = $("thanksBox");
  if (r.ok === false && r.code === "DONE") {
    box.innerHTML = "<h2>✅ Already submitted</h2><p>You have already completed this exam.</p>"; return;
  }
  const note = payload && payload.reason !== "Submitted by student" ? `<p class="warn">Exam ended: ${esc(payload.reason)}</p>` : "";
  box.innerHTML = r.show
    ? `<h2>🎉 Thank you, ${esc(payload.name)}!</h2>${note}<p>Your score</p><div class="score">${r.score} / ${r.total}</div><p class="muted">${Math.round((r.score / r.total) * 100)}%</p>`
    : `<h2>🎉 Thank you, ${esc(payload.name)}!</h2>${note}<p>Your exam has been submitted successfully.</p>`;
}

/* =====================  ADMIN  ===================== */
async function login() {
  const p = $("pw").value;
  $("loginErr").textContent = "";
  try {
    await API("login", {}, true, p);
    pw = p; admin = true;
    try { sessionStorage.setItem("adm", pw); } catch (e) {}
    $("pw").value = "";
    go("admin");
  } catch (e) { $("loginErr").textContent = e.message === "Unauthorized" ? "Wrong password" : e.message; }
}
function logout() {
  admin = false; pw = ""; stopPoll();
  try { sessionStorage.removeItem("adm"); } catch (e) {}
  go("login");
}

function tab(n) {
  curTab = n;
  [1, 2, 3, 4].forEach((i) => { $("a" + i).classList.toggle("hide", i !== n); $("t" + i).classList.toggle("on", i === n); });
  if (n !== 3) stopPoll();
  if (n === 2) loadExams();
  if (n === 3) { loadResults(); startPoll(); }
  if (n === 4) loadStudents();
}

/* ----- exam builder ----- */
let Q = [], editId = null, EX = [];
const blankQ = () => ({ type: "mcq", q: "", opts: ["", "", "", ""], ans: 0 });

function renderBuilder() {
  $("builder").innerHTML = Q.map((q, i) => `
    <div class="card qb">
      <div class="qh"><b>Question ${i + 1}</b>
        <span><select onchange="setType(${i},this.value)">
          <option value="mcq" ${q.type === "mcq" ? "selected" : ""}>Multiple choice</option>
          <option value="text" ${q.type === "text" ? "selected" : ""}>Typed answer</option></select>
        <button class="del sm" onclick="delQ(${i})">✕</button></span></div>
      <label>Question *</label><textarea oninput="Q[${i}].q=this.value">${esc(q.q)}</textarea>
      ${q.type === "mcq"
        ? `<label>Options (select the correct one)</label>` + [0, 1, 2, 3].map((k) => `
            <div class="optrow"><input type="radio" name="c${i}" ${Number(q.ans) === k ? "checked" : ""} onchange="Q[${i}].ans=${k}">
            <b>${"ABCD"[k]}</b><input type="text" value="${esc(q.opts[k] || "")}" oninput="Q[${i}].opts[${k}]=this.value"></div>`).join("")
        : `<label>Correct answer *</label><input type="text" value="${esc(q.ans)}" oninput="Q[${i}].ans=this.value">
           <p class="muted">Accepts any letter case. More than one correct answer? Separate with | (e.g. Delhi | New Delhi)</p>`}
    </div>`).join("");
}
function addQ() { Q.push(blankQ()); renderBuilder(); }
function delQ(i) { Q.splice(i, 1); if (!Q.length) Q.push(blankQ()); renderBuilder(); }
function setType(i, t) {
  Q[i] = t === "mcq" ? { type: "mcq", q: Q[i].q, opts: ["", "", "", ""], ans: 0 } : { type: "text", q: Q[i].q, ans: "" };
  renderBuilder();
}
function resetForm() {
  Q = [blankQ()]; editId = null;
  $("xTitle").value = ""; $("xMin").value = 10; $("xShow").value = "1";
  $("formTitle").textContent = "New Exam"; $("saveBtn").textContent = "💾 Save Exam";
  $("cancelEdit").classList.add("hide");
  renderBuilder();
}

async function saveExam() {
  const questions = Q.map((q) => {
    if (q.type !== "mcq") return { type: "text", q: q.q, ans: q.ans };
    const opts = [], keep = [];
    q.opts.forEach((o, k) => { if (o.trim()) { keep.push(k); opts.push(o.trim()); } });
    return { type: "mcq", q: q.q, opts, ans: keep.indexOf(Number(q.ans)) };
  });
  const btn = $("saveBtn"); btn.disabled = true;
  try {
    await API("saveExam", { exam: { id: editId, title: $("xTitle").value, minutes: $("xMin").value, show: $("xShow").value === "1", questions } }, true);
    toast("Exam saved ✓");
    resetForm(); tab(2);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

async function loadExams() {
  const box = $("a2");
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    EX = (await API("adminExams", {}, true)).exams;
    box.innerHTML = EX.length
      ? EX.map((e) => `<div class="card"><h3 style="margin:0">${esc(e.title)}</h3>
          <p class="muted">⏱ ${e.minutes} min · ${e.questions.length} questions · ${e.show ? "score shown" : "score hidden"}</p>
          <button class="sm" onclick="editExam('${e.id}')">✏️ Edit</button>
          <button class="grey sm" onclick="copyText(location.origin+location.pathname+'?e=${e.id}')">🔗 Copy exam link</button>
          <button class="del sm" onclick="delExam('${e.id}')">🗑 Delete</button></div>`).join("")
      : '<p class="muted">No exams yet. Create one from “New Exam”.</p>';
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function editExam(id) {
  const e = EX.find((x) => x.id === id); if (!e) return;
  editId = id;
  $("xTitle").value = e.title; $("xMin").value = e.minutes; $("xShow").value = e.show ? "1" : "0";
  Q = e.questions.map((q) => q.type === "mcq"
    ? { type: "mcq", q: q.q, opts: [0, 1, 2, 3].map((k) => q.opts[k] || ""), ans: q.ans }
    : { type: "text", q: q.q, ans: q.ans });
  $("formTitle").textContent = "Edit Exam"; $("saveBtn").textContent = "💾 Update Exam";
  $("cancelEdit").classList.remove("hide");
  renderBuilder(); tab(1);
}
async function delExam(id) {
  if (!confirm("Delete this exam?")) return;
  try { await API("deleteExam", { id }, true); toast("Deleted"); loadExams(); } catch (e) { toast(e.message, true); }
}

/* ----- Excel / CSV import ----- */
function importExcel(inp) {
  const f = inp.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = (ev) => {
    try {
      if (typeof XLSX === "undefined") throw new Error("Excel reader not loaded (check internet)");
      const wb = XLSX.read(ev.target.result, { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", blankrows: false });
      const { qs, skipped } = parseRows(rows);
      if (!qs.length) throw new Error("No questions found in the file");
      const onlyBlank = Q.length === 1 && !Q[0].q.trim();
      Q = onlyBlank ? qs : Q.concat(qs);
      if (!$("xTitle").value.trim()) $("xTitle").value = f.name.replace(/\.[^.]+$/, "");
      renderBuilder();
      toast(`Imported ${qs.length} questions` + (skipped ? ` (${skipped} skipped - check the answer column)` : ""));
    } catch (err) { toast("Could not import: " + err.message, true); }
    inp.value = "";
  };
  rd.readAsArrayBuffer(f);
}
function parseRows(rows) {
  if (!rows.length) return { qs: [], skipped: 0 };
  const key = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const head = rows[0].map(key);
  const hasHead = head.some((h) => h.includes("question") || h === "q" || h.includes("answer") || h === "ans");
  let qi = 0, ai = -1, oi = [-1, -1, -1, -1], start = 0;
  if (hasHead) {
    start = 1;
    qi = head.findIndex((h) => h.includes("question") || h === "q"); if (qi < 0) qi = 0;
    "abcd".split("").forEach((L, k) => {
      oi[k] = head.findIndex((h) => [L, "option" + L, "opt" + L, "choice" + L, "option" + (k + 1), "opt" + (k + 1), "choice" + (k + 1)].includes(h));
    });
    ai = head.findIndex((h) => h.includes("correct"));
    if (ai < 0) ai = head.findIndex((h) => h.includes("answer") || h === "ans" || h === "key");
  } else if (rows[0].length >= 6) { oi = [1, 2, 3, 4]; ai = 5; } else { ai = 1; }
  const isMcq = oi.every((i) => i >= 0);
  const qs = []; let skipped = 0;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r], q = String(row[qi] ?? "").trim(), raw = String(row[ai] ?? "").trim();
    if (!q) continue;
    if (isMcq) {
      const opts = oi.map((i) => String(row[i] ?? "").trim());
      let ans = -1;
      if (/^[a-d]$/i.test(raw)) ans = raw.toUpperCase().charCodeAt(0) - 65;
      else if (/^[1-4]$/.test(raw)) ans = Number(raw) - 1;
      else ans = opts.findIndex((o) => o && o.toLowerCase() === raw.toLowerCase());
      if (ans < 0 || !opts[ans]) { skipped++; continue; }
      qs.push({ type: "mcq", q, opts, ans });
    } else {
      if (!raw) { skipped++; continue; }
      qs.push({ type: "text", q, ans: raw });
    }
  }
  return { qs, skipped };
}

/* ----- results (auto-updating) ----- */
let RS = [], pollH = null, openDet = new Set(), lastUpd = null;
function startPoll() { stopPoll(); pollH = setInterval(() => { if (!document.hidden) loadResults(true); }, 8000); }
function stopPoll() { if (pollH) { clearInterval(pollH); pollH = null; } }

async function loadResults(silent) {
  try {
    RS = (await API("listResults", {}, true)).results;
    lastUpd = new Date();
    renderResults();
  } catch (e) { if (!silent) toast(e.message, true); }
}
function renderResults() {
  const sel = $("rFilter"), prev = sel.value;
  const exams = [...new Map(RS.map((r) => [r.examId, r.examTitle])).entries()];
  sel.innerHTML = '<option value="">All exams</option>' + exams.map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join("");
  sel.value = exams.some(([id]) => id === prev) ? prev : "";
  const list = filteredResults();
  $("rLive").textContent = `🟢 Live — updates automatically · ${list.length} result(s) · last updated ${lastUpd ? lastUpd.toLocaleTimeString() : ""}`;
  $("rList").innerHTML = list.length
    ? `<div class="tw"><table><tr><th>Student</th><th>Exam</th><th>Score</th><th>Submitted</th><th></th></tr>` +
      list.map((r) => {
        const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
        const odd = r.reason && r.reason !== "Submitted by student";
        return `<tr><td><b>${esc(r.name)}</b><br><span class="muted">Roll ${esc(r.roll)}${r.cls ? " · " + esc(r.cls) : ""}${r.contact ? "<br>" + esc(r.contact) : ""}</span></td>
          <td>${esc(r.examTitle)}</td>
          <td><span class="pill ${pct >= 40 ? "ok" : "no"}">${r.score}/${r.total} · ${pct}%</span>${odd ? `<br><span class="pill wait">${esc(r.reason)}</span>` : ""}</td>
          <td class="muted">${new Date(r.submittedAt).toLocaleString()}</td>
          <td><button class="grey sm" onclick="toggleDet('${r.id}')">View</button> <button class="del sm" onclick="delResult('${r.id}')">🗑</button></td></tr>
          <tr class="${openDet.has(r.id) ? "" : "hide"}" id="det-${r.id}"><td colspan="5" class="det">${(r.details || []).map((d, i) =>
            `<div>${d.ok ? "✅" : "❌"} <b>Q${i + 1}.</b> ${esc(d.q)}<br><span class="muted">Answer given: ${esc(d.given) || "<i>blank</i>"}${d.ok ? "" : " · Correct: " + esc(d.correct)}</span></div>`).join("")}</td></tr>`;
      }).join("") + "</table></div>"
    : '<p class="muted">No results yet.</p>';
}
const filteredResults = () => RS.filter((r) => !$("rFilter").value || r.examId === $("rFilter").value);
function toggleDet(id) {
  openDet.has(id) ? openDet.delete(id) : openDet.add(id);
  $("det-" + id).classList.toggle("hide");
}
async function delResult(id) {
  if (!confirm("Delete this result? (the student will be able to attempt again if they have a personal link)")) return;
  try { await API("deleteResult", { id }, true); loadResults(); } catch (e) { toast(e.message, true); }
}
function exportCsv() {
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const rows = [["Name", "Roll", "Class", "Contact", "Exam", "Score", "Total", "Percent", "Status", "Submitted"]]
    .concat(filteredResults().map((r) => [r.name, r.roll, r.cls, r.contact, r.examTitle, r.score, r.total, r.total ? Math.round((r.score / r.total) * 100) + "%" : "", r.reason, new Date(r.submittedAt).toLocaleString()]));
  const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "results.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ----- students & links ----- */
let ST = [];
const linkFor = (s) => location.origin + location.pathname + "?s=" + s.id;

async function loadStudents() {
  try {
    const [exams, st, rs] = await Promise.all([API("adminExams", {}, true), API("listStudents", {}, true), API("listResults", {}, true)]);
    EX = exams.exams; ST = st.students; RS = rs.results;
    const keep = $("stExam").value;
    $("stExam").innerHTML = EX.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join("") || '<option value="">Create an exam first</option>';
    if (EX.some((e) => e.id === keep)) $("stExam").value = keep;
    $("stList").innerHTML = ST.length
      ? `<div class="tw"><table><tr><th>Student</th><th>Exam</th><th>Status</th><th>Link</th></tr>` + ST.map((s) => {
          const r = RS.find((x) => x.id === s.id);
          return `<tr><td><b>${esc(s.name)}</b><br><span class="muted">Roll ${esc(s.roll)}${s.cls ? " · " + esc(s.cls) : ""}${s.contact ? "<br>" + esc(s.contact) : ""}</span></td>
            <td>${esc(s.examTitle)}</td>
            <td>${r ? `<span class="pill ok">Done ${r.score}/${r.total}</span>` : '<span class="pill wait">Pending</span>'}</td>
            <td><button class="sm" onclick="copyLink('${s.id}')">Copy Link</button> <button class="acc sm" onclick="waLink('${s.id}')">WhatsApp</button> <button class="del sm" onclick="delStudent('${s.id}')">🗑</button></td></tr>`;
        }).join("") + "</table></div>"
      : '<p class="muted">No students added yet.</p>';
  } catch (e) { toast(e.message, true); }
}
async function addStudent() {
  try {
    await API("saveStudent", { examId: $("stExam").value, name: $("stName").value, roll: $("stRoll").value, cls: $("stCls").value, contact: $("stContact").value }, true);
    ["stName", "stRoll", "stCls", "stContact"].forEach((id) => ($(id).value = ""));
    toast("Student added ✓"); loadStudents();
  } catch (e) { toast(e.message, true); }
}
async function delStudent(id) {
  if (!confirm("Remove this student and their link?")) return;
  try { await API("deleteStudent", { id }, true); loadStudents(); } catch (e) { toast(e.message, true); }
}
function copyLink(id) { copyText(linkFor(ST.find((s) => s.id === id))); }
function waLink(id) {
  const s = ST.find((x) => x.id === id);
  const msg = `Hello ${s.name}, your exam "${s.examTitle}" is ready. Open this link to start (you can use any phone or computer):\n${linkFor(s)}`;
  let num = /@/.test(s.contact) ? "" : s.contact.replace(/\D/g, "");
  if (num.length === 10) num = "91" + num;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, "_blank");
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast("Link copied ✓"); }
  catch (e) { prompt("Copy this link:", t); }
}

/* =====================  START  ===================== */
const params = new URLSearchParams(location.search);
const LOCKED = !!(params.get("s") || params.get("e")); // student / exam links never show the Admin button

(async function init() {
  resetForm();
  if (LOCKED) $("topNav").classList.add("hide");
  if (params.get("s")) {
    go("details"); $("bStart").disabled = true;
    try {
      const { student, done } = await API("getStudent", { id: params.get("s") });
      if (done) { go("thanks"); $("thanksBox").innerHTML = "<h2>✅ Already submitted</h2><p>You have already completed this exam.</p>"; return; }
      await openDetails(student.examId, student);
    } catch (e) { go("thanks"); $("thanksBox").innerHTML = `<h2>⚠️ ${esc(e.message)}</h2><p class="muted">Please ask your teacher for a new link.</p>`; }
    $("bStart").disabled = false;
  } else if (params.get("e")) {
    openDetails(params.get("e"));
  } else go("home");
})();
