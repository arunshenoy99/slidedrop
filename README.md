# Slidedrop

A fast, static presentation viewer hosted on **Cloudflare Pages** that renders a PDF
stored in **Cloudflare R2**. To publish a new deck each month you just replace one file
in R2 — no rebuild, no redeploy.

```
Browser ─► Cloudflare Pages (HTML + PDF.js)
                 └─ GET /deck ─► Pages Function (functions/deck.js)
                                       └─ R2 bucket "slidedrop-deck", key "deck.pdf"
```

- **Navigation:** ← → / Space / PageUp / PageDown / Home / End, on-screen buttons,
  edge click zones, and touch swipe. Fullscreen with `F`.
- **Deep links:** `https://your-domain/#3` opens slide 3.
- **Crisp & optimized:** pages render to high-DPI canvas; neighbours preload for instant
  flips; the deck is downloaded once and cached for offline use (see below).
- **Cost:** $0 — Pages (static + Functions) and R2 free tiers cover this easily.

## Built for bad connections (offline-first)

The viewer is a PWA with a service worker (`public/sw.js`):

- **First visit** downloads the app + the PDF once (single request, no chunked range
  fetches) and caches both on the device.
- **Every later visit** loads instantly from cache — including with **no connection at
  all**. An "Offline — showing saved deck" pill appears when you're offline.
- When you publish a new deck, the service worker notices it in the background and shows a
  **"A newer deck is available — Reload"** toast; until you reload, the old deck keeps
  working. (Detection bypasses the HTTP cache, so it's immediate once you're back online.)
- It's **installable** to a phone home screen / desktop (via `manifest.webmanifest`) and
  runs full-screen, offline.

> ⚠️ **When you change the UI** (`index.html`, `app.js`, `styles.css`, or the vendored
> PDF.js), bump `CACHE_VERSION` in `public/sw.js` (e.g. `v1` → `v2`) and redeploy, so
> clients drop the old cached shell. Swapping the *PDF* needs no version bump.

## Files

| Path | Purpose |
|------|---------|
| `public/index.html`, `app.js`, `styles.css` | The viewer UI |
| `public/vendor/pdf.*.mjs` | Pinned PDF.js (served from your own domain) |
| `public/_headers` | Cache rules for static assets |
| `public/sw.js` | Service worker: offline caching + new-deck detection |
| `public/manifest.webmanifest`, `icon.svg` | PWA install metadata + icon |
| `functions/deck.js` | Streams `deck.pdf` from R2 at `/deck` |
| `wrangler.toml` | Pages config + R2 binding |

---

## One-time setup

You need a Cloudflare account (free) and the domain you already have on Cloudflare.

### 1. Log in

```bash
npx wrangler login
```

### 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create slidedrop-deck
```

> The name must match `bucket_name` in `wrangler.toml`. To use a different name,
> change it in both places.

### 3. Upload your first deck

```bash
npm run deck:publish -- ./meetup-intro.pdf
```

(That stores it in R2 under the key `deck.pdf`, which is what the viewer reads.)

### 4. Deploy the site

```bash
npm run deploy
```

The first deploy creates the Pages project (`slidedrop`) and prints a
`*.pages.dev` URL.

### 5. Attach the R2 binding in the dashboard (one time)

`wrangler.toml` wires the binding for local dev, but the deployed Pages project needs it
set once in the dashboard:

**Cloudflare dashboard → Workers & Pages → `slidedrop` → Settings → Functions →
R2 bucket bindings → Add binding**
- Variable name: `PDF_BUCKET`
- R2 bucket: `slidedrop-deck`

Then redeploy (`npm run deploy`) so the binding takes effect. Verify
`https://<project>.pages.dev/deck` downloads your PDF, and the root URL shows the slides.

### 6. Point your domain at it

**Pages project → Custom domains → Set up a custom domain** → enter your subdomain
(e.g. `slides.yourdomain.com`). Since the domain is already on Cloudflare, DNS is added
automatically and HTTPS is issued for you.

---

## Monthly update (the whole workflow)

Replace the deck — that's it. Either:

```bash
npm run deck:publish -- ./path/to/new-deck.pdf
```

…or drag-and-drop the file in **dashboard → R2 → slidedrop-deck**, saving it as
`deck.pdf` (overwrite the existing object).

The new slides appear within ~60s (the edge cache TTL). To see it instantly, purge the
cache: **dashboard → your domain → Caching → Purge Everything**, or hard-refresh.

---

## Local preview

```bash
npm run deck:local -- ./meetup-intro.pdf   # seed a local R2 copy (once)
npm run dev                                 # http://localhost:8788
```

`npm run dev` simulates R2 locally — it never touches production.

---

## Updating PDF.js later

```bash
npm install pdfjs-dist@latest
npm run vendor      # recopies the build into public/vendor
npm run deploy
```

## Notes

- The R2 object key is hard-coded to `deck.pdf` in `functions/deck.js`. Keep uploading to
  that key and nothing else changes.
- Want multiple decks (e.g. `/#archive/2026-05`)? That's a small extension — the function
  can take the key from the path. Ask if you want it.
