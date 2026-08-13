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
    "First, in rubric_reasoning, go through the rubric criterion by criterion. For each one, quote or paraphrase the specific part of the essay that addresses it (or note that it's missing), and say whether that criterion is met, partially met, or not met. Base the grade only on what's actually in the essay, not on assumptions about what the student probably meant.",
    "Then score the essay from 0 to 100 in grade, consistent with that reasoning:",
    "- 90-100: the essay meets grade-level requirements -- it fully and clearly satisfies the rubric.",
    "- 70-80: the essay generally meets the requirements but has gaps, thin development, or inconsistent execution.",
    "- Below 70: the essay falls short of the requirements in significant ways.",
    "- Use your judgment for scores between these bands (e.g. 81-89) based on how well the essay satisfies the rubric.",
  ].filter(Boolean).join("\n");

  const userContent = `RUBRIC:\n${rubric}\n\nSTUDENT ESSAY:\n${essayText}`;

  const GRADE_TOOL = {
    name: "submit_grade",
    description: "Submit the grade and feedback for this essay.",
    input_schema: {
      type: "object",
      properties: {
        rubric_reasoning: {
          type: "string",
          description: "Criterion-by-criterion walkthrough of how the essay does or doesn't satisfy the rubric, citing the essay's actual content. This is shown to the teacher to audit the grade, so be specific and concrete.",
        },
        grade: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "A single percentage score from 0 to 100. Just the integer -- no letter grade, no percent sign.",
        },
        feedback: {
          type: "string",
          description: "2-4 sentences of specific, constructive feedback for the student.",
        },
      },
      required: ["rubric_reasoning", "grade", "feedback"],
    },
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey.value(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      tools: [GRADE_TOOL],
      tool_choice: { type: "tool", name: "submit_grade" },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new HttpsError("internal", errBody?.error?.message || `Anthropic API error (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "submit_grade");
  if (!toolUse || typeof toolUse.input?.grade !== "number") {
    throw new HttpsError("internal", "Claude did not return a valid grade for this essay.");
  }
  const parsed = {
    grade: Math.max(0, Math.min(100, Math.round(toolUse.input.grade))),
    feedback: String(toolUse.input.feedback ?? "").trim(),
    reasoning: String(toolUse.input.rubric_reasoning ?? "").trim(),
  };

  const expireAt = Timestamp.fromMillis(Date.now() + RETENTION_MS);
  await db.doc(`jobs/${jobId}/essays/${essayId}`).set({
    essayId,
    essayText,
    grade: parsed.grade,
    feedback: parsed.feedback,
    reasoning: parsed.reasoning,
    gradedAt: FieldValue.serverTimestamp(),
    expireAt,
  });

  return parsed;
});

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
