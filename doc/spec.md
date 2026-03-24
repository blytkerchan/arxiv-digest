# arXiv Digest — Cloudflare Worker + HTML Frontend

## Overview

A single Cloudflare Worker that serves a self-contained HTML frontend and provides a backend API endpoint. The frontend fetches recent arXiv papers and asks Claude to summarize and curate them. The Anthropic API key is stored as a Worker secret and never exposed to the browser.

---

## Project Structure

```
arxiv-digest/
├── doc/
│   └── spec.md         # This document
├── wrangler.toml
├── src/
│   └── worker.js       # All backend logic
└── public/
    └── index.html      # All frontend logic (single file, no build step)
```

---

## wrangler.toml

```toml
name = "arxiv-digest"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[vars]
# Non-secret config here if needed

# Secret: set via `wrangler secret put ANTHROPIC_API_KEY`
```

---

## Worker: `src/worker.js`

### Routes

| Method  | Path          | Description                        |
|---------|---------------|------------------------------------|
| GET     | `/`           | Serve `index.html`                 |
| POST    | `/api/digest` | Fetch arXiv + summarize via Claude |
| OPTIONS | `/api/digest` | CORS preflight                     |

### `POST /api/digest`

**Request body:**
```json
{ "categories": ["cs.CR", "cs.AI", "quant-ph"] }
```

**Response body:**
```json
[
  {
    "title": "Paper title",
    "arxiv_id": "2503.12345",
    "url": "https://arxiv.org/abs/2503.12345",
    "category": "cs.CR",
    "tldr": "Two sentence plain-language summary.",
    "angle": "One sentence on relevance to cryptography, protocol design, or ML."
  }
]
```

**Error response:**
```json
{ "error": "human-readable message" }
```

### Worker logic

1. Parse request body, validate `categories` is a non-empty array of strings.

2. For each category, fetch from arXiv Atom API:
   ```
   https://export.arxiv.org/api/query?search_query=cat:{category}&sortBy=submittedDate&sortOrder=descending&max_results=5
   ```
   - Fetch all categories in parallel (`Promise.all`)
   - Parse Atom XML response — extract `<entry>` elements
   - From each entry extract: `<id>` (strip to get arxiv_id), `<title>`, `<summary>`
   - Trim whitespace, collapse internal whitespace on title/abstract

3. Call Anthropic API with collected papers:
   - Endpoint: `https://api.anthropic.com/v1/messages`
   - Auth header: `x-api-key: {env.ANTHROPIC_API_KEY}`
   - Header: `anthropic-version: 2023-06-01`
   - Model: `claude-sonnet-4-20250514`
   - `max_tokens`: 4000
   - System prompt: see below
   - User message: serialized list of papers (index, category, arxiv_id, title, abstract truncated to 400 chars)

4. Parse Claude's JSON response, merge summaries back onto paper objects by index, return array.

### System prompt for Claude

```
You are a research assistant helping a reader who works in cryptography, IETF protocol design, post-quantum cryptography, and ML systems.

Given a list of recent arXiv papers (title + abstract snippet), select the most interesting ones and return a JSON array. Pick at most 3 papers per category. Omit papers that are routine incremental work.

Return ONLY a raw JSON array, no markdown fences, no preamble, no explanation:
[
  {
    "index": 0,
    "tldr": "Two sentence summary in plain language.",
    "angle": "One sentence on why this matters to cryptography, protocol design, or ML research."
  }
]

If no papers are interesting for a category, omit that category entirely.
```

### JSON extraction

Claude may wrap output in markdown fences despite instructions. Strip ` ```json ` and ` ``` ` fences, then extract the first `[...]` block before parsing.

### CORS headers

Add to all responses:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

### Error handling

- arXiv fetch fails for a category: log and skip that category, continue with others
- Anthropic API returns non-200: return `{ error: "Claude API error: {status}" }`
- JSON parse fails: return `{ error: "Failed to parse Claude response" }`
- Always return HTTP 200 with `{ error }` rather than HTTP 4xx/5xx for application errors (simplifies frontend handling)

---

## Frontend: `public/index.html`

Single self-contained HTML file. No framework, no build step, vanilla JS.

### Categories

```javascript
const CATEGORIES = [
  { id: "cs.CR",    label: "Cryptography" },
  { id: "cs.IT",    label: "Info Theory" },
  { id: "quant-ph", label: "Quantum" },
  { id: "cs.AI",    label: "AI" },
  { id: "cs.LG",    label: "ML" },
  { id: "cs.MA",    label: "Multi-Agent" },
  { id: "eess.SY",  label: "Power Systems" },
  { id: "cs.SY",    label: "Ctrl Systems" },
  { id: "math.NT",  label: "Number Theory" },
];
```

Default selected: `cs.CR`, `cs.AI`, `quant-ph`.

### UI behaviour

- Category chips: toggle selected/deselected on tap/click
- Fetch button: disabled while loading or if no categories selected. Label shows selected count.
- While fetching: show status message, disable button
- On success: render paper cards
- On error: show error message in styled box
- Paper cards: show category tag, arxiv_id as a link to `https://arxiv.org/abs/{arxiv_id}`, title (italic), tldr, and "WHY IT MATTERS" section if angle present

### API call

```javascript
const res = await fetch('/api/digest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ categories: selected })
});
const data = await res.json();
if (data.error) { /* show error */ }
else { /* render papers */ }
```

Note: relative URL `/api/digest` — works both locally via `wrangler dev` and in production.

### Visual design

Dark theme. Monospace accents. Amber/gold (`#c8b87a`) for interactive elements and arXiv IDs. Paper cards on a near-black background. Mobile-first layout, max-width 680px, centered.

---

## Setup & Deployment

```bash
# Install
npm install -g wrangler

# Login
wrangler login

# Set API key secret (prompted for value, never stored in files)
wrangler secret put ANTHROPIC_API_KEY

# Local dev
wrangler dev

# Deploy
wrangler deploy
```

After `wrangler deploy`, the Worker is live at `https://arxiv-digest.{your-subdomain}.workers.dev`.

---

## Notes for Copilot

- Worker uses `XMLParser` is not available in Workers — use the native `DOMParser` (available via `new Response(xml).text()` pattern) or write a minimal regex/string extractor for Atom XML `<entry>` blocks. Alternatively use a lightweight XML parser compatible with the Workers runtime.
- Workers runtime is not Node.js — no `require()`, no `fs`, no `path`. Use ES module `import` syntax or inline everything in `worker.js`.
- The `index.html` content can be inlined as a string constant in `worker.js` or read from a KV binding — inlining is simpler for a project this size.
- Keep `worker.js` under ~300 lines. If it grows beyond that, extract arXiv fetching and Claude calling into named functions in the same file.
- The version uploaded to Cloudflare should be compiled/cminified with `ncc` so we don't have to worry too much about not having Node.js
- 