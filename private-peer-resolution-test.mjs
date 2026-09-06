import assert from "node:assert/strict";
import fs from "node:fs";

const { installPrivatePeerResolution } = await import("./private-peer-resolution.js");

class FakeClient {
  async getEntity(value) {
    if (String(value).startsWith("@")) return { id: 55, username: String(value).slice(1) };
    throw new Error("Could not find the input entity");
  }
  async getDialogs() {
    return [
      { entity: { id: "2000383834", title: "Private Addlist group", accessHash: "123" } },
      { entity: { id: "999", title: "Other" } },
    ];
  }
}

installPrivatePeerResolution(FakeClient);
const client = new FakeClient();
const privateEntity = await client.getEntity("-1002000383834");
assert.equal(String(privateEntity.id), "2000383834", "Private -100 channel ids should resolve from joined dialogs");
const publicEntity = await client.getEntity("@publicgroup");
assert.equal(publicEntity.username, "publicgroup", "Normal entity resolution must remain unchanged");
await assert.rejects(() => client.getEntity("-1001234567890"), /Could not find the input entity/);

const source = fs.readFileSync("private-peer-resolution.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
assert.match(source, /getDialogs\(\{ limit: 1000 \}\)/, "Fallback must use the connected account's dialogs so access hashes are available");
assert.match(startup, /installPrivatePeerResolution\(TelegramClient\)/, "Private peer fallback is not installed");

console.log("TelePilot private peer resolution checks passed");
