# Slidedrop

A fast, static **presentation viewer** hosted on **Cloudflare Pages** that renders a PDF
stored in **Cloudflare R2**. To publish a new deck, you just replace one file in R2 — no
rebuild, no redeploy. Point it at any PDF; it's not tied to any particular deck.

Pages are rasterised on the CPU in WebAssembly (PDFium) and blitted to a canvas, so **any
PDF renders identically on every browser** — including decks with gradient/transparency
backgrounds that some GPU-accelerated renderers corrupt. No pre-processing required.

```
Browser ─► Cloudflare Pages (HTML + PDFium/WASM viewer)
                 └─ GET /deck ─► Pages Function (functions/deck.js)
                                       └─ R2 bucket, key "deck.pdf"
```

- **Navigation:** ← → / Space / PageUp / PageDown / Home / End, on-screen buttons,
  edge click zones, and touch swipe. Fullscreen with `F`.
- **Deep links:** `https://your-domain/#3` opens slide 3.
- **Crisp:** pages render to high-DPI canvas; neighbours preload for instant flips.
- **Offline-first:** loads once, then works with no connection (see below).
- **Cheap to run:** designed to fit comfortably within Cloudflare's free tiers.

## Built for bad connections (offline-first)

The viewer is a PWA with a service worker (`public/sw.js`):

- **First visit** downloads the app (including the ~4 MB PDFium wasm engine, compressed in
  transit) + the PDF once and caches both on the device. Subsequent visits download nothing.
- **Every later visit** loads instantly from cache — including with **no connection at
  all**. An "Offline — showing saved deck" pill appears when you're offline.
- When you publish a new deck, the service worker notices it in the background and shows a
  **"A newer deck is available — Reload"** toast; until you reload, the old deck keeps
  working.
- It's **installable** to a phone home screen / desktop (via `manifest.webmanifest`).

> ⚠️ **When you change the UI** (`index.html`, `app.js`, `styles.css`, or the vendored
> engine), bump `CACHE_VERSION` in `public/sw.js` (e.g. `v1` → `v2`) and redeploy, so
> clients drop the old cached shell. Swapping the *PDF* needs no version bump.

## Files

| Path | Purpose |
|------|---------|
| `public/index.html`, `app.js`, `styles.css` | The viewer UI |
| `public/vendor/pdfium.*` | Pinned PDFium engine — wasm + glue (served from your own domain) |
| `public/_headers` | Cache headers for static assets |
| `public/sw.js` | Service worker: offline caching + new-deck detection |
| `public/manifest.webmanifest`, `icon.svg` | PWA install metadata + icon |
| `functions/deck.js` | Serves the deck PDF from R2 at `/deck` (read-only, single key) |
| `scripts/flatten.mjs` | Optional: rasterise a deck to a smaller flat PDF (Ghostscript) |
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
2. **Upload your PDF** into that bucket and name the object exactly **`deck.pdf`**.
3. **Bind the bucket** to the deployed project: **Project → Settings → Bindings →
   add R2 binding** with variable name `PDF_BUCKET` pointing at your bucket (do this for
   Production). Redeploy so it takes effect.

Verify: `https://<project>.pages.dev/deck` downloads the PDF, and the root URL shows the
slides.

> Keep this bucket dedicated to the deck — store nothing sensitive in it (see Security).

---

## Custom domain

**Project → Custom domains → Set up a custom domain** → enter a subdomain you own, e.g.
`slides.yourdomain.com` (just the hostname, no `https://`). If the domain is on
Cloudflare, the DNS record and HTTPS certificate are configured automatically.

---

## Publishing a new deck

Replace the object — that's the whole workflow. Any PDF works as-is (the viewer rasterises
it on the CPU, so there's nothing to pre-process). Either:

```bash
npm run deck:publish -- ./path/to/new-deck.pdf
```

…or drag-and-drop the file in **dashboard → R2 → your bucket**, saving it as `deck.pdf`
(overwrite the existing object). No redeploy needed.

Responses are briefly edge-cached, so a new deck may take a short while to appear; do a
hard refresh, or purge the cache in the dashboard, to see it immediately.

### Optional: shrink a deck

Large PDFs download once and cache, so size rarely matters. If you do want a smaller file,
flatten it to opaque raster pages (needs **Ghostscript**):

```bash
npm run deck:flatten -- ./path/to/new-deck.pdf   # prints the flattened file's path
```

Then publish/upload that `*.flattened.pdf`. Tune resolution with `--dpi <n>` (default 200).
This is purely a size optimisation — it is **not** required for correct rendering.

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

- **`/deck` is read-only and serves a single fixed object.** The R2 object key is a
  hard-coded constant (`deck.pdf`); nothing from the request (path, query, headers) is
  used to choose what's read. There's no listing, enumeration, writing, or deleting.
- The function accesses **only its one dedicated bucket** — no other bucket or account
  resource is reachable from it.
- Because that bucket is exposed (as the deck) keep it **dedicated to the public
  presentation** and store nothing private in it.
- No secrets live in this repo. Deploy credentials, if you use the CLI, stay in your local
  Cloudflare login; nothing sensitive is committed.

---

## Updating the PDF engine later

```bash
npm install -D @hyzyla/pdfium@latest
npm run vendor      # recopies the wasm + glue into public/vendor
# bump CACHE_VERSION in public/sw.js, then deploy (push to main, or `npm run deploy`)
```

## Notes

- Want multiple decks (e.g. an archive at their own URLs)? That's a small extension to the
  function — open an issue or ask.
