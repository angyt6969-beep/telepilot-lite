import assert from "node:assert/strict";
import { installTutorialNavigationPriority } from "./tutorial-navigation-priority.js";

class FakeBot {
  constructor() {
    this.registered = [];
  }
  command(name, ...middleware) {
    this.registered.push({ type: "command", name, middleware });
    return this;
  }
  callbackQuery(pattern, handler) {
    this.registered.push({ type: "callback", pattern, handler });
    return this;
  }
}

assert.equal(installTutorialNavigationPriority(FakeBot), true);
const bot = new FakeBot();
bot.command("start", async () => {});

const callback = bot.registered.find(entry => entry.type === "callback");
const command = bot.registered.find(entry => entry.type === "command" && entry.name === "start");
assert.ok(callback, "tutorial callback should be bound when /start is registered");
assert.ok(command, "start command should still be registered");
assert.ok(bot.registered.indexOf(callback) < bot.registered.indexOf(command), "tutorial callback must be registered before the app access gate is added later");
assert.equal(callback.pattern.test("linear_tutorial:2"), true);
assert.equal(callback.pattern.test("linear_tutorial:5"), true);
assert.equal(callback.pattern.test("linear_tutorial:6"), false);
assert.equal(callback.pattern.test("account"), false);
assert.equal(callback.pattern.test("v1_dashboard_v13"), false);

let answered = 0;
let edited = null;
const ctx = {
  from: { id: 12345 },
  match: ["linear_tutorial:2", "2"],
  callbackQuery: { message: { message_id: 77 } },
  answerCallbackQuery: async () => { answered += 1; },
  editMessageText: async (text, other) => { edited = { text, other }; },
  reply: async () => { throw new Error("reply fallback should not be needed"); },
};
await callback.handler(ctx);
assert.equal(answered, 1);
assert.ok(edited, "slide navigation should edit the existing tutorial message");
assert.match(edited.text, /Choose your sender/);
assert.match(edited.text, /Slide 2 of 5/);
assert.doesNotMatch(edited.text, /Redeem TelePilot Key/);
assert.equal(edited.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "linear_tutorial:3"), true);

console.log("tutorial navigation priority regression tests passed");
