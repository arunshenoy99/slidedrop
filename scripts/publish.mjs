// Flatten a deck and upload it to R2 as the live "deck.pdf" — the whole publish step.
//
// Usage:
//   node scripts/publish.mjs <input.pdf>            # upload to production R2
//   node scripts/publish.mjs <input.pdf> --local    # seed the local dev R2 instead
//   node scripts/publish.mjs <input.pdf> --dpi 150   # override raster resolution
//
// Flattening (see scripts/flatten.mjs) is what prevents the pink/magenta render bug.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { flatten } from "./flatten.mjs";

const R2_TARGET = "slidedrop-deck/deck.pdf"; // bucket/key (matches wrangler.toml)

const argv = process.argv.slice(2);
const local = argv.includes("--local");
const dpiIdx = argv.indexOf("--dpi");
const dpi = dpiIdx !== -1 ? parseInt(argv[dpiIdx + 1], 10) : 200;
const input = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--dpi");

if (!input) {
  console.error("publish: usage: node scripts/publish.mjs <input.pdf> [--local] [--dpi <n>]");
  process.exit(1);
}

const out = join(tmpdir(), "slidedrop-deck.flattened.pdf");
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
console.log(`Uploading flattened deck to ${local ? "local" : "production"} R2 (${R2_TARGET})…`);
const r = spawnSync("npx", args, { stdio: "inherit" });
try {
  rmSync(out, { force: true });
} catch {}
process.exit(r.status ?? 1);
