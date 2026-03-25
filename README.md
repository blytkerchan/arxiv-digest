# arXiv Digest

A Cloudflare Worker that fetches recent [arXiv](https://arxiv.org) papers and curates them using [Claude](https://www.anthropic.com/claude). A self-contained HTML frontend is served directly from the worker — no separate hosting required.

## How it works

- **`GET /`** — serves the single-page frontend
- **`POST /api/digest`** — accepts a list of arXiv category codes, fetches the latest papers, and calls the Anthropic API to select and summarize the most relevant ones
- The Anthropic API key is stored as a Cloudflare secret and never exposed to the browser

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18 and npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- An [Anthropic API key](https://console.anthropic.com/)

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Log in to Cloudflare

```sh
npx wrangler login
```

This opens a browser window to authenticate your Cloudflare account.

### 3. Configure local secrets

Copy the env template and fill in your Anthropic API key:

```sh
cp dot-env .dev.vars
# edit .dev.vars and set ANTHROPIC_API_KEY
```

`.dev.vars` is read automatically by `wrangler dev` and is gitignored — never commit it.

### 4. Run locally

```sh
npm run dev
```

The worker will be available at `http://localhost:8787`.

## Deployment

### Set the production secret

Before the first deploy, store your Anthropic API key as a Cloudflare secret:

```sh
npm run secret:set
# or: npx wrangler secret put ANTHROPIC_API_KEY
```

You will be prompted to paste the key value. This stores it encrypted in Cloudflare — it is never written to disk or committed to source control.

### Deploy

```sh
npm run deploy
```

Wrangler will build and upload the worker. On success it prints the live URL (e.g. `https://arxiv-digest.<your-subdomain>.workers.dev`).

## npm scripts

| Script | Description |
|---|---|
| `npm run dev` | Start local dev server (`wrangler dev`) |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run tail` | Stream live logs from the deployed worker |
| `npm run secret:set` | Set `ANTHROPIC_API_KEY` as a Cloudflare secret |
| `npm run secret:list` | List secrets currently set on the worker |

## Project structure

```
arxiv-digest/
├── dot-env            # Template for local secrets → copy to .dev.vars
├── package.json
├── wrangler.toml      # Worker name, entrypoint, compatibility date
├── doc/
│   └── spec.md        # Full design spec
├── public/
│   └── index.html     # Frontend (served as a text module by the worker)
└── src/
    └── worker.js      # All backend logic
```

## Configuration

Non-secret settings (e.g. worker name, compatibility date) live in [wrangler.toml](wrangler.toml).

Secrets are managed via `wrangler secret put` and are never stored in source control.

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key, used server-side to call Claude |
