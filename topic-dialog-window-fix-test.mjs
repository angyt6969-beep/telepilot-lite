import assert from "node:assert/strict";
import { installPrivatePeerResolution } from "./private-peer-resolution.js";

class FakeTelegramClient {
  constructor() { this.calls = []; }
  async getEntity(value) { throw new Error(`unresolved:${value}`); }
  async getDialogs(params = {}) {
    this.calls.push(params);
    return [];
  }
}

installPrivatePeerResolution(FakeTelegramClient);
const client = new FakeTelegramClient();
await client.getDialogs({ limit: 500, archived: false });
await client.getDialogs({ limit: 50 });

assert.equal(client.calls[0].limit, 1000, "legacy topic lookup should expand from 500 to 1000 dialogs");
assert.equal(client.calls[0].archived, false, "other dialog options must be preserved");
assert.equal(client.calls[1].limit, 50, "unrelated dialog lookups must remain unchanged");
console.log("topic dialog window fix test passed");
