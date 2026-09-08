import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MAX_INTERVAL_SECONDS,
  formatIntervalSeconds,
  intervalMinutesForCompatibility,
  intervalSecondsFromSettings,
  parseCustomInterval,
} from "./interval-settings.js";
import { __test as referralTest, parseReferralPayload, recordStart, referralCount } from "./referral-system.js";

{
  assert.equal(intervalSecondsFromSettings({ intervalMinutes: 30 }), 1800, "legacy minute settings should migrate to seconds");
  assert.equal(intervalSecondsFromSettings({ intervalSeconds: 45, intervalMinutes: 30 }), 45, "canonical seconds should win over legacy minutes");
  assert.equal(intervalMinutesForCompatibility(30), 0.5, "sub-minute intervals should retain compatibility without rounding");
  assert.deepEqual(parseCustomInterval("15", "seconds"), { ok: true, seconds: 15, unit: "seconds", value: 15 });
  assert.deepEqual(parseCustomInterval("2", "minutes"), { ok: true, seconds: 120, unit: "minutes", value: 2 });
  assert.equal(parseCustomInterval("1.5", "minutes").ok, false, "custom interval input must be a whole number");
  assert.equal(parseCustomInterval(String(MAX_INTERVAL_SECONDS + 1), "seconds").ok, false, "custom interval must stay under the safe timer ceiling");
  assert.equal(formatIntervalSeconds(30), "30s");
  assert.equal(formatIntervalSeconds(90), "1m 30s");
  assert.equal(formatIntervalSeconds(5400), "1h 30m");
}

{
  assert.equal(parseReferralPayload("/start ref_12345"), "12345");
  assert.equal(parseReferralPayload("/start@TelePilottBot ref_987"), "987");
  assert.equal(parseReferralPayload("/start garbage"), "");

  const first = recordStart("200", "/start ref_100", 1000, {
    db: { version: 1, seen: { "100": 1 }, attributions: {} },
    persist: false,
    existed: false,
  });
  assert.equal(first.credited, true, "first eligible referral should be credited");
  assert.equal(first.db.attributions["200"].inviterUid, "100");
  assert.equal(referralCount("100", first.db), 1);

  const duplicate = recordStart("200", "/start ref_300", 2000, {
    db: first.db,
    persist: false,
    existed: false,
    allowUnknownInviter: true,
  });
  assert.equal(duplicate.credited, false, "the same referred user must never be credited twice");
  assert.equal(duplicate.db.attributions["200"].inviterUid, "100", "the original inviter must never be overwritten");

  const self = recordStart("400", "/start ref_400", 3000, {
    db: { version: 1, seen: {}, attributions: {} },
    persist: false,
    existed: false,
    allowUnknownInviter: true,
  });
  assert.equal(self.credited, false, "self-referrals must be blocked");
  assert.equal(self.reason, "self_referral");
  assert.equal(self.db.attributions["400"], undefined);
}

{
  const settingsMarkup = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔔 Notifications", callback_data: "v1_notifications" }],
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }],
      ],
    },
  };
  const placed = referralTest.addReferralButton("⚙️ Settings", settingsMarkup);
  assert.deepEqual(
    placed.reply_markup.inline_keyboard[0].map(button => button.callback_data),
    ["v1_notifications", "referrals"],
    "Referrals should sit directly beside Notifications in Settings",
  );

  const dashboardMarkup = {
    reply_markup: {
      inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "v1_settings_v13" }]],
    },
  };
  const untouched = referralTest.addReferralButton("✈️ TelePilot", dashboardMarkup);
  assert.equal(
    untouched.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "referrals"),
    false,
    "Referrals should no longer be injected on the dashboard",
  );
}

{
  const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /intervalSeconds:\s*state\.intervalSeconds/, "app settings should persist canonical intervalSeconds");
  assert.match(app, /state\.intervalSeconds\s*\*\s*1000/, "interval scheduler should use canonical seconds");
  assert.doesNotMatch(app, /const delayMs = state\.intervalMinutes \* 60_000/, "legacy minute delay must not remain in the canonical scheduler");
  assert.match(app, /interval_custom_seconds/, "seconds custom interval control should exist");
  assert.match(app, /interval_custom_minutes/, "minutes custom interval control should exist");

  const ux = fs.readFileSync(new URL("./ux-v13.js", import.meta.url), "utf8");
  assert.match(ux, /intervalSeconds:\s*intervalSecondsFromSettings\(settings\)/, "saved posting setups should preserve canonical seconds");
  assert.match(ux, /intervalSeconds:\s*intervalSecondsFromSettings\(snapshot\)/, "saved posting setups should restore canonical seconds");
}

console.log("Referral + custom interval regression tests passed");
