import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { tutorialScreen } from "./linear-onboarding-v4.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const USERS_DIR = path.join(DATA_DIR, "users");

function readJson(file, fallback = {}) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) {
      if (/^\d+$/.test(part)) ids.add(part);
    }
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const id of Array.isArray(persisted?.adminIds) ? persisted.adminIds : []) {
    if (/^\d+$/.test(String(id))) ids.add(String(id));
  }
  return ids;
}

export function tutorialAccessActive(uid) {
  const id = String(uid || "");
  if (!/^\d+$/.test(id)) return false;
  if (adminIds().has(id)) return true;
  const saved = readJson(path.join(USERS_DIR, id, "settings.json"), {});
  if (saved.accessRevoked === true) return false;
  if (saved.accessLifetime === true) return true;
  return Number(saved.accessUntil || 0) > Date.now();
}

async function renderTutorialSlide(ctx, slide) {
  const screen = tutorialScreen({
    slide,
    accessActive: tutorialAccessActive(ctx?.from?.id),
  });
  try {
    await ctx.answerCallbackQuery();
  } catch {}
  if (ctx.callbackQuery?.message) {
    try {
      return await ctx.editMessageText(screen.text, screen.other);
    } catch (err) {
      const message = String(err?.description || err?.message || "").toLowerCase();
      if (message.includes("message is not modified")) return;
    }
  }
  return ctx.reply(screen.text, screen.other);
}

export function installTutorialNavigationPriority(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotTutorialNavigationPriorityInstalled) return false;
  const originalCommand = BotClass.prototype.command;
  if (typeof originalCommand !== "function") throw new Error("Unsupported grammY Bot shape for tutorial navigation priority");

  Object.defineProperty(BotClass.prototype, "__telepilotTutorialNavigationPriorityInstalled", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    if (command === "start" && !this.__telepilotTutorialNavigationPriorityBound) {
      Object.defineProperty(this, "__telepilotTutorialNavigationPriorityBound", { value: true });
      this.callbackQuery(/^linear_tutorial:([1-5])$/, async ctx => {
        return renderTutorialSlide(ctx, Number(ctx.match?.[1] || 1));
      });
    }
    return originalCommand.call(this, command, ...middleware);
  };
  return true;
}

installTutorialNavigationPriority(Bot);
