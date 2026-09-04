import { Bot } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const profileBot = new Bot(BOT_TOKEN);

const description = [
  "👋 Welcome to TelePilot",
  "",
  "Automate your Telegram posting, manage your account, groups and message, choose an interval, and run everything from one simple dashboard. ✈️",
  "",
  "Tap Start to get started.",
].join("\n");

const shortDescription = "Automate Telegram posting from one simple dashboard ✈️";

try {
  await profileBot.api.raw.setMyDescription({ description });
  await profileBot.api.raw.setMyShortDescription({ short_description: shortDescription });
  console.log("TelePilot bot description updated");
} catch (err) {
  console.error("Could not update TelePilot bot description:", err?.message || err);
}

await import("./app.js");
