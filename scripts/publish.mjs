// Flatten a deck and upload it to R2 as "<name>.pdf" — the whole publish step.
// The deck then lives at /<name> in the viewer (or "/" for the default name "deck").
//
// Usage:
//   node scripts/publish.mjs <input.pdf>                       # name from filename, prod R2
//   node scripts/publish.mjs <input.pdf> --name meetup          # explicit deck name
//   node scripts/publish.mjs <input.pdf> --name wpblr/meetup    # nested ("folder") deck
//   node scripts/publish.mjs <input.pdf> --local                # seed the local dev R2
//   node scripts/publish.mjs <input.pdf> --dpi 150              # override raster resolution
//
// Flattening (see scripts/flatten.mjs) is what prevents the pink/magenta render bug.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmSync } from "node:fs";
import { flatten } from "./flatten.mjs";

const BUCKET = "slidedrop-deck"; // matches wrangler.toml

// The deck name is the R2 key (minus ".pdf") and the URL path; it may be nested with "/".
// Keep each segment in lockstep with the allowlist enforced by functions/d/[[path]].js so
// a published deck is actually servable.
const SEG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DEPTH = 8;
function normalizeName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .split("/")
    .map((s) => s.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/");
}
function validName(name) {
  const segs = name.split("/");
  return segs.length >= 1 && segs.length <= MAX_DEPTH && segs.every((s) => SEG_RE.test(s));
}

const argv = process.argv.slice(2);
const local = argv.includes("--local");
const dpiIdx = argv.indexOf("--dpi");
const dpi = dpiIdx !== -1 ? parseInt(argv[dpiIdx + 1], 10) : 200;
const nameIdx = argv.indexOf("--name");
const flagValueIdxs = new Set([dpiIdx + 1, nameIdx + 1].filter((i) => i > 0));
const input = argv.find((a, i) => !a.startsWith("--") && !flagValueIdxs.has(i));

if (!input) {
  console.error(
    "publish: usage: node scripts/publish.mjs <input.pdf> [--name <slug>] [--local] [--dpi <n>]"
  );
  process.exit(1);
}

const name = normalizeName(nameIdx !== -1 ? argv[nameIdx + 1] : basename(input)) || "deck";
if (!validName(name)) {
  console.error(
    `publish: invalid deck name "${name}" (lowercase letters, digits, hyphens; "/" for folders).`
  );
  process.exit(1);
}
const R2_TARGET = `${BUCKET}/${name}.pdf`;

const out = join(tmpdir(), `slidedrop-${name}.flattened.pdf`);
flatten(input, { dpi, out });

const args = [
  "wrangler",
  "r2",
  "object",
  "put",
  R2_TARGET,
  local ? "--local" : "--remote",
  "--file",
  out,
];
console.log(
  `Uploading flattened deck "${name}" to ${local ? "local" : "production"} R2 (${R2_TARGET})…\n` +
    `  → it will be live at /${name === "deck" ? "" : name}`
);
const r = spawnSync("npx", args, { stdio: "inherit" });
try {
  rmSync(out, { force: true });
} catch {}
process.exit(r.status ?? 1);
