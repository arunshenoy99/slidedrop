// Flatten a PDF to one opaque raster image per page using Ghostscript.
//
// Why: decks exported from "print to PDF" (Skia/PDF) use gradient + soft-mask
// backgrounds. PDF.js composites those at render time, and some GPU-accelerated
// canvas stacks (desktop Chromium, iOS Safari) corrupt that compositing into a
// pink/magenta wash — even though the PDF itself is correct. Flattening removes
// all transparency/shading, leaving a plain RGB image per page that every engine
// draws identically. The viewer code stays unchanged.
//
// Usage: node scripts/flatten.mjs <input.pdf> [--out <output.pdf>] [--dpi <n>]
//   default dpi: 200 (≈4000px wide for 16:9 slides — crisp, still ~2–3 MB)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function fail(msg) {
  console.error("flatten: " + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dpi: 200, out: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dpi") args.dpi = parseInt(argv[++i], 10);
    else if (a === "--out") args.out = argv[++i];
    else if (!args.input) args.input = a;
  }
  return args;
}

function ensureGhostscript() {
  const r = spawnSync("gs", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    fail(
      "Ghostscript ('gs') is required but was not found.\n" +
        "  macOS:  brew install ghostscript\n" +
        "  Debian/Ubuntu:  sudo apt install ghostscript\n" +
        "  Windows:  https://ghostscript.com/releases/gsdnld.html"
    );
  }
}

export function flatten(input, { dpi = 200, out = null } = {}) {
  if (!input) fail("no input PDF given. Usage: node scripts/flatten.mjs <input.pdf>");
  if (!existsSync(input)) fail(`input not found: ${input}`);
  if (!Number.isFinite(dpi) || dpi < 50 || dpi > 600) fail(`--dpi must be 50–600 (got ${dpi})`);
  ensureGhostscript();

  const output =
    out || join(dirname(input), basename(input).replace(/\.pdf$/i, "") + ".flattened.pdf");

  const r = spawnSync(
    "gs",
    [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-sDEVICE=pdfimage24", // each page -> one opaque 24-bit RGB image
      `-r${dpi}`,
      "-o",
      output,
      input,
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (r.status !== 0) fail("Ghostscript failed to flatten the PDF.");
  return output;
}

// Run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { input, dpi, out } = parseArgs(process.argv.slice(2));
  const output = flatten(input, { dpi, out });
  console.log(output); // print path so it can be piped / drag-dropped
}
