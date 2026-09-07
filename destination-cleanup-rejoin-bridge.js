import fs from "node:fs";
import path from "node:path";
import { runDestinationPreparationTick } from "./destination-preparation-v1.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const WORKER_INTERVAL_MS = 2_000;

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
function joinPath(uid) { return path.join(USERS_DIR, String(uid), "destination-join-v1.json"); }
function cleanupPath(uid) { return path.join(USERS_DIR, String(uid), "destination-preparation-v1.json"); }
function freshStep() { return { status: "pending", attempts: 0, nextAt: 0, lastError: "" }; }

export function rearmStaleCleanupState(joinState, cleanupState, now = Date.now()) {
  const joinTasks = joinState?.tasks && typeof joinState.tasks === "object" ? joinState.tasks : {};
  const cleanupTasks = cleanupState?.tasks && typeof cleanupState.tasks === "object" ? cleanupState.tasks : {};
  let rearmed = 0;

  for (const [key, joinTask] of Object.entries(joinTasks)) {
    if (joinTask?.status !== "done") continue;
    const cleanupTask = cleanupTasks[key];
    if (!cleanupTask) continue;

    const joinedAt = Number(joinTask?.updatedAt || 0);
    const cleanupAt = Number(cleanupTask?.updatedAt || 0);
    if (!joinedAt || joinedAt <= cleanupAt) continue;

    // A confirmed join happened after this cleanup record was last touched.
    // Any old mute/archive completion belongs to the previous membership and
    // must be applied again to the freshly joined chat.
    cleanupTask.mute = freshStep();
    cleanupTask.archive = freshStep();
    cleanupTask.updatedAt = now;
    rearmed++;
  }

  return rearmed;
}

export function rearmCleanupForUser(uid) {
  const joinFile = joinPath(uid);
  const cleanupFile = cleanupPath(uid);
  if (!fs.existsSync(joinFile) || !fs.existsSync(cleanupFile)) return 0;

  const joinState = readJson(joinFile, {});
  const cleanupState = readJson(cleanupFile, {});
  const rearmed = rearmStaleCleanupState(joinState, cleanupState);
  if (!rearmed) return 0;

  cleanupState.version = Math.max(1, Number(cleanupState.version || 0));
  cleanupState.updatedAt = Date.now();
  writeJsonAtomic(cleanupFile, cleanupState);
  console.log(`TelePilot cleanup rearmed after fresh join for ${uid}: ${rearmed} destination(s)`);
  void runDestinationPreparationTick();
  return rearmed;
}

let running = false;
export async function runCleanupRejoinBridgeTick() {
  if (running) return;
  running = true;
  try {
    let userIds = [];
    try {
      userIds = fs.readdirSync(USERS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return;
    }
    for (const uid of userIds) rearmCleanupForUser(uid);
  } finally {
    running = false;
  }
}

let timer = null;
export function startCleanupRejoinBridge() {
  if (timer) return timer;
  timer = setInterval(() => void runCleanupRejoinBridgeTick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void runCleanupRejoinBridgeTick(), 500).unref?.();
  console.log("TelePilot cleanup rejoin bridge enabled (stale completion repair only)");
  return timer;
}
