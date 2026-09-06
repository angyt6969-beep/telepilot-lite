import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-live-"));
process.env.DATA_DIR = temp;

const {
  installAddlistLiveStatus,
  installAddlistLiveProgressUi,
  recentAddlistLiveStatus,
  renderAddlistLiveText,
} = await import(`./addlist-live-progress.js?test=${Date.now()}`);

class FakeTelegramClient {
  async invoke(request) {
    if (request?.slug === "broken_folder") throw new Error("TEST_ADDLIST_ERROR");
    if (request?.className === "chatlists.CheckChatlistInvite") {
      return {
        className: "ChatlistInviteAlready",
        filterId: 1,
        alreadyPeers: [{ channelId: 1 }, { channelId: 2 }],
        missingPeers: [],
      };
    }
    return { ok: true };
  }
}

installAddlistLiveStatus(FakeTelegramClient);
const tg = new FakeTelegramClient();
tg.__telepilotOwnerUid = "123456";
tg.__telepilotAccountId = "tg_test";
await tg.invoke({ className: "chatlists.CheckChatlistInvite", slug: "good_folder" });

const status = recentAddlistLiveStatus("123456");
assert.equal(status?.slug, "good_folder");
assert.equal(status?.total, 2);
assert.equal(status?.confirmed, 2);
assert.match(renderAddlistLiveText("123456", status), /^✅ Addlist import finished/);
assert.match(renderAddlistLiveText("123456", status), /Telegram confirmed — 2 \/ 2/);

const edits = [];
class FakeApi {
  async sendMessage(chatId, text, other) { return { message_id: 77, chatId, text, other }; }
  async editMessageText(chatId, messageId, text, other) {
    edits.push({ chatId, messageId, text, other });
    return { ok: true };
  }
}
installAddlistLiveProgressUi(FakeApi);
const api = new FakeApi();
await api.sendMessage("123456", "✅ Destination import complete\nAdded 0", { reply_markup: { inline_keyboard: [] } });
assert.equal(edits.length, 1, "A completed Addlist should update its exact Telegram status message immediately");
assert.equal(edits[0].messageId, 77);
assert.match(edits[0].text, /^✅ Addlist import finished/);

try {
  await tg.invoke({ className: "chatlists.CheckChatlistInvite", slug: "broken_folder" });
  assert.fail("Expected test Addlist error");
} catch {}
const failed = recentAddlistLiveStatus("123456");
assert.equal(failed?.slug, "broken_folder");
assert.match(failed?.lastError || "", /TEST_ADDLIST_ERROR/);
assert.match(renderAddlistLiveText("123456", failed), /^⚠️ Addlist import needs attention/);

console.log("TelePilot Addlist live progress checks passed");
