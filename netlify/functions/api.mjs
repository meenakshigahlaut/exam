// Scope Technologies - Online Exam Portal
// Backend: one Netlify Function + Netlify Blobs (built-in storage, no extra account needed).
// Set the ADMIN_PASSWORD environment variable in Netlify (Site configuration -> Environment variables).

import { getStore } from "@netlify/blobs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const config = { path: "/api" };

const db = () => getStore({ name: "exam-portal", consistency: "strong" });
const newId = () => randomUUID().replace(/-/g, "").slice(0, 10);
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const sha = (s) => createHash("sha256").update(String(s)).digest();
function isAdmin(req) {
  const given = req.headers.get("x-admin-password") || "";
  const real = process.env.ADMIN_PASSWORD || "admin123";
  return timingSafeEqual(sha(given), sha(real));
}

async function listAll(s, prefix) {
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

// ---------- grading ----------
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function isRight(q, given) {
  if (q.type === "mcq") return given !== "" && given != null && Number(given) === q.ans;
  const g = norm(given);
  if (!g) return false;
  return String(q.ans)
    .split("|")
    .some((alt) => {
      const c = norm(alt);
      if (!c) return false;
      if (c === g) return true;
      const n1 = Number(c), n2 = Number(g);
      return !isNaN(n1) && !isNaN(n2) && n1 === n2;
    });
}
const showAnswer = (q, a) =>
  q.type === "mcq" ? (a === "" || a == null ? "" : q.opts[Number(a)] ?? "") : String(a ?? "");
const correctText = (q) => (q.type === "mcq" ? q.opts[q.ans] : String(q.ans).split("|")[0]);

// ---------- validation ----------
function cleanExam(e, id) {
  const title = str(e.title, 150);
  if (!title) throw new Error("Exam name is required");
  const questions = (Array.isArray(e.questions) ? e.questions : []).slice(0, 500).map((q, i) => {
    const text = str(q.q, 1000);
    if (!text) throw new Error(`Question ${i + 1} is empty`);
    if (q.type === "mcq") {
      const opts = (Array.isArray(q.opts) ? q.opts : []).slice(0, 6).map((o) => str(o, 300));
      const ans = Number(q.ans);
      if (opts.filter(Boolean).length < 2) throw new Error(`Question ${i + 1}: at least 2 options needed`);
      if (!Number.isInteger(ans) || !opts[ans]) throw new Error(`Question ${i + 1}: choose the correct option`);
      return { type: "mcq", q: text, opts, ans };
    }
    const ans = str(q.ans, 500);
    if (!ans) throw new Error(`Question ${i + 1}: answer is required`);
    return { type: "text", q: text, ans };
  });
  if (!questions.length) throw new Error("Add at least one question");
  return {
    id,
    title,
    minutes: Math.min(Math.max(Number(e.minutes) || 10, 1), 600),
    show: e.show === true || e.show === 1 || e.show === "1",
    questions,
    updatedAt: Date.now(),
  };
}

// ---------- handler ----------
export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const s = db();

  try {
    switch (b.action) {
      // ===== public =====
      case "listExams": {
        const exams = await listAll(s, "exams/");
        exams.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
        return json({ exams: exams.map((e) => ({ id: e.id, title: e.title, minutes: e.minutes, count: e.questions.length })) });
      }
      case "getExam": {
        const e = await s.get("exams/" + str(b.id, 40), { type: "json" });
        if (!e) return json({ error: "Exam not found" }, 404);
        return json({
          exam: {
            id: e.id, title: e.title, minutes: e.minutes,
            questions: e.questions.map((q) => (q.type === "mcq" ? { type: "mcq", q: q.q, opts: q.opts } : { type: "text", q: q.q })),
          },
        });
      }
      case "getStudent": {
        const st = await s.get("students/" + str(b.id, 40), { type: "json" });
        if (!st) return json({ error: "This link is not valid" }, 404);
        const done = await s.get("results/" + st.id, { type: "json" });
        return json({ student: st, done: !!done });
      }
      case "submit": {
        const exam = await s.get("exams/" + str(b.examId, 40), { type: "json" });
        if (!exam) return json({ error: "Exam not found" }, 404);
        let who = { name: str(b.name, 100), roll: str(b.roll, 50), cls: str(b.cls, 100), contact: str(b.contact, 100) };
        let rid = newId();
        if (b.studentId) {
          const st = await s.get("students/" + str(b.studentId, 40), { type: "json" });
          if (!st || st.examId !== exam.id) return json({ error: "This link is not valid" }, 400);
          if (await s.get("results/" + st.id, { type: "json" }))
            return json({ ok: false, code: "DONE", error: "This exam was already submitted." });
          who = { name: st.name, roll: st.roll, cls: st.cls, contact: st.contact };
          rid = st.id;
        }
        if (!who.name || !who.roll) return json({ error: "Name and Roll Number are required" }, 400);

        const answers = Array.isArray(b.answers) ? b.answers : [];
        let score = 0;
        const details = exam.questions.map((q, i) => {
          const a = answers[i] ?? "";
          const ok = isRight(q, a);
          if (ok) score++;
          return { q: q.q, given: showAnswer(q, a), correct: correctText(q), ok };
        });
        const total = exam.questions.length;
        await s.setJSON("results/" + rid, {
          id: rid, examId: exam.id, examTitle: exam.title, studentId: b.studentId || "",
          ...who, score, total, reason: str(b.reason, 100) || "Submitted by student",
          submittedAt: Date.now(), details,
        });
        return json({ ok: true, show: exam.show, score, total });
      }

      // ===== admin =====
      default: {
        if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
        switch (b.action) {
          case "login":
            return json({ ok: true });
          case "adminExams": {
            const exams = await listAll(s, "exams/");
            exams.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
            return json({ exams });
          }
          case "saveExam": {
            const id = str(b.exam?.id, 40) || newId();
            const exam = cleanExam(b.exam || {}, id);
            await s.setJSON("exams/" + id, exam);
            return json({ ok: true, exam });
          }
          case "deleteExam":
            await s.delete("exams/" + str(b.id, 40));
            return json({ ok: true });
          case "listStudents": {
            const students = await listAll(s, "students/");
            students.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
            return json({ students });
          }
          case "saveStudent": {
            const exam = await s.get("exams/" + str(b.examId, 40), { type: "json" });
            if (!exam) return json({ error: "Select a valid exam" }, 400);
            const st = {
              id: newId(), examId: exam.id, examTitle: exam.title,
              name: str(b.name, 100), roll: str(b.roll, 50), cls: str(b.cls, 100), contact: str(b.contact, 100),
              createdAt: Date.now(),
            };
            if (!st.name || !st.roll) return json({ error: "Name and Roll Number are required" }, 400);
            await s.setJSON("students/" + st.id, st);
            return json({ ok: true, student: st });
          }
          case "deleteStudent":
            await s.delete("students/" + str(b.id, 40));
            return json({ ok: true });
          case "listResults": {
            const results = await listAll(s, "results/");
            results.sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0));
            return json({ results });
          }
          case "deleteResult":
            await s.delete("results/" + str(b.id, 40));
            return json({ ok: true });
          default:
            return json({ error: "Unknown action" }, 400);
        }
      }
    }
  } catch (err) {
    return json({ error: err.message || "Server error" }, 400);
  }
};
