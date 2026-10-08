// Fails CI when a client chunk grows past its budget, so a large import cannot slip in unnoticed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const KB = 1024;
const ENTRY_BUDGET = 400 * KB; // Loaded on every page, including the public marketing pages.
const CHUNK_BUDGET = 500 * KB; // Loaded on demand (studio screens, video export library).

const html = readFileSync("dist/index.html", "utf8");
const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
if (!entry) {
  console.error("Could not find the entry script in dist/index.html");
  process.exit(1);
}
let failed = false;
for (const file of readdirSync("dist/assets").filter((f) => f.endsWith(".js"))) {
  const size = statSync(join("dist/assets", file)).size;
  const budget = file === entry ? ENTRY_BUDGET : CHUNK_BUDGET;
  if (size > budget) {
    console.error(`${file}: ${Math.round(size / KB)} kB exceeds the ${budget / KB} kB budget`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Client chunks are within budget (entry ${entry}).`);
