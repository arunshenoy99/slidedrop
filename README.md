# Slidedrop

A fast, static **presentation viewer** hosted on **Cloudflare Pages** that renders PDFs
stored in **Cloudflare R2**. To publish or update a deck, you just upload one file to R2 —
no rebuild, no redeploy. It's not tied to any particular deck.

**One deployment serves many decks**, each at its own URL: the path picks the deck.

```
Browser ─► Cloudflare Pages (HTML + PDF.js)
   /              ─► viewer ─► GET /d/deck         ─► Pages Function ─► R2 "deck.pdf"
   /meetup        ─► viewer ─► GET /d/meetup       ─► functions/d/[[path]].js ─► R2 "meetup.pdf"
   /wpblr/meetup  ─► viewer ─► GET /d/wpblr/meetup ─► functions/d/[[path]].js ─► R2 "wpblr/meetup.pdf"
```

- **Multiple decks, optionally in folders:** `https://slides.example.com/meetup` renders
  `meetup.pdf`, and `…/wpblr/meetup` renders `wpblr/meetup.pdf` (R2 "folders" are just `/`
  in the key). The bare domain renders the default `deck.pdf`. Add a deck by uploading
  `<path>.pdf` to R2.
- **Navigation:** ← → / Space / PageUp / PageDown / Home / End, on-screen buttons,
  edge click zones, and touch swipe. Fullscreen with `F`.
- **Deep links:** `https://your-domain/wpblr/meetup#3` opens slide 3 of the `wpblr/meetup`
  deck.
- **Crisp:** pages render to high-DPI canvas; neighbours preload for instant flips.
- **Offline-first:** loads once, then works with no connection (see below).
- **Cheap to run:** designed to fit comfortably within Cloudflare's free tiers.

## Built for bad connections (offline-first)

The viewer is a PWA with a service worker (`public/sw.js`):

- **First visit** downloads the app once, plus each deck you open, and caches them on the
  device. Decks are cached per URL, so every deck you've viewed stays available offline.
- **Every later visit** loads instantly from cache — including with **no connection at
  all**. An "Offline — showing saved deck" pill appears when you're offline.
- When you publish a new deck, the service worker notices it in the background and shows a
  **"A newer deck is available — Reload"** toast; until you reload, the old deck keeps
  working.
- It's **installable** to a phone home screen / desktop (via `manifest.webmanifest`).

> ⚠️ **When you change the UI** (`index.html`, `app.js`, `styles.css`, or the vendored
> PDF.js), bump `CACHE_VERSION` in `public/sw.js` (e.g. `v1` → `v2`) and redeploy, so
> clients drop the old cached shell. Swapping the *PDF* needs no version bump.

## Files

| Path | Purpose |
|------|---------|
| `public/index.html`, `app.js`, `styles.css` | The viewer UI |
| `public/vendor/pdf.*.mjs` | Pinned PDF.js (served from your own domain) |
| `public/_headers` | Cache + hardening headers for static assets |
| `public/_redirects` | SPA fallback so `/<name>` paths serve the viewer shell |
| `public/sw.js` | Service worker: per-deck offline caching + new-deck detection |
| `public/manifest.webmanifest`, `icon.svg` | PWA install metadata + icon |
| `functions/d/[[path]].js` | Serves `<path>.pdf` from R2 at `/d/<path>` (read-only, nested, each segment allowlisted) |
| `scripts/flatten.mjs`, `publish.mjs` | Flatten a deck (Ghostscript) and publish it to R2 |
| `wrangler.toml` | Pages config + R2 binding |

---

## Deploy

Either option works; **A is recommended** because pushes deploy automatically.

### Option A — Connect the repo to Pages (recommended)

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick
this repository, and use these build settings:

- Framework preset: **None**
- Build command: *(empty — nothing to build)*
- Build output directory: **`public`**
- Production branch: **`main`**

Every push to `main` then builds and deploys; non-production branches get preview URLs.

### Option B — Deploy from the CLI

```bash
npx wrangler login
npm run deploy           # wrangler pages deploy public
```

> Use one path or the other, not both on the same project.

---

## Required: R2 bucket, the deck, and the binding

The viewer reads the PDF from R2, so this must be set up regardless of deploy option.

1. **Create a bucket** (dashboard → R2 → Create bucket). Use the name configured in
   `wrangler.toml`.
2. **Upload your PDF(s).** Name the default deck exactly **`deck.pdf`** (served at `/`).
   Each additional deck is **`<path>.pdf`** and is served at **`/<path>`** — e.g.
   `meetup.pdf` → `/meetup`, or nest with folders: `wpblr/meetup.pdf` → `/wpblr/meetup`.
   Every path segment must be lowercase letters, digits, and hyphens (max 8 segments).
3. **Bind the bucket** to the deployed project: **Project → Settings → Bindings →
   add R2 binding** with variable name `PDF_BUCKET` pointing at your bucket (do this for
   Production). Redeploy so it takes effect.

Verify: `https://<project>.pages.dev/d/deck` downloads the PDF, and the root URL shows the
slides.

> Keep this bucket dedicated to decks — every object is publicly reachable as `/<name>`,
> so store nothing sensitive in it (see Security).

---

## Custom domain

**Project → Custom domains → Set up a custom domain** → enter a subdomain you own, e.g.
`slides.yourdomain.com` (just the hostname, no `https://`). If the domain is on
Cloudflare, the DNS record and HTTPS certificate are configured automatically.

---

## Publishing a deck

```bash
npm run deck:publish -- ./path/to/deck.pdf                  # default deck, served at /
npm run deck:publish -- ./slides/meetup.pdf                # → deck "meetup", at /meetup
npm run deck:publish -- ./talk.pdf --name townhall          # explicit name, at /townhall
npm run deck:publish -- ./talk.pdf --name wpblr/meetup      # nested, at /wpblr/meetup
```

This **flattens** the PDF (see below) and uploads it to R2 as `<path>.pdf`. The deck name
defaults to the input filename (sanitised to lowercase letters/digits/hyphens); use
`--name` to set it explicitly, including a `/`-nested path. No redeploy needed.

Prefer the dashboard? Flatten first, then drag-and-drop the result:

```bash
npm run deck:flatten -- ./path/to/meetup.pdf   # prints the flattened file's path
```

…then upload that `*.flattened.pdf` in **dashboard → R2 → your bucket**, saving it as
`<name>.pdf` (e.g. `meetup.pdf`; overwrite to replace an existing deck).

Responses are briefly edge-cached, so a new deck may take a short while to appear; do a
hard refresh, or purge the cache in the dashboard, to see it immediately.

### Why flatten? (important)

Decks exported via "print to PDF" (e.g. from a browser) often use gradient and
soft-mask backgrounds. The in-browser renderer composites those at display time, and some
GPU-accelerated canvas stacks — notably **iOS Safari and desktop Chromium** — corrupt that
compositing into a **pink/magenta wash**, even though the PDF itself is perfectly correct
(it looks fine in native PDF viewers). Flattening rasterises each page to a single opaque
image (via Ghostscript), removing all transparency so every browser draws it identically.

`deck:publish` and `deck:flatten` do this automatically — **always upload a flattened
file.** Flattening needs **Ghostscript** (`gs`) installed locally (`brew install
ghostscript` / `sudo apt install ghostscript`). Tune sharpness with `--dpi <n>` (default
200); the viewer itself needs no changes.

---

## Local preview

```bash
npm run deck:local -- ./path/to/deck.pdf   # seed a local R2 copy (once)
npm run dev                                 # http://localhost:8788
```

`npm run dev` simulates R2 locally — it never touches production.

---

## Cost

Designed to run within Cloudflare's free tiers (static hosting, the `/deck` Function, and
R2 storage). You are not billed unless you opt into a paid plan — the free plan limits
throttle rather than charge. Leave billing on the free plan and there's nothing to pay.

## Security

- **`/d/<path>` is read-only and every path segment is strictly allowlisted.** The object
  key is `<path>.pdf`, built segment-by-segment where each segment must match
  `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` — lowercase alphanumerics and interior hyphens,
  **no dots or slashes inside a segment** — and the path is capped at 8 segments. Because
  no segment can contain `.` or `/`, a request can only ever read `*.pdf` objects by exact
  path: no path traversal (`..`/encoded slashes are rejected or normalised away), no
  escaping the `.pdf` suffix, and no listing, enumeration, writing, or deleting. Anything
  outside the allowlist returns 404. The viewer applies the identical check before
  requesting a deck.
- The function accesses **only its one dedicated bucket** — no other bucket or account
  resource is reachable from it.
- Because **every object in that bucket is publicly reachable** as `/<name>`, keep it
  **dedicated to public presentations** and store nothing private in it.
- No secrets live in this repo. Deploy credentials, if you use the CLI, stay in your local
  Cloudflare login; nothing sensitive is committed.
- **Hardening headers** ship on every response: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: SAMEORIGIN`
  (static assets via `public/_headers`; the `/deck` PDF sets `nosniff` itself). Loosen
  `X-Frame-Options` only if you intend to embed the viewer in another site.

---

## Updating PDF.js later

```bash
npm install pdfjs-dist@latest
npm run vendor      # recopies the build into public/vendor
# then deploy (push to main, or `npm run deploy`)
```

## Notes

- **Multiple decks** are built in: every `<path>.pdf` in the bucket is live at `/<path>`,
  including nested folders like `wpblr/meetup.pdf` → `/wpblr/meetup` (the default
  `deck.pdf` is at `/`). Each deck is cached independently for offline use.
- Deck URLs are **unlisted, not secret** — anyone who knows (or guesses) a name can view
  it. Keep the bucket public-only.
