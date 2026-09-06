import { listUserIds, readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const WORKER_INTERVAL_MS = 3_000;

function joinedStatus(group) {
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return "ready";
  if (rows.every(row => String(row?.status || "") === "ready")) return "ready";
  if (rows.some(row => String(row?.status || "") === "ready")) return "partial";
  if (rows.some(row => String(row?.status || "") === "pending")) return "pending";
  if (rows.some(row => String(row?.status || "") === "verification")) return "verification";
  if (rows.some(row => String(row?.status || "") === "read_only")) return "read_only";
  return "failed";
}

export function applyForumGeneralFallback(uid) {
  const id = String(uid || "");
  if (!id) return 0;
  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  let changed = 0;
  for (const group of groups) {
    if (group?.topicRequired !== true || Number(group?.topicId || 0) > 0) continue;
    group.topicId = 1;
    group.topicTitle = "General";
    group.autoGeneralTopic = true;
    group.joinStatus = joinedStatus(group);
    changed++;
  }
  if (!changed) return 0;
  writeAppSettings(id, { ...settings, groups });
  syncUserGroups(id);
  return changed;
}

function reopenAutoGeneralForTopicPicker(uid) {
  const id = String(uid || "");
  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  let changed = 0;
  for (const group of groups) {
    if (group?.topicRequired !== true || group?.autoGeneralTopic !== true || Number(group?.topicId || 0) !== 1) continue;
    group.topicId = null;
    group.topicTitle = "";
    group.joinStatus = "needs_topic";
    changed++;
  }
  if (changed) {
    writeAppSettings(id, { ...settings, groups });
    syncUserGroups(id);
  }
  return changed;
}

export function installForumGeneralFallback(BotClass) {
  const proto = BotClass?.prototype;
  if (!proto || proto.__telepilotForumGeneralFallbackInstalled) return;
  const originalCallbackQuery = proto.callbackQuery;
  if (typeof originalCallbackQuery !== "function") throw new Error("Unsupported grammY Bot shape for forum fallback");
  Object.defineProperty(proto, "__telepilotForumGeneralFallbackInstalled", { value: true });
  proto.callbackQuery = function(trigger, handler, ...rest) {
    const isTopicIndex = trigger === "v1_topics_v13" || trigger === "dest_topics";
    if (!isTopicIndex || typeof handler !== "function") return originalCallbackQuery.call(this, trigger, handler, ...rest);
    return originalCallbackQuery.call(this, trigger, async ctx => {
      reopenAutoGeneralForTopicPicker(String(ctx.from?.id || ""));
      return handler(ctx);
    }, ...rest);
  };
}

let timer = null;
let busy = false;
export function startForumGeneralFallbackWorker() {
  if (timer) return timer;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      for (const uid of listUserIds()) {
        try { applyForumGeneralFallback(uid); }
        catch (err) { console.warn(`Forum General fallback failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(tick, WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 2_500).unref?.();
  console.log("TelePilot forum General fallback enabled (custom topics remain optional)");
  return timer;
}
