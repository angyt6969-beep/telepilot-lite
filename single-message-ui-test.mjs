import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-single-ui-"));
process.env.DATA_DIR = root;

const mod = await import(`./single-message-ui.js?test=${Date.now()}`);

try {
  const redeem = mod.redeemKeyPromptPayload("linear_tutorial:5");
  assert.equal(redeem.other.parse_mode, "HTML");
  assert.match(redeem.text, /<b><i>Redeem your TelePilot key<\/i><\/b>/);
  assert.match(redeem.text, /<b>Key format:<\/b> — <code>TP-XXXXX-XXXXX-XXXXX-XXXXX<\/code>/);
  assert.match(redeem.text, /paste your <b><i>full key<\/i><\/b> directly into this chat/);
  assert.equal(redeem.other.reply_markup.inline_keyboard.length, 1, "redeem prompt must only have one button row");
  assert.equal(redeem.other.reply_markup.inline_keyboard[0].length, 1, "redeem prompt must only have a Back button");
  assert.equal(redeem.other.reply_markup.inline_keyboard[0][0].text, "Back");
  assert.equal(redeem.other.reply_markup.inline_keyboard[0][0].callback_data, "linear_tutorial:5");
  assert.match(String(redeem.other.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id), /^\d+$/, "Back must keep a premium emoji ID");

  mod.__test.captureCallback({
    callbackQuery: {
      data: "redeem_key",
      message: { message_id: 77, chat: { id: 123456789 }, text: "✈️ You're ready\nSlide 5 of 5" },
    },
  });
  assert.equal(mod.__test.ACTIVE_UI.get("123456789"), 77, "pressed UI message should become the active panel");
  assert.equal(mod.__test.REDEEM_BACK.get("123456789"), "linear_tutorial:5", "tutorial redeem Back should return to slide 5");

  const transformed = mod.transformTelePilotOutgoing(
    123456789,
    "🔑 REDEEM KEY\n\nSend your TelePilot access key below.\n\nExample: TP-XXXXX-XXXXX-XXXXX-XXXXX",
    { reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "access" }]] } },
  );
  assert.equal(transformed.other.reply_markup.inline_keyboard.length, 1);
  assert.equal(transformed.other.reply_markup.inline_keyboard[0][0].callback_data, "linear_tutorial:5");

  assert.equal(mod.isStandaloneError("❌ Invalid key."), true);
  assert.equal(mod.isStandaloneError("⚠️ Telegram could not verify this destination."), true);
  assert.equal(mod.isStandaloneError("✅ Access activated."), false);

  class FakeApi {
    constructor() {
      this.sent = [];
      this.edits = [];
      this.nextId = 100;
      this.throwNotModified = false;
    }
    async sendMessage(chatId, text, other) {
      const message = { message_id: this.nextId++, chat: { id: Number(chatId) }, text, reply_markup: other?.reply_markup };
      this.sent.push({ chatId, text, other, message });
      return message;
    }
    async editMessageText(chatId, messageId, text, other) {
      if (this.throwNotModified) {
        const err = new Error("Bad Request: message is not modified");
        err.description = "Bad Request: message is not modified";
        throw err;
      }
      const message = { message_id: Number(messageId), chat: { id: Number(chatId) }, text, reply_markup: other?.reply_markup };
      this.edits.push({ chatId, messageId: Number(messageId), text, other, message });
      return message;
    }
  }

  mod.__test.forget("222222222");
  mod.installSingleMessageUiApi(FakeApi);
  const api = new FakeApi();

  const first = await api.sendMessage(222222222, "✈️ TelePilot", {
    reply_markup: { inline_keyboard: [[{ text: "Destinations", callback_data: "destinations" }]] },
  });
  assert.equal(api.sent.length, 1, "first UI panel should be sent normally");
  assert.equal(first.message_id, 100);

  const second = await api.sendMessage(222222222, "📁 Destinations", {
    reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "home" }]] },
  });
  assert.equal(api.sent.length, 1, "second private UI screen must not stack a new bot message");
  assert.equal(api.edits.length, 1, "second private UI screen must edit the existing panel");
  assert.equal(api.edits[0].messageId, 100);
  assert.equal(second.message_id, 100);

  await api.sendMessage(222222222, "Plain private status update without buttons.");
  assert.equal(api.sent.length, 1, "plain non-error private bot messages must also reuse the single panel");
  assert.equal(api.edits.length, 2);

  await api.sendMessage(222222222, "❌ Destination import failed.");
  assert.equal(api.sent.length, 2, "standalone errors are the only private messages allowed to stack");
  assert.equal(api.edits.length, 2);

  api.throwNotModified = true;
  const same = await api.editMessageText(222222222, 100, "Plain private status update without buttons.", {});
  assert.equal(same.message_id, 100, "message-not-modified must be swallowed so legacy catch blocks cannot create duplicates");

  const persisted = JSON.parse(fs.readFileSync(path.join(root, "ui-message-state.json"), "utf8"));
  assert.equal(Number(persisted.messages["222222222"]), 100, "active UI message ID should survive process restarts");

  console.log("single-message UI regression: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
