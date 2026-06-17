import { PDFiumLibrary } from "/vendor/pdfium.mjs";

// Why PDFium (WASM) instead of a canvas-based PDF renderer:
// decks exported via "print to PDF" use gradient + soft-mask backgrounds. Renderers that
// composite those on GPU-accelerated 2D canvases (iOS Safari, desktop Chromium) corrupt
// the result into a pink/magenta wash. PDFium rasterises each page entirely on the CPU
// inside WebAssembly and hands back a finished RGBA bitmap; we blit it with putImageData —
// a direct pixel copy with no compositing — so every browser shows identical, correct
// colours for any PDF, with no pre-processing.
const PDF_URL = "/deck";
const WASM_URL = "/vendor/pdfium.wasm";
const MAX_CANVAS_PIXELS = 16_000_000; // guard against iOS/desktop canvas size limits

const els = {
  canvas: document.getElementById("canvas"),
  loader: document.getElementById("loader"),
  loaderText: document.getElementById("loader-text"),
  error: document.getElementById("error"),
  errorText: document.getElementById("error-text"),
  retry: document.getElementById("retry"),
  counter: document.getElementById("counter"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  zonePrev: document.getElementById("zone-prev"),
  zoneNext: document.getElementById("zone-next"),
  fullscreen: document.getElementById("fullscreen"),
  stage: document.getElementById("stage"),
};

const ctx = els.canvas.getContext("2d", { alpha: false });

let lib = null;
let doc = null;
let pageCount = 0;
let current = 1; // 1-based
let renderToken = 0; // cancels stale renders
const pageCache = new Map(); // pageNum -> PDFiumPage handle

function clampDpr() {
  return Math.min(window.devicePixelRatio || 1, 2.5);
}

function pageFromHash() {
  const n = parseInt((location.hash || "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function updateHash(n) {
  const target = "#" + n;
  if (location.hash !== target) history.replaceState(null, "", target);
}

function updateControls() {
  els.counter.textContent = `${current} / ${pageCount}`;
  const atStart = current <= 1;
  const atEnd = current >= pageCount;
  els.prev.disabled = atStart;
  els.zonePrev.disabled = atStart;
  els.next.disabled = atEnd;
  els.zoneNext.disabled = atEnd;
  els.canvas.setAttribute("aria-label", `Slide ${current} of ${pageCount}`);
}

function getPage(num) {
  if (pageCache.has(num)) return pageCache.get(num);
  const p = doc.getPage(num - 1); // PDFium is 0-based
  pageCache.set(num, p);
  return p;
}

// Pick a render scale that fills the stage at device resolution, capped so the canvas
// never exceeds platform pixel limits.
function scaleFor(page) {
  const dpr = clampDpr();
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const pad = 2 * parseFloat(getComputedStyle(els.stage).paddingLeft || "0");
  const rect = els.stage.getBoundingClientRect();
  const availW = Math.max(64, rect.width - pad);
  const availH = Math.max(64, rect.height - pad);
  let scale = Math.min((availW * dpr) / originalWidth, (availH * dpr) / originalHeight);
  const px = originalWidth * scale * originalHeight * scale;
  if (px > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
  return { scale, dpr };
}

async function renderPage(num) {
  const token = ++renderToken;
  const page = getPage(num);
  const { scale, dpr } = scaleFor(page);

  // CPU rasterise inside WASM -> finished RGBA bytes.
  const r = await page.render({ scale, render: (b) => b.data });
  if (token !== renderToken) return; // superseded by a newer navigation/resize

  els.canvas.width = r.width;
  els.canvas.height = r.height;
  els.canvas.style.width = Math.floor(r.width / dpr) + "px";
  els.canvas.style.height = Math.floor(r.height / dpr) + "px";
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  els.canvas.classList.add("ready");
}

async function goTo(num, { push = true } = {}) {
  if (!doc) return;
  const target = Math.min(Math.max(1, num), pageCount);
  current = target;
  updateControls();
  if (push) updateHash(target);
  await renderPage(target);
}

const next = () => goTo(current + 1);
const prev = () => goTo(current - 1);

function showError(msg) {
  els.loader.hidden = true;
  els.errorText.textContent = msg || "Couldn’t load the presentation.";
  els.error.hidden = false;
}

// Fetch the deck with download progress (one download; the service worker caches it).
async function fetchDeck() {
  const res = await fetch(PDF_URL);
  if (!res.ok) {
    const err = new Error(`deck fetch failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    els.loaderText.textContent = `Loading… ${Math.round((received / total) * 100)}%`;
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function load() {
  els.error.hidden = true;
  els.loader.hidden = false;
  els.canvas.classList.remove("ready");
  pageCache.clear();
  if (doc) { try { doc.destroy(); } catch {} doc = null; }
  try {
    if (!lib) lib = await PDFiumLibrary.init({ wasmUrl: WASM_URL });
    const bytes = await fetchDeck();
    doc = await lib.loadDocument(bytes);
    pageCount = doc.getPageCount();
    els.loader.hidden = true;
    await goTo(pageFromHash(), { push: false });
  } catch (e) {
    console.error(e);
    const msg = e?.status === 404
      ? "No presentation found. Upload a PDF to R2 as “deck.pdf”."
      : "Couldn’t load the presentation. Check your connection and retry.";
    showError(msg);
  }
}

/* ---------- Input: keyboard ---------- */
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  switch (e.key) {
    case "ArrowRight":
    case "PageDown":
    case " ":
      e.preventDefault(); next(); break;
    case "ArrowLeft":
    case "PageUp":
      e.preventDefault(); prev(); break;
    case "Home":
      e.preventDefault(); goTo(1); break;
    case "End":
      e.preventDefault(); goTo(pageCount); break;
    case "f":
    case "F":
      toggleFullscreen(); break;
  }
});

/* ---------- Input: clicks / tap zones ---------- */
els.next.addEventListener("click", next);
els.prev.addEventListener("click", prev);
els.zoneNext.addEventListener("click", next);
els.zonePrev.addEventListener("click", prev);
els.retry.addEventListener("click", load);

/* ---------- Input: swipe ---------- */
let touchStartX = 0, touchStartY = 0, touchActive = false;
els.stage.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { touchActive = false; return; }
  touchActive = true;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });
els.stage.addEventListener("touchend", (e) => {
  if (!touchActive) return;
  touchActive = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) {
    dx < 0 ? next() : prev();
  }
}, { passive: true });

/* ---------- Fullscreen + immersive UI ---------- */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
}
els.fullscreen.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("immersive", !!document.fullscreenElement);
});

let uiTimer;
function flashUI() {
  document.body.classList.add("show-ui");
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => document.body.classList.remove("show-ui"), 2200);
}
window.addEventListener("mousemove", () => { if (document.fullscreenElement) flashUI(); });

/* ---------- Re-render on resize / hash ---------- */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (doc) renderPage(current); }, 120);
});
window.addEventListener("hashchange", () => {
  const n = pageFromHash();
  if (n !== current) goTo(n, { push: false });
});

/* ---------- Offline indicator ---------- */
const offlinePill = document.getElementById("offline-pill");
function reflectConnection() {
  offlinePill.hidden = navigator.onLine;
}
window.addEventListener("online", reflectConnection);
window.addEventListener("offline", reflectConnection);
reflectConnection();

/* ---------- PWA: offline caching + "new deck" notice ---------- */
const toast = document.getElementById("toast");
document.getElementById("toast-reload").addEventListener("click", () => location.reload());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "deck-updated") toast.hidden = false;
  });
}

load();
