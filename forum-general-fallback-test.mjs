import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-forum-general-"));
process.env.DATA_DIR = temp;
const userDir = path.join(temp, "users", "123456");
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
  groups: [
    { id: "-1001", label: "Forum A", topicRequired: true, topicId: null, topicTitle: "", joinStatus: "needs_topic", accountJoin: { a1: { status: "ready" } } },
    { id: "-1002", label: "Forum B", topicRequired: true, topicId: 42, topicTitle: "Ads", joinStatus: "ready", accountJoin: { a1: { status: "ready" } } },
    { id: "-1003", label: "Normal", topicRequired: false, topicId: null, joinStatus: "ready", accountJoin: { a1: { status: "ready" } } },
  ],
}, null, 2));

const { applyForumGeneralFallback } = await import("./forum-general-fallback.js");
assert.equal(applyForumGeneralFallback("123456"), 1, "Only an unresolved forum should receive the General fallback");
const settings = JSON.parse(fs.readFileSync(path.join(userDir, "settings.json"), "utf8"));
const a = settings.groups.find(group => group.id === "-1001");
const b = settings.groups.find(group => group.id === "-1002");
const normal = settings.groups.find(group => group.id === "-1003");
assert.equal(a.topicId, 1, "General forum topic must use Telegram topic id 1");
assert.equal(a.topicTitle, "General");
assert.equal(a.autoGeneralTopic, true);
assert.equal(a.joinStatus, "ready", "General fallback must stop forum groups from blocking posting");
assert.equal(b.topicId, 42, "A manually selected custom topic must never be overwritten");
assert.equal(normal.topicId, null, "Normal groups must not be modified");

const source = fs.readFileSync("forum-general-fallback.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
assert.match(source, /trigger === "v1_topics_v13" \|\| trigger === "dest_topics"/, "Opening Topics must still expose custom topic selection");
assert.match(startup, /installForumGeneralFallback\(Bot\)/);
assert.match(startup, /startForumGeneralFallbackWorker\(\)/);

console.log("TelePilot forum General fallback checks passed");
