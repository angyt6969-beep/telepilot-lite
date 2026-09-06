import fs from "node:fs";
import path from "node:path";
import { listUserIds } from "./posting-engine-enhancements.js";

const DATA_DIR = process.env.DATA_DIR || "/data";

export function retireLegacyDestinationState() {
  let retired = 0;
  for (const uid of listUserIds()) {
    const dir = path.join(DATA_DIR, "users", String(uid));
    const legacy = path.join(dir, "destination-automation.json");
    const backup = path.join(dir, "destination-automation.legacy-v1.json");
    try {
      if (!fs.existsSync(legacy)) continue;
      if (!fs.existsSync(backup)) fs.renameSync(legacy, backup);
      else fs.unlinkSync(legacy);
      retired++;
    } catch (err) {
      console.warn(`Could not retire legacy destination runtime state for ${uid}: ${String(err?.message || err).slice(0, 140)}`);
    }
  }
  if (retired) console.log(`TelePilot Destinations v2 retired ${retired} legacy runtime state file(s)`);
  return retired;
}
