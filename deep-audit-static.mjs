import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const names = fs.readdirSync(root);
const prod = names.filter(name => name.endsWith(".js")).sort();
const mjs = names.filter(name => name.endsWith(".mjs")).sort();
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const texts = new Map(prod.map(name => [name, read(name)]));

console.log("=== REPOSITORY SHAPE ===");
console.log("Production JS files:", prod.length);
console.log("MJS files:", mjs.length);
const loc = [...prod, ...mjs].reduce((sum, name) => sum + read(name).split("\n").length, 0);
console.log("Approx JS/MJS LOC:", loc);
console.log("Largest production files:");
for (const name of [...prod].sort((a, b) => fs.statSync(b).size - fs.statSync(a).size).slice(0, 20)) {
  console.log(`  ${name}: ${fs.statSync(name).size} bytes`);
}

const pkg = JSON.parse(read("package.json"));
const start = pkg.scripts?.start || "";
const preloads = [...start.matchAll(/--import\s+\.\/([^\s]+)/g)].map(m => m[1]);
console.log("\n=== STARTUP PRELOADS ===");
for (const item of preloads) console.log(" ", item);
console.log("Preload count:", preloads.length);

const startup = read("startup.js");
const startupImports = [
  ...[...startup.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(m => m[1]),
  ...[...startup.matchAll(/import\(["']\.\/([^"']+)["']\)/g)].map(m => m[1]),
];
console.log("startup.js local imports:", startupImports.length);

const patterns = new Map([
  ["Api sendMessage wrappers", /prototype\.sendMessage\s*=/g],
  ["Api editMessageText wrappers", /prototype\.editMessageText\s*=/g],
  ["Bot start wrappers", /prototype\.start\s*=/g],
  ["Bot API config middleware", /api\.config\.use\s*\(/g],
  ["callbackQuery registrations", /callbackQuery\s*\(/g],
  ["setInterval calls", /\bsetInterval\s*\(/g],
  ["setTimeout calls", /\bsetTimeout\s*\(/g],
  ["direct writeFileSync", /fs\.writeFileSync\s*\(/g],
  ["direct appendFileSync", /fs\.appendFileSync\s*\(/g],
  ["renameSync", /fs\.renameSync\s*\(/g],
  ["empty catch blocks", /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gs],
  ["process.exit", /process\.exit\s*\(/g],
  ["HTTP createServer", /createServer\s*\(/g],
]);

console.log("\n=== CROSS-CUTTING COUNTS ===");
for (const [label, rx] of patterns) {
  const hits = [];
  let total = 0;
  for (const [name, text] of texts) {
    const count = [...text.matchAll(new RegExp(rx.source, rx.flags))].length;
    if (count) { hits.push([name, count]); total += count; }
  }
  console.log(`${label}: ${total} across ${hits.length} files`);
  if (["Api sendMessage wrappers", "Api editMessageText wrappers", "Bot start wrappers", "Bot API config middleware", "empty catch blocks", "direct writeFileSync"].includes(label)) {
    for (const [name, count] of hits.sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30)) console.log(`  ${name}: ${count}`);
  }
}

console.log("\n=== LITERAL CALLBACK OWNERSHIP ===");
const owners = new Map();
const callbackRx = /callbackQuery\s*\(\s*["']([^"']+)["']/g;
for (const [name, text] of texts) {
  for (const match of text.matchAll(callbackRx)) {
    if (!owners.has(match[1])) owners.set(match[1], new Set());
    owners.get(match[1]).add(name);
  }
}
const duplicates = [...owners].filter(([, files]) => files.size > 1).sort((a,b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
console.log("Literal callback IDs:", owners.size);
console.log("Literal callback IDs with >1 owning file:", duplicates.length);
for (const [cb, files] of duplicates.slice(0, 120)) console.log(`  ${cb} => ${[...files].sort().join(", ")}`);

console.log("\n=== TIMER REVIEW ===");
for (const [name, text] of texts) {
  const intervals = (text.match(/setInterval\s*\(/g) || []).length;
  const timeouts = (text.match(/setTimeout\s*\(/g) || []).length;
  if (!intervals && !timeouts) continue;
  const unrefs = (text.match(/\.unref\b/g) || []).length;
  const clears = (text.match(/clearInterval\s*\(|clearTimeout\s*\(/g) || []).length;
  console.log(`  ${name}: interval=${intervals} timeout=${timeouts} unref=${unrefs} clears=${clears}`);
}

console.log("\n=== PERSISTENCE REVIEW ===");
for (const [name, text] of texts) {
  const writes = (text.match(/fs\.writeFileSync\s*\(/g) || []).length;
  const appends = (text.match(/fs\.appendFileSync\s*\(/g) || []).length;
  if (!writes && !appends) continue;
  const renames = (text.match(/fs\.renameSync\s*\(/g) || []).length;
  const atomicHint = text.includes("writeJsonAtomic") || renames > 0;
  console.log(`  ${name}: writes=${writes} appends=${appends} renames=${renames} atomic-helper=${atomicHint}`);
}

console.log("\n=== PRODUCTION FILES WITHOUT OBVIOUS DIRECT TEST ===");
const testNames = new Set(mjs.filter(name => name.includes("test")));
const uncovered = [];
for (const name of prod) {
  const base = name.slice(0, -3);
  const obvious = [...testNames].some(test => test.startsWith(base + "-test") || test === base + ".test.mjs" || test === base + "-tests.mjs");
  if (!obvious) uncovered.push(name);
}
for (const name of uncovered) console.log(" ", name);
console.log("Count without obvious direct test:", uncovered.length);

console.log("\n=== ARCHITECTURE HOTSPOTS ===");
for (const [name, text] of texts) {
  const wrapperCount = (text.match(/prototype\.(?:sendMessage|editMessageText|start)\s*=/g) || []).length;
  const callbackCount = (text.match(/callbackQuery\s*\(/g) || []).length;
  const ioCount = (text.match(/fs\.(?:writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync)\s*\(/g) || []).length;
  if (wrapperCount >= 2 || callbackCount >= 15 || ioCount >= 5) console.log(`  ${name}: wrappers=${wrapperCount} callbacks=${callbackCount} io=${ioCount}`);
}
