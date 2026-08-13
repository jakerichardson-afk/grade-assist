# Grade Assist

A single-page browser app for batch-grading de-identified student essays with Claude, using your own Anthropic API key. Pairs with a local de-identification tool — Claude only ever sees random IDs, never names.

No build step, no server, no dependencies to install. It's one HTML file.

## Running it

**Option A — just open it locally.** Double-click `index.html`. It opens in your browser and works fully offline except for the actual grading calls to Anthropic.

**Option B — host it on GitHub Pages.**

1. Push this repo (or this file) to GitHub.
2. Repo Settings → Pages → set source to your main branch.
3. Visit the URL GitHub gives you.

Either way, nothing is stored on a server — it's a static page that calls `api.anthropic.com` directly from your browser.

## Workflow

This app is step 2 of a 3-step pipeline:

1. **De-identify locally** — a separate desktop tool (not included here) turns a folder of student essays into a CSV of `id, essay_text`, plus a private mapping file (`id → student name`) that never leaves your computer.
2. **Grade here** — upload that CSV plus your rubric. Claude grades each row by ID and returns `id, grade, feedback`. Download the results CSV.
3. **Re-identify locally** — merge the graded CSV back with your private mapping file to get final results with real student names.

Claude, in this app, only ever sees an ID and essay text — never a name.

## Getting an API key

Go to [console.anthropic.com](https://console.anthropic.com/), create an account (separate from any Claude.ai / Claude for Teachers account — this uses the Anthropic API, which is billed separately, per token), and generate a key under API Keys.

Paste that key into the app. You can optionally check "Remember this key in this browser" to save it in `localStorage` so you don't have to re-paste it each time — only do this on a personal, non-shared computer, since anyone with access to that browser profile could read it back out.

## How it works

- The app sends each essay + your rubric to `https://api.anthropic.com/v1/messages` directly from your browser, using the `anthropic-dangerous-direct-browser-access` header (Anthropic's supported "bring your own key" pattern for client-side tools).
- Requests run with limited concurrency (3 at a time) and retry automatically on rate-limit or server errors.
- Claude is asked to return strict JSON (`{"grade": ..., "feedback": ...}`) per essay, which the app parses and displays in a results table.
- When all rows are done, **Download results CSV** gives you `id, grade, feedback` — ready to feed into the re-identification step.

## Privacy notes

- Your API key and essay text go only to Anthropic's API, using your own credentials. Nothing passes through any third-party server.
- Under Anthropic's commercial API terms, inputs are not used for model training, and are deleted from Anthropic's backend within 30 days by default (unless you have a separate zero-data-retention agreement).
- This is a different data path than Claude for Teachers. The K-12-specific FERPA-aligned Data Processing Addendum applies to the Claude for Teachers product, not to raw API usage. If your district has policies specifically about Claude for Teachers, confirm whether they also cover this API-based workflow before using it with real (even de-identified) student data — or check with your district about API-specific data agreements.
- Because essays here carry only random IDs (from the de-identification step), no student names or other direct identifiers are ever transmitted through this app.

## Customizing

- **Model**: change the dropdown options in `index.html` (`<select id="model">`) if Anthropic's available models change.
- **Concurrency / retries**: `CONCURRENCY` and `MAX_RETRIES` constants near the top of the `<script>` block.
- **Grading prompt**: edit the `systemPrompt` construction inside `gradeOne()` to change tone, format, or add few-shot examples.
