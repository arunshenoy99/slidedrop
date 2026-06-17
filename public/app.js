import * as pdfjsLib from "/vendor/pdf.min.mjs";

// Force every 2D canvas onto a CPU-backed surface (willReadFrequently). PDF.js renders
// soft masks / transparency groups on internal scratch canvases, and on some GPU-
// accelerated stacks (iOS Safari, desktop Chromium) that compositing is corrupted into a
// pink/magenta wash — even though the PDF is fine in software renderers. PDF.js sets this
// hint on a few of its canvases but not the ones that matter here, so we patch globally:
// CPU rendering matches the correct software output and works for any PDF.
function forceCpu2d(proto) {
  if (!proto) return;
  const orig = proto.getContext;
  proto.getContext = function (type, attrs) {
    if (type === "2d") attrs = Object.assign({}, attrs, { willReadFrequently: true });
    return orig.call(this, type, attrs);
  };
}
forceCpu2d(HTMLCanvasElement.prototype);
forceCpu2d(typeof OffscreenCanvas !== "undefined" && OffscreenCanvas.prototype);

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

// Same-origin Pages Function that streams the current PDF from R2.
const PDF_URL = "/deck";

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

let pdfDoc = null;
let pageCount = 0;
let current = 1;          // 1-based
let renderToken = 0;      // cancels stale renders
const pageCache = new Map(); // pageNum -> pdf page proxy

function clampDpr() {
  // Cap DPR so huge retina canvases don't blow past GPU/memory limits.
  return Math.min(window.devicePixelRatio || 1, 2.5);
}

function pageFromHash() {
  const n = parseInt((location.hash || "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function updateHash(n) {
  const target = "#" + n;
  if (location.hash !== target) {
    history.replaceState(null, "", target);
  }
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

async function getPage(num) {
  if (pageCache.has(num)) return pageCache.get(num);
  const p = await pdfDoc.getPage(num);
  pageCache.set(num, p);
  return p;
}

async function renderPage(num) {
  const token = ++renderToken;
  const page = await getPage(num);
  if (token !== renderToken) return; // superseded

  // Fit the page within the stage while honoring device pixel ratio for sharpness.
  const dpr = clampDpr();
  const unscaled = page.getViewport({ scale: 1 });
  const stageRect = els.stage.getBoundingClientRect();
  const pad = 2 * parseFloat(getComputedStyle(els.stage).paddingLeft || "0");
  const availW = Math.max(64, stageRect.width - pad);
  const availH = Math.max(64, stageRect.height - pad);
  const fit = Math.min(availW / unscaled.width, availH / unscaled.height);
  const viewport = page.getViewport({ scale: fit * dpr });

  els.canvas.width = Math.floor(viewport.width);
  els.canvas.height = Math.floor(viewport.height);
  els.canvas.style.width = Math.floor(viewport.width / dpr) + "px";
  els.canvas.style.height = Math.floor(viewport.height / dpr) + "px";

  // Paint an opaque white "paper" base before rendering, like the official PDF.js viewer:
  // an { alpha: false } canvas is otherwise uninitialized where a page paints no background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);

  const task = page.render({ canvasContext: ctx, viewport, background: "#ffffff" });
  try {
    await task.promise;
  } catch (e) {
    if (e?.name === "RenderingCancelledException") return;
    throw e;
  }
  if (token !== renderToken) return;
  els.canvas.classList.add("ready");
}

function preload(num) {
  // Warm neighbours so flips feel instant; ignore failures silently.
  [num + 1, num - 1].forEach((n) => {
    if (n >= 1 && n <= pageCount && !pageCache.has(n)) getPage(n).catch(() => {});
  });
}

async function goTo(num, { push = true } = {}) {
  if (!pdfDoc) return;
  const target = Math.min(Math.max(1, num), pageCount);
  current = target;
  updateControls();
  if (push) updateHash(target);
  await renderPage(target);
  preload(target);
}

const next = () => goTo(current + 1);
const prev = () => goTo(current - 1);

function showError(msg) {
  els.loader.hidden = true;
  els.errorText.textContent = msg || "Couldn’t load the presentation.";
  els.error.hidden = false;
}

async function load() {
  els.error.hidden = true;
  els.loader.hidden = false;
  els.canvas.classList.remove("ready");
  pageCache.clear();
  try {
    const task = pdfjsLib.getDocument({
      url: PDF_URL,
      // One full download instead of many range requests: fewer round-trips on weak
      // connections, and a single response the service worker can cache cleanly.
      disableRange: true,
      disableAutoFetch: false,
    });
    task.onProgress = ({ loaded, total }) => {
      if (total) els.loaderText.textContent = `Loading… ${Math.round((loaded / total) * 100)}%`;
    };
    pdfDoc = await task.promise;
    pageCount = pdfDoc.numPages;
    els.loader.hidden = true;
    await goTo(pageFromHash(), { push: false });
  } catch (e) {
    console.error(e);
    const msg = /404|not found/i.test(String(e?.message))
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

/* ---------- Re-render on resize / hash / visibility ---------- */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdfDoc) renderPage(current); }, 120);
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
    // The SW found a newer deck in the background; offer a refresh.
    if (e.data && e.data.type === "deck-updated") toast.hidden = false;
  });
}

load();
