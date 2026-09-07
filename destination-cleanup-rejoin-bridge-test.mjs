import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./destination-cleanup-rejoin-bridge.js", import.meta.url), "utf8");
const startup = fs.readFileSync(new URL("./startup.js", import.meta.url), "utf8");
assert.match(source, /rearmStaleCleanupState/);
assert.match(startup, /startCleanupRejoinBridge\(\)/);

const mod = await import(`./destination-cleanup-rejoin-bridge.js?test=${Date.now()}`);

// Exact regression: cleanup completed on an older membership, then the join
// queue confirms a fresh rejoin later. Old completion must be invalidated once.
const joinState = {
  tasks: {
    "legacy:-1001": {
      accountId: "legacy",
      candidate: { id: "-1001", forum: true },
      status: "done",
      updatedAt: 20_000,
    },
  },
};
const cleanupState = {
  tasks: {
    "legacy:-1001": {
      accountId: "legacy",
      peer: { id: "-1001" },
      mute: { status: "done", attempts: 0, nextAt: 0, lastError: "" },
      archive: { status: "done", attempts: 0, nextAt: 0, lastError: "" },
      updatedAt: 10_000,
    },
  },
};
assert.equal(mod.rearmStaleCleanupState(joinState, cleanupState, 30_000), 1);
assert.equal(cleanupState.tasks["legacy:-1001"].mute.status, "pending");
assert.equal(cleanupState.tasks["legacy:-1001"].archive.status, "pending");
assert.equal(cleanupState.tasks["legacy:-1001"].updatedAt, 30_000);

// Once cleanup has run after the fresh join, it must never rearm again.
cleanupState.tasks["legacy:-1001"].mute.status = "done";
cleanupState.tasks["legacy:-1001"].archive.status = "done";
cleanupState.tasks["legacy:-1001"].updatedAt = 40_000;
assert.equal(mod.rearmStaleCleanupState(joinState, cleanupState, 50_000), 0);
assert.equal(cleanupState.tasks["legacy:-1001"].mute.status, "done");
assert.equal(cleanupState.tasks["legacy:-1001"].archive.status, "done");

// Pending/non-confirmed joins cannot invalidate cleanup state.
const pendingJoin = {
  tasks: {
    "legacy:-1002": { accountId: "legacy", candidate: { id: "-1002" }, status: "pending", updatedAt: 99_000 },
  },
};
const oldCleanup = {
  tasks: {
    "legacy:-1002": {
      accountId: "legacy",
      peer: { id: "-1002" },
      mute: { status: "done" },
      archive: { status: "done" },
      updatedAt: 1_000,
    },
  },
};
assert.equal(mod.rearmStaleCleanupState(pendingJoin, oldCleanup, 100_000), 0);

console.log("TelePilot cleanup rejoin bridge checks passed");
