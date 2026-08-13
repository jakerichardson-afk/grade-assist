# Grade Assist

A single-page app for batch-grading de-identified student essays with Claude. Access is restricted to one Google account, and grading runs through a Cloud Function so the Anthropic API key never leaves the server. Pairs with a local de-identification tool — Claude only ever sees random IDs, never names.

## Architecture

- **Frontend**: `index.html`, one static file, no build step. Hosted on Firebase Hosting.
- **Auth**: Firebase Authentication, Google provider only. The page checks the signed-in email client-side for UX, but the real gate is server-side (see below).
- **Grading**: a Cloud Function (`gradeEssay`, `functions/index.js`) that:
  - Rejects any caller whose Firebase Auth token isn't the one allowed email (hardcoded in the function, not just checked in the browser).
  - Calls `api.anthropic.com` using an API key held as a Cloud Functions secret — the key is never sent to or stored in the browser.
  - Writes the essay text and result to Firestore under `jobs/{jobId}/essays/{essayId}` with a 24-hour expiry timestamp.
- **Data retention**: a scheduled Cloud Function (`cleanupExpiredJobs`) runs hourly and permanently deletes any stored essay/result documents past their 24-hour mark. Firestore security rules block all direct client reads/writes — the only way data goes in or comes out is through the two Cloud Functions above.

## One-time setup (manual — can't be scripted)

1. **Enable Google sign-in**: Firebase console → this project → Authentication → Sign-in method → enable **Google**.
2. **Enable Blaze (pay-as-you-go) billing**: Firebase console → this project → Upgrade plan → Blaze. Required for Cloud Functions to make outbound network calls (to Anthropic). Free-tier quotas (2M function invocations/month) mean this should cost $0 for personal use, but it does require a billing account attached.
3. **Set the Anthropic API key secret**:
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
   (paste your key when prompted — this goes straight into Google Secret Manager, never into a file in this repo).

## Deploying

```bash
firebase deploy
```

Deploys Hosting, Firestore rules/indexes, and both Cloud Functions together. Run `firebase deploy --only hosting` for frontend-only changes.

## Local project layout

- `index.html` — the app.
- `functions/index.js` — `gradeEssay` (callable) and `cleanupExpiredJobs` (scheduled, hourly).
- `firestore.rules` — denies all direct client access; only the Admin SDK (i.e. the Cloud Functions) can read/write.
- `firestore.indexes.json` — collection-group index needed for the cleanup function's query.
- `firebase.json` / `.firebaserc` — Firebase project config, pointed at `grade-assist-jr`.

## Workflow

This app is step 2 of a 3-step pipeline:

1. **De-identify locally** — a separate desktop tool (not included here) turns a folder of student essays into a CSV of `id, essay_text`, plus a private mapping file (`id → student name`) that never leaves your computer.
2. **Grade here** — upload that CSV plus your rubric. Claude grades each row by ID and returns `id, grade, feedback`. Download the results CSV.
3. **Re-identify locally** — merge the graded CSV back with your private mapping file to get final results with real student names.

Claude, in this app, only ever sees an ID and essay text — never a name.

## How it works

- The page uploads a CSV of `id, essay_text` rows and a rubric, then calls the `gradeEssay` Cloud Function once per row (limited to 3 concurrent calls, with retries on transient errors).
- The function asks Claude to return strict JSON (`{"grade": ..., "feedback": ...}`) per essay, which the app parses and displays in a results table.
- When all rows are done, **Download results CSV** gives you `id, grade, feedback` — ready to feed into the re-identification step.

## Privacy notes

- Essay text and results are held server-side only as long as needed to produce a grading response, then persist for at most 24 hours before the hourly cleanup function deletes them permanently.
- Under Anthropic's commercial API terms, inputs are not used for model training, and are deleted from Anthropic's own backend within 30 days by default (unless you have a separate zero-data-retention agreement).
- This is a different data path than Claude for Teachers. The K-12-specific FERPA-aligned Data Processing Addendum applies to the Claude for Teachers product, not to raw API usage. If your district has policies specifically about Claude for Teachers, confirm whether they also cover this API-based workflow before using it with real (even de-identified) student data — or check with your district about API-specific data agreements.
- Because essays here carry only random IDs (from the de-identification step), no student names or other direct identifiers are ever transmitted through this app.

## Customizing

- **Model**: change the dropdown options in `index.html` (`<select id="model">`) if Anthropic's available models change.
- **Allowed account**: `ALLOWED_EMAIL` in both `index.html` and `functions/index.js` (the server-side one in `functions/index.js` is the one that actually matters).
- **Retention window**: `RETENTION_MS` in `functions/index.js`.
- **Concurrency / retries**: `CONCURRENCY` and `MAX_RETRIES` constants near the top of the `<script>` block in `index.html`.
- **Grading prompt**: edit the `systemPrompt` construction inside `gradeEssay` in `functions/index.js` to change tone, format, or add few-shot examples.
