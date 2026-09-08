import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function retirePendingAddlistFallbacksForState(state) {
  const next = state && typeof state === "object" ? structuredClone(state) : {};
  next.tasks = next.tasks && typeof next.tasks === "object" ? next.tasks : {};
  let removed = 0;
  for (const [key, task] of Object.entries(next.tasks)) {
    if (task?.status === "done") continue;
    if (task?.candidate?.sourceKind !== "addlist") continue;
    delete next.tasks[key];
    removed++;
  }
  next.accountNextAt = next.accountNextAt && typeof next.accountNextAt === "object" ? next.accountNextAt : {};
  const pendingAccounts = new Set(Object.values(next.tasks)
    .filter(task => task?.status === "pending")
    .map(task => String(task?.accountId || ""))
    .filter(Boolean));
  for (const accountId of Object.keys(next.accountNextAt)) if (!pendingAccounts.has(accountId)) delete next.accountNextAt[accountId];
  if (removed) next.updatedAt = Date.now();
  return { state: next, removed };
}

export function retirePendingAddlistFallbacks() {
  let users = [];
  try { users = fs.readdirSync(USERS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return 0; }
  let total = 0;
  for (const uid of users) {
    const file = path.join(USERS_DIR, uid, "destination-join-v1.json");
    if (!fs.existsSync(file)) continue;
    const current = readJson(file, null);
    if (!current) continue;
    const result = retirePendingAddlistFallbacksForState(current);
    if (!result.removed) continue;
    writeJsonAtomic(file, result.state);
    total += result.removed;
  }
  return total;
}

const retired = retirePendingAddlistFallbacks();
if (retired) console.log(`TelePilot retired ${retired} stale one-by-one Addlist fallback task(s)`);
