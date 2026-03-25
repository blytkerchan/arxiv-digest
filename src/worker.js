/**
 * arXiv Digest — Cloudflare Worker
 *
 * Routes:
 *   GET  /           → serve index.html
 *   POST /api/digest → fetch arXiv papers + summarize via Claude
 *   OPTIONS /api/digest → CORS preflight
 */

import HTML from "../public/index.html";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARXIV_BASE =
  "https://export.arxiv.org/api/query?search_query=cat:{category}&sortBy=submittedDate&sortOrder=descending&max_results=5";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 1024;
const ABSTRACT_MAX_CHARS = 400;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SYSTEM_PROMPT = `You are a research assistant helping a reader who works in cryptography, IEEE PES protocol design, post-quantum cryptography, and ML systems.

Given a list of recent arXiv papers (title + abstract snippet), select the most interesting ones and return a JSON array. Pick at most 3 papers per category. Omit papers that are routine incremental work.

Return ONLY a raw JSON array, no markdown fences, no preamble, no explanation:
[
  {
    "index": 0,
    "tldr": "Two sentence summary in plain language.",
    "angle": "One sentence on why this matters to cryptography, protocol design, or ML research."
  }
]

If no papers are interesting for a category, omit that category entirely.`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, method } = { pathname: url.pathname, method: request.method };

    if (method === "OPTIONS" && pathname === "/api/digest") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === "GET" && pathname === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    if (method === "POST" && pathname === "/api/digest") {
      return handleDigest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// POST /api/digest
// ---------------------------------------------------------------------------

async function handleDigest(request, env) {
  // 1. Parse and validate request body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const { categories } = body;
  if (
    !Array.isArray(categories) ||
    categories.length === 0 ||
    !categories.every((c) => typeof c === "string")
  ) {
    return jsonError("categories must be a non-empty array of strings");
  }

  // Validate API key is configured
  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("ANTHROPIC_API_KEY is not configured", 500);
  }

  // 2. Fetch arXiv papers for all categories in parallel
  const fetchResults = await Promise.all(
    categories.map((cat) => fetchArxivCategory(cat))
  );

  // Build flat list of papers with sequential indices
  const papers = [];
  for (let i = 0; i < categories.length; i++) {
    const entries = fetchResults[i];
    for (const entry of entries) {
      papers.push({ ...entry, category: categories[i], index: papers.length });
    }
  }

  if (papers.length === 0) {
    return jsonError("No papers fetched from arXiv", 502);
  }

  // 3. Call Claude to summarize / curate
  let claudeSummaries;
  try {
    claudeSummaries = await callClaude(papers, env.ANTHROPIC_API_KEY);
  } catch (err) {
    return jsonError(err.message, 502);
  }

  // 4. Merge Claude's selections back onto paper objects
  const result = [];
  for (const summary of claudeSummaries) {
    const paper = papers[summary.index];
    if (!paper) continue;
    result.push({
      title: paper.title,
      arxiv_id: paper.arxiv_id,
      url: paper.url,
      category: paper.category,
      tldr: summary.tldr,
      angle: summary.angle || null,
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// arXiv fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent papers for a single arXiv category.
 * Returns an array of { arxiv_id, url, title, abstract } objects.
 * On failure, logs and returns empty array (caller continues with others).
 */
async function fetchArxivCategory(category) {
  const apiUrl = ARXIV_BASE.replace("{category}", encodeURIComponent(category));
  let resp;
  try {
    resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.error(`arXiv fetch failed for ${category}:`, err.message);
    return [];
  }

  const xml = await resp.text();
  return parseAtomEntries(xml);
}

/**
 * Parse Atom XML and extract entry fields using regex/string extraction.
 * DOMParser is not available in the Workers runtime.
 */
function parseAtomEntries(xml) {
  const entries = [];
  // Split on <entry> boundaries
  const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);
  for (const match of entryMatches) {
    const block = match[1];

    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/);
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = block.match(/<summary>([\s\S]*?)<\/summary>/);

    if (!idMatch || !titleMatch || !summaryMatch) continue;

    // arXiv IDs look like http://arxiv.org/abs/2503.12345v1 — strip to bare id
    const rawId = idMatch[1].trim();
    const arxiv_id = rawId.replace(/^.*abs\//, "").replace(/v\d+$/, "");
    const url = `https://arxiv.org/abs/${arxiv_id}`;
    const title = collapseWhitespace(titleMatch[1]);
    const abstract = collapseWhitespace(summaryMatch[1]);

    entries.push({ arxiv_id, url, title, abstract });
  }
  return entries;
}

/** Trim and collapse internal whitespace to single spaces. */
function collapseWhitespace(str) {
  return str.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Claude / Anthropic
// ---------------------------------------------------------------------------

/**
 * Build the user message listing all papers and call Claude.
 * Returns the parsed JSON array of { index, tldr, angle } objects.
 * Throws on API error or JSON parse failure.
 */
async function callClaude(papers, apiKey) {
  const userMessage = papers
    .map(
      (p) =>
        `[${p.index}] (${p.category}) ${p.arxiv_id}\nTitle: ${p.title}\nAbstract: ${p.abstract.slice(0, ABSTRACT_MAX_CHARS)}`
    )
    .join("\n\n");

  const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

  const resp = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body,
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json();
      detail = errBody?.error?.message ?? JSON.stringify(errBody);
    } catch {
      detail = await resp.text().catch(() => "");
    }
    console.error("Claude API error:", resp.status, detail);
    throw new Error(`Claude API error ${resp.status}: ${detail}`);
  }

  const apiData = await resp.json();
  const rawText = apiData.content?.[0]?.text ?? "";

  return extractJsonArray(rawText);
}

/**
 * Strip optional markdown fences and extract the first JSON array from text.
 * Claude may wrap output in ```json ... ``` despite instructions.
 */
function extractJsonArray(text) {
  // Remove markdown fences if present
  let cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Extract first [...] block
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Failed to parse Claude response");
  }

  const jsonStr = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse Claude response");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
