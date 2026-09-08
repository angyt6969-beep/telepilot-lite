import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-free-trial-"));
process.env.DATA_DIR = root;
process.env.TELEPILOT_SECURITY_SECRET = "free-trial-regression-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.PUBLIC_URL = "https://telepilot.example";
process.env.TELEPILOT_SUPPORT_USERNAME = "noahxrp";
process.env.TELEPILOT_FREE_TRIAL_CHANNEL_USERNAME = "telepilott";

const mod = await import(`./free-trial.js?test=${Date.now()}`);

try {
  const uid = "123456789";
  const now = Date.now();
  const token = mod.createFreeTrialToken(uid, { now });
  assert.deepEqual(mod.readFreeTrialToken(token, { now: now + 1000 })?.uid, uid, "signed free-trial token should round-trip");
  assert.equal(mod.readFreeTrialToken(`${token.slice(0, -1)}x`, { now: now + 1000 }), null, "tampered token must be rejected");
  assert.equal(mod.readFreeTrialToken(token, { now: now + 3 * 60 * 60_000 }), null, "expired token must be rejected");

  assert.equal(mod.readFreeTrialTutorial(uid).eligible, false, "new users must not start eligible");
  assert.equal(mod.advanceFreeTrialTutorial(uid, 5, { now }).eligible, false, "jumping directly to the final slide must not grant the reward");
  for (const slide of [2, 3, 4]) assert.equal(mod.advanceFreeTrialTutorial(uid, slide, { now }).eligible, false);
  const completed = mod.advanceFreeTrialTutorial(uid, 5, { now });
  assert.equal(completed.eligible, true, "sequential tutorial completion should grant claim eligibility");
  assert.equal(completed.furthestSlide, 5);

  const original = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Redeem Key", callback_data: "redeem_key" }],
        [{ text: "Get / Renew Key", url: "https://t.me/noahxrp" }, { text: "Main Channel", url: "https://t.me/telepilott" }],
        [{ text: "Back", callback_data: "back" }],
      ],
    },
  };
  const decorated = mod.decorateFreeTrialButton(uid, "Access", original, { publicUrl: "https://telepilot.example", now });
  const rows = decorated.other.reply_markup.inline_keyboard;
  assert.equal(rows[2][0].text, "Claim your Free 1 day key!", "free key button must be immediately under the purchase row");
  assert.equal(rows[2][0].icon_custom_emoji_id, "4983746717313664194", "requested premium emoji ID must be preserved");
  const claimUrl = new URL(rows[2][0].url);
  assert.equal(claimUrl.pathname, "/free-trial");
  assert.equal(mod.readFreeTrialToken(claimUrl.searchParams.get("t"), { now: now + 1000 })?.uid, uid, "claim link must be signed and bound to the Telegram user ID");
  const decoratedAgain = mod.decorateFreeTrialButton(uid, "Access", decorated.other, { publicUrl: "https://telepilot.example", now });
  assert.equal(decoratedAgain.other.reply_markup.inline_keyboard.flat().filter(button => button.icon_custom_emoji_id === mod.FREE_TRIAL_EMOJI_ID).length, 1, "UI decoration must be idempotent");

  assert.equal(mod.membershipAllowsFreeTrial({ status: "member" }), true);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "administrator" }), true);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "creator" }), true);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "restricted", is_member: true }), true);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "restricted", is_member: false }), false);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "left" }), false);
  assert.equal(mod.membershipAllowsFreeTrial({ status: "kicked" }), false);

  const deletedHash = await import("node:crypto").then(({ default: crypto }) => crypto.createHash("sha256").update(`telepilot-deleted-user:${uid}`).digest("hex"));
  fs.writeFileSync(path.join(root, "deleted-users.json"), JSON.stringify({ version: 1, users: { [deletedHash]: { deletedAt: now } } }));
  assert.equal(mod.isDeletedForFreeTrial(uid), true, "support deletion marker must block the free-trial web flow");

  console.log("free-trial regression: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
