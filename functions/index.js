const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const ALLOWED_EMAIL = "jake.richardson@gmail.com";
const RETENTION_MS = 24 * 60 * 60 * 1000;

exports.gradeEssay = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  const auth = request.auth;
  if (!auth || auth.token.email !== ALLOWED_EMAIL || !auth.token.email_verified) {
    throw new HttpsError("permission-denied", "This tool is restricted to its owner.");
  }

  const { jobId, essayId, essayText, rubric, extra, model } = request.data || {};
  if (!jobId || !essayId || !essayText || !rubric || !model) {
    throw new HttpsError("invalid-argument", "Missing required fields.");
  }

  const systemPrompt = [
    "You are grading a student's essay strictly according to the rubric provided.",
    extra ? `Additional instructions: ${extra}` : null,
    "Respond with ONLY a single valid JSON object, no markdown fences, no extra text, in exactly this shape:",
    '{"grade": "<letter or numeric grade per the rubric>", "feedback": "<2-4 sentences of specific, constructive feedback>"}',
  ].filter(Boolean).join("\n");

  const userContent = `RUBRIC:\n${rubric}\n\nSTUDENT ESSAY:\n${essayText}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey.value(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new HttpsError("internal", errBody?.error?.message || `Anthropic API error (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = parseGradeJson(text);

  const expireAt = Timestamp.fromMillis(Date.now() + RETENTION_MS);
  await db.doc(`jobs/${jobId}/essays/${essayId}`).set({
    essayId,
    essayText,
    grade: parsed.grade,
    feedback: parsed.feedback,
    gradedAt: FieldValue.serverTimestamp(),
    expireAt,
  });

  return parsed;
});

function parseGradeJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    return { grade: String(obj.grade ?? ""), feedback: String(obj.feedback ?? "") };
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        return { grade: String(obj.grade ?? ""), feedback: String(obj.feedback ?? "") };
      } catch (e2) {
        // fall through to error below
      }
    }
    throw new HttpsError("internal", "Could not parse grading response as JSON: " + cleaned.slice(0, 120));
  }
}

// Runs hourly and deletes any stored essay/result documents past their
// 24h retention window, across every job.
exports.cleanupExpiredJobs = onSchedule("every 60 minutes", async () => {
  const now = Timestamp.now();
  const snap = await db.collectionGroup("essays").where("expireAt", "<=", now).get();
  if (snap.empty) return;

  const commits = [];
  let batch = db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count === 400) {
      commits.push(batch.commit());
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) commits.push(batch.commit());
  await Promise.all(commits);
});
