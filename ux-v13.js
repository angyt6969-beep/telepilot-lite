import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  normalizeAccountSelection,
  senderSummary,
  setAccountAlias,
  usesBotSender,
} from "./account-store.js";
import {
  destinationAccountReady,
  handleDestinationText,
  parseDestinationInput,
  processRoutingQueue,
  queueRoutingSync,
  recheckDestinations,
} from "./destination-automation.js";
import {
  listUserIds,
  readAppSettings,
  writeAppSettings,
} from "./posting-engine-enhancements.js";
import { advanceTutorialAfterAction } from "./onboarding.js";
import { intervalMinutesForCompatibility, intervalSecondsFromSettings } from "./interval-settings.js";
import { reloadUserState, syncUserGroups } from "./runtime-hooks.js";
import { queuePreview, readV1, v1Stats, writeV1 } from "./v1-engine.js";
import {
  appendImportHistory,
  clearResume,
  makePresetId,
  nextPresetName,
  patchQolState,
  readQolState,
  setDestinationNote,
  setPendingInput,
  setResume,
  writeQolState,
} from "./qol-store.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const AUTOMATION_FILE = "destination-automation.json";
const MAX_LIST = 10;
const INPUT_TTL_MS = 30 * 60_000;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function automationPath(uid) { return path.join(userDir(uid), AUTOMATION_FILE); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readAutomation(uid) {
  const raw = readJson(automationPath(uid), {});
  return {
    version: Number(raw?.version || 1) || 1,
    topicQueue: Array.isArray(raw?.topicQueue) ? raw.topicQueue : [],
    unresolvedInvites: Array.isArray(raw?.unresolvedInvites) ? raw.unresolvedInvites : [],
    routingQueue: Array.isArray(raw?.routingQueue) ? raw.routingQueue : [],
    lastWorkerAt: Number(raw?.lastWorkerAt || 0) || 0,
  };
}
function writeAutomation(uid, value) {
  writeJsonAtomic(automationPath(uid), {
    version: Number(value?.version || 1) || 1,
    topicQueue: Array.isArray(value?.topicQueue) ? value.topicQueue.slice(-500) : [],
    unresolvedInvites: Array.isArray(value?.unresolvedInvites) ? value.unresolvedInvites.slice(-500) : [],
    routingQueue: Array.isArray(value?.routingQueue) ? value.routingQueue.slice(-1000) : [],
    lastWorkerAt: Number(value?.lastWorkerAt || 0) || 0,
  });
}
function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const saved = readJson(ADMIN_FILE, {});
  for (const id of Array.isArray(saved?.adminIds) ? saved.adminIds : []) if (/^\d+$/.test(String(id))) ids.add(String(id));
  return ids;
}
function isAdmin(uid) { return adminIds().has(String(uid)); }
function token(value) { return crypto.createHash("sha1").update(String(value || "")).digest("base64url").slice(0, 11); }
function accountByToken(uid, value) { return listAccounts(uid).find(item => token(item.id) === String(value)) || null; }
function destinationByToken(uid, value) {
  return (readAppSettings(uid).groups || []).find(item => token(item.id) === String(value)) || null;
}
function fmtInterval(minutes) {
  const n = Number(minutes || 30);
  if (n < 60) return `${n} min`;
  if (n === 60) return "1h";
  if (n === 90) return "1h 30m";
  if (n === 120) return "2h";
  return `${Math.floor(n / 60)}h ${n % 60}m`;
}
function fmtAgo(ts) {
  const value = Number(ts || 0);
  if (!value) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function fmtUntil(ts) {
  const value = Number(ts || 0);
  if (!value) return "—";
  const minutes = Math.max(0, Math.ceil((value - Date.now()) / 60_000));
  if (minutes <= 0) return "Due now";
  return fmtInterval(minutes);
}
function destinationLabel(group) {
  const base = String(group?.username || group?.label || group?.id || "Destination");
  return group?.topicTitle ? `${base} → ${group.topicTitle}` : base;
}
function copyMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}
function routeBackButtons(other, defaultCallback = "v1_dashboard_v13") {
  const next = copyMarkup(other);
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    for (const button of row) {
      const data = String(button?.callback_data || "");
      const label = String(button?.text || "");
      if ((data === "home" || /back|home|dashboard/i.test(label)) && !data.startsWith("admin")) {
        button.callback_data = defaultCallback;
        button.text = "📊 Dashboard";
      }
    }
  }
  return next;
}
function inline(text, data) { return { text, callback_data: data }; }
function replaceKeyboard(other, rows) { return { ...(other || {}), reply_markup: { inline_keyboard: rows } }; }
function activeIds(settings, pro) {
  const disabled = new Set((pro.disabledDestinationIds || []).map(String));
  return (settings.groups || []).map(group => String(group.id)).filter(id => !disabled.has(id));
}
function requiredAccountIds(settings, group, accounts) {
  return usesBotSender(settings, group, accounts) ? [] : effectiveAccountIds(settings, group, accounts).map(String);
}
function destinationStatus(settings, group, accounts, pro) {
  const disabled = new Set((pro.disabledDestinationIds || []).map(String));
  if (disabled.has(String(group.id))) return { status: "inactive", ready: 0, required: 0, reason: "Inactive after repeated permanent failures or manual disabling." };
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return { status: "topics", ready: 0, required: 0, reason: "Choose a posting topic." };
  if (usesBotSender(settings, group, accounts)) return { status: "ready", ready: 1, required: 1, reason: "TelePilot Bot route" };
  const ids = requiredAccountIds(settings, group, accounts);
  if (!ids.length) return { status: "failed", ready: 0, required: 0, reason: "No sender account is selected for this destination." };
  const rows = ids.map(id => ({ id, row: group?.accountJoin?.[id], ready: destinationAccountReady(group, id) }));
  const ready = rows.filter(row => row.ready).length;
  if (ready === ids.length) return { status: "ready", ready, required: ids.length, reason: "" };
  if (ready > 0) return { status: "partial", ready, required: ids.length, reason: "Some sender accounts still need attention." };
  const statuses = rows.map(row => String(row.row?.status || ""));
  if (statuses.includes("pending")) return { status: "pending", ready, required: ids.length, reason: "Waiting for Telegram/admin approval." };
  if (statuses.includes("verification")) return { status: "verification", ready, required: ids.length, reason: "Complete the group verification in Telegram." };
  if (statuses.includes("read_only")) return { status: "failed", ready, required: ids.length, reason: "Selected sender cannot post there." };
  return { status: "failed", ready, required: ids.length, reason: "Sender membership or permission needs attention." };
}
function statusIcon(status) {
  return status === "ready" ? "✅"
    : status === "partial" ? "◐"
      : status === "pending" ? "⏳"
        : status === "verification" ? "🛡"
          : status === "topics" ? "💬"
            : status === "inactive" ? "⏸"
              : "⚠️";
}
function destinationSummary(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const pro = readV1(uid);
  const counts = { ready: 0, partial: 0, pending: 0, verification: 0, topics: 0, inactive: 0, failed: 0 };
  let readyTargets = 0;
  for (const group of settings.groups || []) {
    const row = destinationStatus(settings, group, accounts, pro);
    counts[row.status] = Number(counts[row.status] || 0) + 1;
    if (row.status === "ready" || row.status === "partial") readyTargets++;
  }
  const automation = readAutomation(uid);
  return {
    settings,
    accounts,
    pro,
    counts,
    readyTargets,
    total: (settings.groups || []).length,
    unresolved: automation.unresolvedInvites.length,
    routingQueued: automation.routingQueue.length,
    topicsQueued: automation.topicQueue.length,
  };
}
function issueCount(summary) {
  const c = summary.counts;
  return c.partial + c.pending + c.verification + c.topics + c.failed + summary.unresolved + summary.routingQueued;
}
function senderDetail(settings, accounts) {
  const selection = normalizeAccountSelection(settings, accounts);
  if (selection.mode === "bot") return "TelePilot Bot";
  if (selection.mode === "all") return accounts.length === 1 ? accountDisplayLabel(accounts[0]) : `${accounts.length} personal accounts`;
  if (selection.selected.length === 1) return accountDisplayLabel(accounts.find(account => account.id === selection.selected[0]));
  return `${selection.selected.length} personal accounts`;
}
function dashboardScreen(uid) {
  const summary = destinationSummary(uid);
  const { settings, accounts } = summary;
  const qol = readQolState(uid);
  const live = settings.postingEnabled === true;
  const paused = live && summary.pro.paused === true;
  const messageReady = typeof settings.adMessage === "string" && settings.adMessage.trim().length > 0;
  const ready = messageReady && summary.readyTargets > 0;
  const status = paused ? "⏸ PAUSED" : live ? "● LIVE" : ready ? "● READY" : "○ SETUP";
  const issues = issueCount(summary);
  const checklist = [
    `${accounts.length || senderSummary(settings, accounts) === "TelePilot Bot" ? "✓" : "!"} Sender  ${senderDetail(settings, accounts)}`,
    `${messageReady ? "✓" : "!"} Message  ${messageReady ? `Ready · ${settings.adMessage.length} chars` : "Not set"}`,
    `${summary.readyTargets > 0 ? "✓" : "!"} Destinations  ${summary.readyTargets} ready / ${summary.total} total`,
    `✓ Timing  every ${fmtInterval(settings.intervalMinutes || 30)}`,
  ];
  const attention = issues ? `⚠ ${issues} item${issues === 1 ? "" : "s"} need attention` : "✓ No destination issues";
  const rows = [
    [inline("▶ Start", "start"), inline("⏹ Stop", "stop")],
    [inline("📝 Posting Setup", "v1_posting_setup_v13"), inline("📊 Activity", "v1_activity_v13")],
    [inline("👤 Accounts", "v1_accounts_v13"), inline("📁 Destinations", "v1_destinations_v13")],
    [inline("⚙️ Settings", "v1_settings_v13")],
  ];
  if (isAdmin(uid)) rows.push([inline("🟣 ADMIN PANEL", "admin")]);
  if (qol.resume?.section && !live) rows.splice(1, 0, [inline(`↩ Continue ${resumeLabel(qol.resume.section)}`, "v1_resume_v13")]);
  return {
    text: [
      "✈️ TelePilot",
      status,
      "",
      ...checklist,
      live ? `Next post  ${fmtUntil(settings.nextRunAt)}` : null,
      paused && qol.pauseUntil ? `Resumes  ${fmtUntil(qol.pauseUntil)}` : null,
      "",
      attention,
      live && !paused ? "Posting is running. Changes apply to the next safe cycle." : paused ? "Posting stays configured while paused." : ready ? "Ready to start in one tap." : "Complete the missing setup items above.",
    ].filter(Boolean).join("\n"),
    rows,
  };
}
function resumeLabel(section) {
  if (section === "destinations") return "Destinations";
  if (section === "posting_setup") return "Posting Setup";
  if (section === "accounts") return "Accounts";
  if (section === "settings") return "Settings";
  if (section === "activity") return "Activity";
  return "Setup";
}
function postingSetupScreen(uid) {
  const summary = destinationSummary(uid);
  const settings = summary.settings;
  const qol = readQolState(uid);
  const setups = qol.postingSetups.length;
  const active = activeIds(settings, summary.pro).length;
  return {
    text: [
      "📝 Posting Setup",
      "",
      `Sender  ${senderDetail(settings, summary.accounts)}`,
      `Message  ${settings.adMessage?.trim() ? `Ready · ${settings.adMessage.length} chars` : "Not set"}`,
      `Destinations  ${active} active / ${summary.total} saved`,
      `Timing  every ${fmtInterval(settings.intervalMinutes || 30)}`,
      setups ? `Saved setups  ${setups}` : null,
      "",
      "Your everyday posting controls stay here. Power-user scheduling and templates remain under Advanced.",
    ].filter(Boolean).join("\n"),
    rows: [
      [inline("📝 Message", "message"), inline("⏱ Timing", "interval")],
      [inline("👀 Smart Preview", "v1_preview")],
      [inline("📁 Saved Setups", "v1_setups_v13"), inline("⚡ Advanced", "v1_tools")],
      [inline("📊 Dashboard", "v1_dashboard_v13")],
    ],
  };
}
function activityScreen(uid) {
  const summary = destinationSummary(uid);
  const settings = summary.settings;
  const qol = readQolState(uid);
  const stats = v1Stats(uid);
  const history = (summary.pro.history || []).slice(-4).reverse();
  const advanced = queuePreview(uid);
  const nextAdvanced = advanced[0];
  const nextAt = settings.postingEnabled && settings.nextRunAt
    ? Number(settings.nextRunAt)
    : Number(nextAdvanced?.runAt || 0);
  const issues = issueCount(summary);
  const recent = history.length
    ? history.map(item => `${item.status === "sent" ? "✅" : item.status === "failed" ? "❌" : "↷"} ${String(item.destination || "Destination").slice(0, 34)} · ${fmtAgo(item.ts)}`).join("\n")
    : "No posting history yet.";
  const paused = summary.pro.paused === true;
  const pauseText = paused ? (qol.pauseUntil ? `Paused · resumes in ${fmtUntil(qol.pauseUntil)}` : "Paused manually") : "Running normally";
  const rows = [
    [inline("⚡ Fix Issues", "v1_fix_issues_v13"), inline("↻ Retry Failed", "v1_retry_failed_v13")],
    [inline(paused ? "▶ Resume" : "⏸ Pause", paused ? "v1_resume_posting_v13" : "v1_pause_menu_v13"), inline("📜 History", "v1_history")],
    [inline("📁 Destinations", "v1_destinations_v13"), inline("👤 Accounts", "v1_accounts_v13")],
    [inline("📊 Dashboard", "v1_dashboard_v13")],
  ];
  return {
    text: [
      "📊 Activity",
      "",
      `Posting  ${settings.postingEnabled ? (paused ? "⏸ Paused" : "🟢 Running") : "⚪ Stopped"}`,
      `Senders  ${senderDetail(settings, summary.accounts)}`,
      `Next  ${nextAt ? fmtUntil(nextAt) : "—"}`,
      `Destination health  ${summary.readyTargets} ready / ${summary.total} total`,
      issues ? `Needs attention  ${issues}` : "Needs attention  0",
      `Automatic retry  On`,
      `Broken-destination auto-skip  On`,
      `Pause state  ${pauseText}`,
      "",
      `Sent today  ✅ ${stats.today.sent}`,
      `Failed today  ❌ ${stats.today.failed}`,
      stats.today.skipped ? `Skipped today  ↷ ${stats.today.skipped}` : null,
      `7 days  ✅ ${stats.week.sent} · ❌ ${stats.week.failed} · ↷ ${stats.week.skipped}`,
      "",
      "Recent",
      recent,
    ].join("\n"),
    rows,
  };
}
function accountRows(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selection = normalizeAccountSelection(settings, accounts);
  return accounts.map(account => {
    const selected = selection.mode === "all" || selection.selected.includes(String(account.id));
    const status = account.status === "connected" ? "✅" : account.status === "needs-reconnect" ? "⚠️" : "◐";
    return `${status} ${accountDisplayLabel(account)}${selected && selection.mode !== "bot" ? " · posting" : ""}`;
  });
}
function accountsScreen(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const qol = readQolState(uid);
  const lines = accountRows(uid);
  return {
    text: [
      "👤 Accounts",
      "",
      `Current sender  ${senderDetail(settings, accounts)}`,
      `Connected  ${accounts.length}`,
      qol.accountPresets.length ? `Sender presets  ${qol.accountPresets.length}` : null,
      "",
      lines.length ? lines.join("\n") : "No personal accounts connected yet.",
      "",
      "Connected personal accounts can join supported destinations, Addlists and request-only groups for you. Readiness is tracked separately for each sender account.",
    ].filter(Boolean).join("\n"),
    rows: [
      [inline("👤 Manage Senders", "account"), inline("📁 Sender Presets", "v1_account_presets_v13")],
      accounts.length ? [inline("✏️ Rename Accounts", "v1_aliases_v13")] : [],
      [inline("📊 Dashboard", "v1_dashboard_v13")],
    ].filter(row => row.length),
  };
}
function destinationsScreen(uid, filterOverride = null) {
  const summary = destinationSummary(uid);
  const qol = readQolState(uid);
  const filter = filterOverride || qol.destinationFilter || "all";
  const search = qol.destinationSearch.toLowerCase();
  const pro = summary.pro;
  const rows = [];
  for (const group of summary.settings.groups || []) {
    const state = destinationStatus(summary.settings, group, summary.accounts, pro);
    if (filter !== "all" && filter === "forum" && group.topicRequired !== true) continue;
    if (filter !== "all" && filter !== "forum" && state.status !== filter) continue;
    const label = destinationLabel(group);
    const note = qol.destinationNotes[String(group.id)];
    if (search && !`${label} ${note || ""}`.toLowerCase().includes(search)) continue;
    const readiness = state.required > 1 ? ` · ${state.ready}/${state.required} accounts ready` : "";
    rows.push(`${statusIcon(state.status)} ${label}${readiness}${note ? `\n   📝 ${note}` : ""}`);
  }
  const c = summary.counts;
  const selectedPersonal = effectiveAccountIds(summary.settings, null, summary.accounts).length;
  const senderCopy = selectedPersonal
    ? `${senderDetail(summary.settings, summary.accounts)} can automatically join supported destinations.`
    : "TelePilot Bot is the active sender, so the bot itself must be added with posting permission.";
  return {
    text: [
      "📁 Destinations",
      "",
      `Senders  ${senderDetail(summary.settings, summary.accounts)}`,
      `Ready  ${summary.readyTargets} / ${summary.total}`,
      c.partial ? `Partial  ${c.partial}` : null,
      c.pending || summary.unresolved ? `Pending approval  ${c.pending + summary.unresolved}` : null,
      c.verification ? `Verification required  ${c.verification}` : null,
      c.topics ? `Choose topic  ${c.topics}` : null,
      c.inactive ? `Inactive  ${c.inactive}` : null,
      "",
      senderCopy,
      "Paste @usernames, Telegram links, private t.me/+ invites or t.me/addlist/... shared folders. TelePilot joins what it can with the selected personal accounts. Join requests stay pending; captcha/verification steps still need you in Telegram.",
      "",
      filter !== "all" || search ? `View  ${filter}${search ? ` · search “${qol.destinationSearch}”` : ""}` : null,
      rows.length ? rows.slice(0, MAX_LIST).join("\n") : "No destinations match this view.",
      rows.length > MAX_LIST ? `… and ${rows.length - MAX_LIST} more` : null,
    ].filter(Boolean).join("\n"),
    rows: [
      [inline("＋ Add / Import", "v1_dest_add_v13"), inline("⚡ Make Ready", "v1_make_ready_v13")],
      [inline("💬 Topics", "v1_topics_v13"), inline("⏳ Issues", "v1_dest_issues_v13")],
      [inline("🔎 Search / Filter", "v1_dest_filters_v13"), inline("📁 Destination Sets", "v1_destination_presets_v13")],
      [inline("🕘 Import History", "v1_import_history_v13"), inline("🎯 Routing", "route_groups:0")],
      [inline("📊 Dashboard", "v1_dashboard_v13")],
    ],
  };
}
function settingsScreen(uid) {
  const settings = readAppSettings(uid);
  const qol = readQolState(uid);
  const topicMode = qol.topicPreference.mode === "auto_exact" ? "Auto-pick exact matches" : qol.topicPreference.mode === "manual" ? "Manual only" : "Suggest only";
  const access = settings.accessRevoked === true ? "Revoked" : settings.accessLifetime === true ? "Lifetime" : Number(settings.accessUntil || 0) > Date.now() ? "Active" : "Inactive";
  return {
    text: [
      "⚙️ Settings",
      "",
      `Access  ${access}`,
      `Topic suggestions  ${topicMode}`,
      `Preferred topic words  ${qol.topicPreference.words.slice(0, 5).join(", ")}`,
      "",
      "Posting controls live in Posting Setup. Destination health lives in Destinations/Activity so Settings stays small.",
    ].join("\n"),
    rows: [
      [inline("🔑 Access", "access"), inline("💬 Support", "support")],
      [inline("❓ Tutorial", "tutorial_restart"), inline("💬 Topic Preferences", "v1_topic_preferences_v13")],
      [inline("🔔 Notifications", "v1_notifications"), inline("🔥 Referrals", "referrals")],
      [inline("📊 Dashboard", "v1_dashboard_v13")],
    ],
  };
}
function filtersScreen(uid) {
  const qol = readQolState(uid);
  return {
    text: [
      "🔎 Destination Search & Filters",
      "",
      `Current filter  ${qol.destinationFilter}`,
      `Search  ${qol.destinationSearch || "—"}`,
      "",
      "Use filters when your destination list gets large. Inactive contains destinations TelePilot disabled after repeated permanent failures or that you disabled yourself.",
    ].join("\n"),
    rows: [
      [inline("All", "v1_dest_filter_v13:all"), inline("✅ Ready", "v1_dest_filter_v13:ready")],
      [inline("◐ Partial", "v1_dest_filter_v13:partial"), inline("⏳ Pending", "v1_dest_filter_v13:pending")],
      [inline("🛡 Verification", "v1_dest_filter_v13:verification"), inline("💬 Topics", "v1_dest_filter_v13:topics")],
      [inline("⏸ Inactive", "v1_dest_filter_v13:inactive"), inline("💬 Forum", "v1_dest_filter_v13:forum")],
      [inline("🔎 Search", "v1_dest_search_v13"), inline("✖ Clear Search", "v1_dest_search_clear_v13")],
      [inline("📁 Destinations", "v1_destinations_v13")],
    ],
  };
}
function topicPreferenceScreen(uid) {
  const pref = readQolState(uid).topicPreference;
  return {
    text: [
      "💬 Topic Preferences",
      "",
      `Mode  ${pref.mode === "auto_exact" ? "Auto-pick exact matches" : pref.mode === "manual" ? "Manual only" : "Suggest only"}`,
      `Words  ${pref.words.join(", ")}`,
      "",
      "Suggest only highlights likely topics. Auto-pick only selects a topic when exactly one topic title matches one of your preferred words exactly; ambiguous groups still wait for you.",
    ].join("\n"),
    rows: [
      [inline("💡 Suggest only", "v1_topic_mode_v13:suggest")],
      [inline("⚡ Auto-pick exact", "v1_topic_mode_v13:auto_exact")],
      [inline("✋ Manual only", "v1_topic_mode_v13:manual")],
      [inline("✏️ Preferred Words", "v1_topic_words_v13")],
      [inline("⚙️ Settings", "v1_settings_v13")],
    ],
  };
}
function normalizeTopic(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 /]+/g, "").replace(/\s+/g, " ").trim();
}
function suggestedTopic(uid, topics) {
  const pref = readQolState(uid).topicPreference;
  if (pref.mode === "manual") return null;
  const words = pref.words.map(normalizeTopic).filter(Boolean);
  const scored = [];
  for (const topic of Array.isArray(topics) ? topics : []) {
    const title = normalizeTopic(topic?.title);
    if (!title) continue;
    let score = 0;
    for (const word of words) {
      if (title === word) score = Math.max(score, 100);
      else if (title.includes(word) && word.length >= 5) score = Math.max(score, 60);
    }
    if (/rules?|support|help|welcome|verification|verify|announcements?/.test(title)) score = 0;
    if (score) scored.push({ topic, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.topic || null;
}
function exactTopic(uid, topics) {
  const words = readQolState(uid).topicPreference.words.map(normalizeTopic).filter(Boolean);
  const matches = (Array.isArray(topics) ? topics : []).filter(topic => words.includes(normalizeTopic(topic?.title)));
  return matches.length === 1 ? matches[0] : null;
}
function currentTopicQueue(uid) {
  const settings = readAppSettings(uid);
  const groups = new Map((settings.groups || []).map(group => [String(group.id), group]));
  const automation = readAutomation(uid);
  automation.topicQueue = automation.topicQueue.filter(item => {
    const group = groups.get(String(item.destinationId));
    return group && group.topicRequired === true && !Number(group.topicId || 0);
  });
  writeAutomation(uid, automation);
  return automation.topicQueue;
}
function topicsIndexScreen(uid) {
  const queue = currentTopicQueue(uid);
  const rows = queue.slice(0, 12).map(item => [inline(`💬 ${String(item.label || "Forum").slice(0, 42)}`, `v1_topic_v13:${item.token}`)]);
  if (readQolState(uid).topicPreference.mode === "auto_exact" && queue.length) rows.unshift([inline("⚡ Apply Exact Matches", "v1_topics_auto_v13")]);
  rows.push([inline("📁 Destinations", "v1_destinations_v13")]);
  return {
    text: [
      "💬 Posting Topics",
      "",
      queue.length ? `${queue.length} forum destination${queue.length === 1 ? " needs" : "s need"} a topic.` : "All forum destinations have a posting topic.",
      "",
      "TelePilot uses your topic preferences for suggestions. It never auto-selects ambiguous topics.",
    ].join("\n"),
    rows,
  };
}
function topicDetailScreen(uid, queueToken) {
  const item = currentTopicQueue(uid).find(row => String(row.token) === String(queueToken));
  if (!item) return topicsIndexScreen(uid);
  const suggested = suggestedTopic(uid, item.topics);
  const rows = (item.topics || []).slice(0, 18).map(topic => [inline(`${Number(topic.id) === Number(suggested?.id) ? "⭐ " : ""}${String(topic.title || `Topic ${topic.id}`).slice(0, 42)}`, `v1_topic_pick_v13:${item.token}:${topic.id}`)]);
  rows.push([inline("💬 Topics", "v1_topics_v13")]);
  return {
    text: [
      `💬 ${item.label}`,
      "",
      suggested ? `Suggested  ${suggested.title}` : "No strong suggestion. Choose manually.",
      "",
      "Choose the exact topic where TelePilot should post.",
    ].join("\n"),
    rows,
  };
}
function pickTopic(uid, queueToken, topicId) {
  const automation = readAutomation(uid);
  const item = automation.topicQueue.find(row => String(row.token) === String(queueToken));
  if (!item) return null;
  const topic = (item.topics || []).find(row => Number(row.id) === Number(topicId));
  if (!topic) return null;
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const group = groups.find(row => String(row.id) === String(item.destinationId));
  if (!group) return null;
  group.topicId = Number(topic.id);
  group.topicTitle = String(topic.title || "").slice(0, 100);
  group.topicRequired = true;
  const joins = Object.values(group.accountJoin || {});
  if (joins.length && joins.every(row => row?.status === "ready")) group.joinStatus = "ready";
  else if (joins.some(row => row?.status === "ready")) group.joinStatus = "partial";
  else if (joins.some(row => row?.status === "pending")) group.joinStatus = "pending";
  else if (joins.some(row => row?.status === "verification")) group.joinStatus = "verification";
  else group.joinStatus = "ready";
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  automation.topicQueue = automation.topicQueue.filter(row => String(row.token) !== String(queueToken));
  writeAutomation(uid, automation);
  syncUserGroups(uid);
  return { group, topic };
}
function autoPickExactTopics(uid) {
  if (readQolState(uid).topicPreference.mode !== "auto_exact") return 0;
  let picked = 0;
  for (const item of [...currentTopicQueue(uid)]) {
    const topic = exactTopic(uid, item.topics);
    if (topic && pickTopic(uid, item.token, topic.id)) picked++;
  }
  return picked;
}
function issuesScreen(uid) {
  const summary = destinationSummary(uid);
  const automation = readAutomation(uid);
  const lines = [];
  for (const group of summary.settings.groups || []) {
    const state = destinationStatus(summary.settings, group, summary.accounts, summary.pro);
    if (["ready", "inactive"].includes(state.status)) continue;
    lines.push(`${statusIcon(state.status)} ${destinationLabel(group)}${state.required > 1 ? ` · ${state.ready}/${state.required} accounts ready` : ""}\n${state.reason}`);
    if (lines.length >= 12) break;
  }
  for (const row of automation.unresolvedInvites.slice(0, Math.max(0, 12 - lines.length))) {
    lines.push(`⏳ ${String(row.original || "Private invite").slice(0, 60)}\n${row.reason || "Waiting for approval"}`);
  }
  return {
    text: [
      "⚡ Fix Destination Issues",
      "",
      lines.length ? lines.join("\n\n") : "Everything currently looks ready.",
      "",
      "TelePilot can retry joins, approvals and permission checks. Captchas/verification bots still have to be completed in Telegram.",
    ].join("\n"),
    rows: [
      [inline("⚡ Make Ready", "v1_make_ready_v13"), inline("↻ Recheck", "v1_recheck_v13")],
      currentTopicQueue(uid).length ? [inline("💬 Choose Topics", "v1_topics_v13")] : [],
      [inline("📁 Destinations", "v1_destinations_v13")],
    ].filter(row => row.length),
  };
}
function pauseMenuScreen(uid) {
  const settings = readAppSettings(uid);
  return {
    text: [
      "⏸ Pause Posting",
      "",
      settings.postingEnabled ? "Keep your setup live but temporarily skip sends." : "Posting is currently stopped. Pause presets are useful while posting is running.",
      "",
      "The setup, sender routing and schedule stay saved. TelePilot resumes automatically when the pause expires.",
    ].join("\n"),
    rows: [
      [inline("1 hour", "v1_pause_v13:60"), inline("3 hours", "v1_pause_v13:180")],
      [inline("Until tomorrow", "v1_pause_v13:tomorrow")],
      [inline("📊 Activity", "v1_activity_v13")],
    ],
  };
}
function tomorrowAtLocalMidnight(uid) {
  const pro = readV1(uid);
  const offset = Number(pro.schedule?.utcOffsetMinutes || 0);
  const local = new Date(Date.now() + offset * 60_000);
  const nextLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0, 0);
  return nextLocal - offset * 60_000;
}
function setPause(uid, until) {
  const pro = readV1(uid);
  pro.paused = true;
  writeV1(uid, pro);
  patchQolState(uid, { pauseUntil: Number(until || 0) || 0 });
}
function resumePosting(uid) {
  const pro = readV1(uid);
  pro.paused = false;
  writeV1(uid, pro);
  patchQolState(uid, { pauseUntil: 0 });
}
function importHistoryScreen(uid) {
  const state = readQolState(uid);
  const rows = state.importHistory.slice(-12).reverse();
  const textRows = rows.length ? rows.map(row => {
    const date = new Date(Number(row.at || 0)).toISOString().replace("T", " ").slice(0, 16);
    return `• ${date} UTC · ${row.source}\n  +${row.added} added · ${row.duplicates} duplicate · ${row.attention} attention · ${row.failed} failed`;
  }).join("\n\n") : "No v1.3 imports yet.";
  return {
    text: ["🕘 Import History", "", textRows, "", "Imported destinations stay in your normal destination list; this is only a history of import runs."].join("\n"),
    rows: [[inline("📁 Destinations", "v1_destinations_v13")]],
  };
}
function presetCollection(state, kind) {
  if (kind === "account") return state.accountPresets;
  if (kind === "destination") return state.destinationPresets;
  return state.postingSetups;
}
function setPresetCollection(state, kind, value) {
  if (kind === "account") state.accountPresets = value;
  else if (kind === "destination") state.destinationPresets = value;
  else state.postingSetups = value;
}
function accountPresetsScreen(uid) {
  const state = readQolState(uid);
  const rows = [[inline("＋ Save Current Sender", "v1_account_preset_save_v13")]];
  for (const preset of state.accountPresets.slice(-10).reverse()) {
    rows.push([inline(`▶ ${preset.name}`, `v1_account_preset_apply_v13:${preset.id}`), inline("✏️", `v1_preset_rename_v13:account:${preset.id}`), inline("✖", `v1_preset_delete_v13:account:${preset.id}`)]);
  }
  rows.push([inline("👤 Accounts", "v1_accounts_v13")]);
  return {
    text: ["📁 Sender Presets", "", state.accountPresets.length ? "Reuse common sender combinations without re-selecting accounts every time." : "Save your current sender selection as a reusable preset.", "", "Applying a sender preset is blocked while interval posting is running, so sender changes cannot interrupt an active cycle."].join("\n"),
    rows,
  };
}
function destinationPresetsScreen(uid) {
  const state = readQolState(uid);
  const rows = [[inline("＋ Save Active Destinations", "v1_destination_preset_save_v13")]];
  for (const preset of state.destinationPresets.slice(-10).reverse()) {
    rows.push([inline(`▶ ${preset.name}`, `v1_destination_preset_apply_v13:${preset.id}`), inline("✏️", `v1_preset_rename_v13:destination:${preset.id}`), inline("✖", `v1_preset_delete_v13:destination:${preset.id}`)]);
  }
  rows.push([inline("📁 Destinations", "v1_destinations_v13")]);
  return {
    text: ["📁 Destination Sets", "", state.destinationPresets.length ? "Switch between reusable groups of active destinations without deleting anything." : "Save the destinations that are currently active as a reusable set.", "", "Destinations outside the applied set become inactive, not deleted."].join("\n"),
    rows,
  };
}
function postingSetupsScreen(uid) {
  const state = readQolState(uid);
  const rows = [[inline("＋ Save Current Setup", "v1_setup_save_v13")]];
  for (const preset of state.postingSetups.slice(-8).reverse()) {
    rows.push([inline(`▶ ${preset.name}`, `v1_setup_apply_v13:${preset.id}`)]);
    rows.push([inline("⧉ Clone", `v1_setup_clone_v13:${preset.id}`), inline("✏️ Rename", `v1_preset_rename_v13:setup:${preset.id}`), inline("✖ Delete", `v1_preset_delete_v13:setup:${preset.id}`)]);
  }
  rows.push([inline("📝 Posting Setup", "v1_posting_setup_v13")]);
  return {
    text: ["📁 Saved Posting Setups", "", state.postingSetups.length ? "Each saved setup keeps the message, timing, sender selection and active destination set." : "Save the current message, timing, sender selection and active destination set for quick reuse.", "", "Applying a saved setup is blocked while interval posting is running."].join("\n"),
    rows,
  };
}
function saveAccountPreset(uid) {
  const state = readQolState(uid);
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selection = normalizeAccountSelection(settings, accounts);
  state.accountPresets.push({
    id: makePresetId("accp"),
    name: nextPresetName(state.accountPresets, "Sender Preset"),
    mode: selection.mode,
    accountIds: selection.selected,
    createdAt: Date.now(),
  });
  writeQolState(uid, state);
}
function applyAccountPreset(uid, preset) {
  const settings = readAppSettings(uid);
  if (settings.postingEnabled) return { ok: false, error: "Stop interval posting before switching sender presets." };
  const accounts = listAccounts(uid);
  const valid = new Set(accounts.map(account => String(account.id)));
  const mode = ["bot", "all", "selected"].includes(preset?.mode) ? preset.mode : "selected";
  const ids = (Array.isArray(preset?.accountIds) ? preset.accountIds : []).map(String).filter(id => valid.has(id));
  writeAppSettings(uid, { ...settings, senderMode: mode, selectedAccountIds: mode === "selected" ? ids : [] });
  reloadUserState(uid);
  queueRoutingSync(uid);
  void processRoutingQueue(uid, 8).catch(() => {});
  return { ok: true };
}
function saveDestinationPreset(uid) {
  const state = readQolState(uid);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  state.destinationPresets.push({
    id: makePresetId("dstp"),
    name: nextPresetName(state.destinationPresets, "Destination Set"),
    destinationIds: activeIds(settings, pro),
    createdAt: Date.now(),
  });
  writeQolState(uid, state);
}
function applyDestinationPreset(uid, preset) {
  const settings = readAppSettings(uid);
  const wanted = new Set((Array.isArray(preset?.destinationIds) ? preset.destinationIds : []).map(String));
  const pro = readV1(uid);
  pro.disabledDestinationIds = (settings.groups || []).map(group => String(group.id)).filter(id => !wanted.has(id));
  writeV1(uid, pro);
  return { ok: true, active: wanted.size };
}
function setupSnapshot(uid) {
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const selection = normalizeAccountSelection(settings, listAccounts(uid));
  return {
    adMessage: String(settings.adMessage || ""),
    adEntities: Array.isArray(settings.adEntities) ? settings.adEntities : [],
    intervalSeconds: intervalSecondsFromSettings(settings),
    intervalMinutes: intervalMinutesForCompatibility(intervalSecondsFromSettings(settings)),
    senderMode: selection.mode,
    selectedAccountIds: selection.selected,
    activeDestinationIds: activeIds(settings, pro),
  };
}
function saveSetupPreset(uid) {
  const state = readQolState(uid);
  state.postingSetups.push({
    id: makePresetId("setup"),
    name: nextPresetName(state.postingSetups, "Posting Setup"),
    snapshot: setupSnapshot(uid),
    createdAt: Date.now(),
  });
  writeQolState(uid, state);
}
function applySetupPreset(uid, preset) {
  const settings = readAppSettings(uid);
  if (settings.postingEnabled) return { ok: false, error: "Stop interval posting before switching saved setups." };
  const snapshot = preset?.snapshot || {};
  const accounts = listAccounts(uid);
  const validAccounts = new Set(accounts.map(account => String(account.id)));
  const selected = (Array.isArray(snapshot.selectedAccountIds) ? snapshot.selectedAccountIds : []).map(String).filter(id => validAccounts.has(id));
  const mode = ["bot", "all", "selected"].includes(snapshot.senderMode) ? snapshot.senderMode : "selected";
  writeAppSettings(uid, {
    ...settings,
    version: Math.max(5, Number(settings.version || 0)),
    adMessage: String(snapshot.adMessage || ""),
    adEntities: Array.isArray(snapshot.adEntities) ? snapshot.adEntities : [],
    intervalSeconds: intervalSecondsFromSettings(snapshot),
    intervalMinutes: intervalMinutesForCompatibility(intervalSecondsFromSettings(snapshot)),
    senderMode: mode,
    selectedAccountIds: mode === "selected" ? selected : [],
  });
  const wanted = new Set((Array.isArray(snapshot.activeDestinationIds) ? snapshot.activeDestinationIds : []).map(String));
  const pro = readV1(uid);
  pro.disabledDestinationIds = (settings.groups || []).map(group => String(group.id)).filter(id => !wanted.has(id));
  writeV1(uid, pro);
  reloadUserState(uid);
  syncUserGroups(uid);
  queueRoutingSync(uid);
  void processRoutingQueue(uid, 8).catch(() => {});
  return { ok: true };
}
function aliasListScreen(uid) {
  const accounts = listAccounts(uid);
  const rows = accounts.map(account => [inline(`✏️ ${accountDisplayLabel(account)}`, `v1_alias_v13:${token(account.id)}`)]);
  rows.push([inline("👤 Accounts", "v1_accounts_v13")]);
  return {
    text: ["✏️ Rename Accounts", "", "Give connected accounts short names such as Main, Backup or Shop. The alias is used throughout TelePilot instead of a phone-like identifier.", "", "Tap an account, then send its new name. Send - to clear an alias."].join("\n"),
    rows,
  };
}
function destinationDetailScreen(uid, group) {
  const summary = destinationSummary(uid);
  const state = destinationStatus(summary.settings, group, summary.accounts, summary.pro);
  const qol = readQolState(uid);
  const ids = requiredAccountIds(summary.settings, group, summary.accounts);
  const accountLines = ids.length ? ids.map(id => {
    const account = summary.accounts.find(item => String(item.id) === id);
    const row = group?.accountJoin?.[id];
    return `${destinationAccountReady(group, id) ? "✅" : row?.status === "verification" ? "🛡" : row?.status === "pending" ? "⏳" : "⚠️"} ${accountDisplayLabel(account)} · ${row?.status || (destinationAccountReady(group, id) ? "ready" : "unknown")}`;
  }) : ["🤖 TelePilot Bot route"];
  const note = qol.destinationNotes[String(group.id)] || "—";
  const rows = [
    [inline("📝 Note", `v1_dest_note_v13:${token(group.id)}`), inline(state.status === "inactive" ? "▶ Restore" : "⏸ Inactive", `v1_dest_toggle_v13:${token(group.id)}`)],
  ];
  if (group.username) rows.push([{ text: "↗ Open in Telegram", url: `https://t.me/${String(group.username).replace(/^@/, "")}` }]);
  rows.push([inline("📁 Destinations", "v1_destinations_v13")]);
  return {
    text: [
      `📁 ${destinationLabel(group)}`,
      "",
      `Status  ${statusIcon(state.status)} ${state.status}`,
      `Topic  ${group.topicTitle || (group.topicRequired ? "Not selected" : "General/default")}`,
      `Source  ${group.source || "manual"}${group.sourceSlug ? ` · ${group.sourceSlug}` : ""}`,
      `Note  ${note}`,
      "",
      ...accountLines,
      "",
      state.reason || "Ready to post.",
    ].join("\n"),
    rows,
  };
}
function destinationBrowseScreen(uid) {
  const summary = destinationSummary(uid);
  const qol = readQolState(uid);
  const rows = [];
  for (const group of summary.settings.groups || []) {
    const state = destinationStatus(summary.settings, group, summary.accounts, summary.pro);
    const search = qol.destinationSearch.toLowerCase();
    const note = qol.destinationNotes[String(group.id)] || "";
    if (qol.destinationFilter !== "all" && qol.destinationFilter === "forum" && group.topicRequired !== true) continue;
    if (qol.destinationFilter !== "all" && qol.destinationFilter !== "forum" && state.status !== qol.destinationFilter) continue;
    if (search && !`${destinationLabel(group)} ${note}`.toLowerCase().includes(search)) continue;
    rows.push([inline(`${statusIcon(state.status)} ${destinationLabel(group).slice(0, 42)}`, `v1_dest_detail_v13:${token(group.id)}`)]);
    if (rows.length >= 20) break;
  }
  rows.push([inline("🔎 Filters", "v1_dest_filters_v13"), inline("📁 Destinations", "v1_destinations_v13")]);
  return {
    text: ["📁 Browse Destinations", "", rows.length > 1 ? "Tap a destination to view sender readiness, topic, source and notes." : "No destinations match the current filter/search."].join("\n"),
    rows,
  };
}
async function editOrReply(ctx, screen) {
  const opts = { reply_markup: { inline_keyboard: screen.rows } };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(screen.text, opts); }
    catch (err) {
      const text = String(err?.description || err?.message || "").toLowerCase();
      if (text.includes("message is not modified")) return;
    }
  }
  return ctx.reply(screen.text, opts);
}
async function editStoredPrompt(ctx, pending, screen) {
  const chatId = Number(pending?.chatId || ctx.chat?.id || 0);
  const messageId = Number(pending?.messageId || 0);
  if (chatId && messageId) {
    try { return await ctx.api.editMessageText(chatId, messageId, screen.text, { reply_markup: { inline_keyboard: screen.rows } }); } catch {}
  }
  return ctx.reply(screen.text, { reply_markup: { inline_keyboard: screen.rows } });
}
async function deleteInput(ctx) { try { await ctx.deleteMessage(); } catch {} }
function setInputFromCtx(ctx, type, extra = {}) {
  const uid = String(ctx.from?.id || "");
  const pending = {
    type,
    chatId: ctx.chat?.id || null,
    messageId: ctx.callbackQuery?.message?.message_id || null,
    createdAt: Date.now(),
    ...extra,
  };
  setPendingInput(uid, pending);
  return pending;
}
async function botImportPublic(ctx, uid, parsed) {
  if (parsed?.kind !== "public") return { added: 0, duplicates: 0, failed: 1, attention: 0, error: "Private invites and Addlists require a selected personal account." };
  const settings = readAppSettings(uid);
  let chat;
  try { chat = await ctx.api.getChat(`@${parsed.username}`); }
  catch { return { added: 0, duplicates: 0, failed: 1, attention: 0, error: `@${parsed.username} — Telegram could not find that destination.` }; }
  if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) return { added: 0, duplicates: 0, failed: 1, attention: 0, error: `@${parsed.username} — not a group/channel.` };
  const botId = Number(ctx.me?.id || 0);
  let botMember;
  try { botMember = await ctx.api.getChatMember(chat.id, botId); } catch {}
  if (!botMember || botMember.status !== "administrator") return { added: 0, duplicates: 0, failed: 1, attention: 0, error: `@${parsed.username} — add @${ctx.me?.username || "TelePilottBot"} as an admin first.` };
  if (chat.type === "channel" && botMember.can_post_messages !== true) return { added: 0, duplicates: 0, failed: 1, attention: 0, error: `@${parsed.username} — give the bot permission to post messages.` };
  let ownerMember;
  try { ownerMember = await ctx.api.getChatMember(chat.id, Number(uid)); } catch {}
  if (!ownerMember || !["creator", "administrator"].includes(ownerMember.status)) return { added: 0, duplicates: 0, failed: 1, attention: 0, error: `@${parsed.username} — you must be an admin when TelePilot Bot is the sender.` };
  const id = String(chat.id);
  if ((settings.groups || []).some(group => String(group.id) === id)) return { added: 0, duplicates: 1, failed: 0, attention: 0 };
  const group = {
    id,
    label: String(chat.title || chat.username || id).slice(0, 120),
    type: chat.type,
    username: chat.username ? `@${chat.username}` : `@${parsed.username}`,
    accountMode: "inherit",
    accountIds: [],
    topicId: null,
    topicTitle: "",
    topicRequired: false,
    joinStatus: "ready",
    accountJoin: {},
    source: "public",
    sourceSlug: parsed.username,
    importedAt: Date.now(),
  };
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups: [...(settings.groups || []), group] });
  syncUserGroups(uid);
  return { added: 1, duplicates: 0, failed: 0, attention: 0, destinationIds: [id] };
}
async function handleV13DestinationImport(ctx, pending, rawText) {
  const uid = String(ctx.from?.id || "");
  const lines = String(rawText || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  await deleteInput(ctx);
  if (!lines.length) {
    setPendingInput(uid, null);
    return editStoredPrompt(ctx, pending, destinationsScreen(uid));
  }
  const beforeIds = new Set((readAppSettings(uid).groups || []).map(group => String(group.id)));
  let added = 0, duplicates = 0, failed = 0;
  const failures = [];
  const personal = effectiveAccountIds(readAppSettings(uid), null, listAccounts(uid)).length > 0;
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseDestinationInput(lines[index]);
    try {
      await ctx.api.editMessageText(Number(pending.chatId || ctx.chat.id), Number(pending.messageId), [
        "📥 Importing destinations…",
        "",
        `${index + 1}/${lines.length} · ${String(lines[index]).slice(0, 80)}`,
        "",
        "TelePilot is joining/checking only the destinations you pasted. Telegram rate limits and approval requirements are respected.",
      ].join("\n"));
    } catch {}
    if (!parsed) { failed++; failures.push(`${lines[index]} — invalid Telegram destination.`); continue; }
    let result;
    if (personal) result = await handleDestinationText(uid, lines[index]);
    else result = await botImportPublic(ctx, uid, parsed);
    added += Number(result?.added || 0);
    duplicates += Number(result?.duplicates || 0);
    failed += Number(result?.failed || 0);
    if (result?.error) failures.push(result.error);
    if (result?.requiresPersonal) { failed++; failures.push(`${lines[index]} — select a personal account for private invites/Addlists.`); }
  }
  const after = destinationSummary(uid);
  const afterIds = (after.settings.groups || []).map(group => String(group.id));
  const newIds = afterIds.filter(id => !beforeIds.has(id));
  const attention = issueCount(after);
  const source = lines.length === 1 && parseDestinationInput(lines[0])?.kind === "addlist"
    ? `Addlist ${parseDestinationInput(lines[0]).slug}`
    : `Bulk import ${lines.length} item${lines.length === 1 ? "" : "s"}`;
  appendImportHistory(uid, { source, added, duplicates, failed, attention, destinationIds: newIds });
  setPendingInput(uid, null);
  setResume(uid, "destinations");
  const tutorialScreen = !currentTopicQueue(uid).length && (added || duplicates || attention)
    ? advanceTutorialAfterAction(uid, 3, 4)
    : null;
  if (tutorialScreen) {
    try {
      return await ctx.api.editMessageText(Number(pending.chatId || ctx.chat.id), Number(pending.messageId), tutorialScreen.text, { reply_markup: tutorialScreen.keyboard });
    } catch {}
  }
  const screen = {
    text: [
      "✅ Destination import complete",
      "",
      `Added  ${added}`,
      `Already saved  ${duplicates}`,
      `Needs attention  ${attention}`,
      `Failed / invalid  ${failed}`,
      currentTopicQueue(uid).length ? `Topics to choose  ${currentTopicQueue(uid).length}` : null,
      failures.length ? "" : null,
      ...failures.slice(0, 6),
    ].filter(Boolean).join("\n"),
    rows: [
      currentTopicQueue(uid).length ? [inline("💬 Choose Topics", "v1_topics_v13")] : [],
      attention ? [inline("⚡ Make Ready", "v1_make_ready_v13")] : [],
      [inline("📁 Destinations", "v1_destinations_v13")],
    ].filter(row => row.length),
  };
  return editStoredPrompt(ctx, pending, screen);
}
function renamePreset(uid, pending, text) {
  const state = readQolState(uid);
  const items = presetCollection(state, pending.kind);
  const preset = items.find(item => String(item.id) === String(pending.presetId));
  if (!preset) return false;
  const name = String(text || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  if (!name) return false;
  preset.name = name;
  setPresetCollection(state, pending.kind, items);
  writeQolState(uid, state);
  return true;
}
async function qolTextMiddleware(ctx, next) {
  if (ctx.chat?.type !== "private" || !ctx.from?.id) return next();
  const uid = String(ctx.from.id);
  const qol = readQolState(uid);
  const pending = qol.pendingInput;
  if (!pending?.type) return next();
  if (Date.now() - Number(pending.createdAt || 0) > INPUT_TTL_MS) {
    setPendingInput(uid, null);
    return next();
  }
  const text = String(ctx.message?.text || "");
  if (pending.type === "destination_import") return handleV13DestinationImport(ctx, pending, text);
  await deleteInput(ctx);
  if (pending.type === "account_alias") {
    const account = accountByToken(uid, pending.accountToken);
    if (account) setAccountAlias(uid, account.id, text.trim() === "-" ? "" : text);
    setPendingInput(uid, null);
    return editStoredPrompt(ctx, pending, accountsScreen(uid));
  }
  if (pending.type === "destination_note") {
    const group = destinationByToken(uid, pending.destinationToken);
    if (group) setDestinationNote(uid, group.id, text.trim() === "-" ? "" : text);
    setPendingInput(uid, null);
    return editStoredPrompt(ctx, pending, group ? destinationDetailScreen(uid, group) : destinationsScreen(uid));
  }
  if (pending.type === "destination_search") {
    patchQolState(uid, { destinationSearch: text.trim().slice(0, 80), destinationFilter: "all", pendingInput: null });
    return editStoredPrompt(ctx, pending, destinationBrowseScreen(uid));
  }
  if (pending.type === "topic_words") {
    const words = text.split(/[,\n]/).map(value => normalizeTopic(value)).filter(Boolean).slice(0, 30);
    const state = readQolState(uid);
    if (words.length) state.topicPreference.words = [...new Set(words)];
    state.pendingInput = null;
    writeQolState(uid, state);
    return editStoredPrompt(ctx, pending, topicPreferenceScreen(uid));
  }
  if (pending.type === "preset_rename") {
    renamePreset(uid, pending, text);
    setPendingInput(uid, null);
    const screen = pending.kind === "account" ? accountPresetsScreen(uid) : pending.kind === "destination" ? destinationPresetsScreen(uid) : postingSetupsScreen(uid);
    return editStoredPrompt(ctx, pending, screen);
  }
  setPendingInput(uid, null);
  return next();
}
async function makeReady(ctx, uid) {
  try { await ctx.editMessageText("⚡ Making destinations ready…\n\nChecking sender membership, queued joins, approvals and topic preferences. This may take a moment."); } catch {}
  const queued = queueRoutingSync(uid);
  let processed = 0;
  try { const result = await processRoutingQueue(uid, Math.min(12, Math.max(queued, 12))); processed = Number(result?.processed || result?.checked || 0); } catch {}
  let changed = 0;
  try { const result = await recheckDestinations(uid, 24); changed = Number(result?.changed || 0); } catch {}
  const picked = autoPickExactTopics(uid);
  return { queued, processed, changed, picked };
}
function retryFailed(uid) {
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const recentFailed = new Set((pro.history || []).filter(item => item.status === "failed" && Number(item.ts || 0) > Date.now() - 24 * 60 * 60_000).map(item => String(item.destinationId || "")));
  const summary = destinationSummary(uid);
  const nowReady = new Set((settings.groups || []).filter(group => recentFailed.has(String(group.id)) && ["ready", "partial"].includes(destinationStatus(settings, group, summary.accounts, pro).status)).map(group => String(group.id)));
  const before = new Set((pro.disabledDestinationIds || []).map(String));
  pro.disabledDestinationIds = [...before].filter(id => !nowReady.has(id));
  writeV1(uid, pro);
  return { failed: recentFailed.size, reenabled: nowReady.size };
}
function transformScreen(chatId, text, other) {
  const uid = String(chatId || "");
  const value = String(text || "");
  if (!/^\d+$/.test(uid)) return { text: value, other };
  if (value.startsWith("✈️ TelePilot") && (value.includes("Sender") || value.includes("READY") || value.includes("SETUP") || value.includes("LIVE"))) {
    const screen = dashboardScreen(uid);
    return { text: screen.text, other: replaceKeyboard(other, screen.rows) };
  }
  if (value.startsWith("🧩 Posting Setup") || value.startsWith("📝 Posting Setup")) {
    const screen = postingSetupScreen(uid);
    return { text: screen.text, other: replaceKeyboard(other, screen.rows) };
  }
  if (value.startsWith("📍 Destinations") || value.startsWith("📁 Destinations")) {
    const screen = destinationsScreen(uid);
    return { text: screen.text, other: replaceKeyboard(other, screen.rows) };
  }
  if (value.startsWith("📊 ACTIVITY") || value.startsWith("📊 Activity")) {
    const screen = activityScreen(uid);
    return { text: screen.text, other: replaceKeyboard(other, screen.rows) };
  }
  if (value.startsWith("⚙️ Settings")) {
    const screen = settingsScreen(uid);
    return { text: screen.text, other: replaceKeyboard(other, screen.rows) };
  }
  if (value.startsWith("👤 Step 1 of 5 — Accounts")) {
    let next = copyMarkup(other);
    for (const row of next?.reply_markup?.inline_keyboard || []) {
      for (const button of row) {
        if (button.callback_data === "account") button.callback_data = "v1_accounts_v13";
      }
    }
    return { text: value.replace("Open Accounts", "Open Accounts"), other: next };
  }
  if (value.startsWith("📍 Step 2 of 5 — Destinations")) {
    let next = copyMarkup(other);
    for (const row of next?.reply_markup?.inline_keyboard || []) {
      for (const button of row) {
        if (button.callback_data === "groups") button.callback_data = "v1_destinations_v13";
        if (button.text?.includes("Add Destinations")) button.callback_data = "v1_dest_add_v13";
        if (button.callback_data === "dest_topics") button.callback_data = "v1_topics_v13";
      }
    }
    return { text: value.replace("TelePilot automatically joins missing groups.", "TelePilot automatically joins supported missing groups and Addlists with the selected personal senders."), other: next };
  }
  if (value.startsWith("📝 Step 3 of 5 — Posting Setup")) {
    let next = copyMarkup(other);
    for (const row of next?.reply_markup?.inline_keyboard || []) for (const button of row) if (button.callback_data === "posting_setup") button.callback_data = "v1_posting_setup_v13";
    return { text: value, other: next };
  }
  if (value.startsWith("🎉 TelePilot is ready")) {
    return { text: value.replace("Home now stays simple: Start/Stop, Posting Setup, Accounts, Destinations and Settings.", "Your Dashboard stays simple: Start/Stop, Posting Setup, Activity, Accounts, Destinations and Settings."), other: routeBackButtons(other) };
  }
  if (value.startsWith("📍 Add destination") || value.startsWith("📍 Add destinations")) {
    return {
      text: [
        "📥 Add / Import Destinations",
        "",
        "Paste one or many destinations, one per line.",
        "",
        "Supported: @usernames, public t.me links, private t.me/+ invites and t.me/addlist/... shared folders.",
        "Selected personal accounts can automatically join supported chats. Request-only groups remain Pending; verification/captcha steps still need you in Telegram. Forum groups are detected and routed to the topic you choose.",
        "",
        "When TelePilot Bot is the sender, public destinations require the bot to be added with posting permission."
      ].join("\n"),
      other: replaceKeyboard(other, [[inline("📊 Dashboard", "v1_dashboard_v13")]]),
    };
  }
  return { text: value, other: routeBackButtons(other) };
}
function installCallbacks(bot) {
  bot.callbackQuery("v1_dashboard_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    clearResume(uid);
    await editOrReply(ctx, dashboardScreen(uid));
  });
  bot.callbackQuery("v1_posting_setup_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    setResume(uid, "posting_setup");
    await editOrReply(ctx, postingSetupScreen(uid));
  });
  bot.callbackQuery("v1_activity_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    setResume(uid, "activity");
    await editOrReply(ctx, activityScreen(uid));
  });
  bot.callbackQuery("v1_accounts_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    setResume(uid, "accounts");
    await editOrReply(ctx, accountsScreen(uid));
  });
  bot.callbackQuery("v1_destinations_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    setResume(uid, "destinations");
    await editOrReply(ctx, destinationsScreen(uid));
  });
  bot.callbackQuery("v1_settings_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setPendingInput(uid, null);
    setResume(uid, "settings");
    await editOrReply(ctx, settingsScreen(uid));
  });
  bot.callbackQuery("v1_resume_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    const section = readQolState(uid).resume?.section;
    const screen = section === "destinations" ? destinationsScreen(uid)
      : section === "accounts" ? accountsScreen(uid)
        : section === "settings" ? settingsScreen(uid)
          : section === "activity" ? activityScreen(uid)
            : postingSetupScreen(uid);
    await editOrReply(ctx, screen);
  });
  bot.callbackQuery("v1_dest_add_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setResume(uid, "destinations");
    setInputFromCtx(ctx, "destination_import");
    await ctx.editMessageText([
      "📥 Add / Import Destinations",
      "",
      "Send one or many destinations now — one per line.",
      "",
      "Examples:",
      "@groupname",
      "https://t.me/groupname",
      "https://t.me/+privateInvite",
      "https://t.me/addlist/yourFolder",
      "",
      "With personal senders selected, TelePilot automatically joins supported groups/Addlists, tracks approval requests per account and detects forum topics. Verification bots/captchas still need you in Telegram.",
    ].join("\n"), { reply_markup: { inline_keyboard: [[inline("📁 Cancel", "v1_destinations_v13")]] } });
  });
  bot.callbackQuery("v1_make_ready_v13", async ctx => {
    await ctx.answerCallbackQuery({ text: "Checking destinations…" });
    const uid = String(ctx.from?.id || "");
    const result = await makeReady(ctx, uid);
    const summary = destinationSummary(uid);
    const issues = issueCount(summary);
    await editOrReply(ctx, {
      text: ["⚡ Make Ready complete", "", `Queued membership checks  ${result.queued}`, `Rechecked / changed  ${result.changed}`, `Topics auto-picked  ${result.picked}`, `Ready destinations  ${summary.readyTargets}/${summary.total}`, `Still need attention  ${issues}`, "", issues ? "Open Issues to finish anything Telegram still requires from you." : "Everything currently looks ready."].join("\n"),
      rows: [issues ? [inline("⚡ Fix Remaining", "v1_dest_issues_v13")] : [], [inline("📁 Destinations", "v1_destinations_v13")]].filter(row => row.length),
    });
  });
  bot.callbackQuery("v1_fix_issues_v13", async ctx => {
    await ctx.answerCallbackQuery({ text: "Checking…" });
    const uid = String(ctx.from?.id || "");
    await makeReady(ctx, uid);
    await editOrReply(ctx, issuesScreen(uid));
  });
  bot.callbackQuery("v1_recheck_v13", async ctx => {
    await ctx.answerCallbackQuery({ text: "Rechecking…" });
    const uid = String(ctx.from?.id || "");
    try { await recheckDestinations(uid, 30); } catch {}
    await editOrReply(ctx, issuesScreen(uid));
  });
  bot.callbackQuery("v1_dest_issues_v13", async ctx => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, issuesScreen(String(ctx.from?.id || "")));
  });
  bot.callbackQuery("v1_topics_v13", async ctx => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, topicsIndexScreen(String(ctx.from?.id || "")));
  });
  bot.callbackQuery(/^v1_topic_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, topicDetailScreen(String(ctx.from?.id || ""), ctx.match[1]));
  });
  bot.callbackQuery(/^v1_topic_pick_v13:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
    const uid = String(ctx.from?.id || "");
    const result = pickTopic(uid, ctx.match[1], Number(ctx.match[2]));
    await ctx.answerCallbackQuery({ text: result ? `Topic: ${result.topic.title}` : "Topic unavailable" });
    if (result && !currentTopicQueue(uid).length) {
      const tutorial = advanceTutorialAfterAction(uid, 3, 4);
      if (tutorial) return ctx.editMessageText(tutorial.text, { reply_markup: tutorial.keyboard });
    }
    await editOrReply(ctx, topicsIndexScreen(uid));
  });
  bot.callbackQuery("v1_topics_auto_v13", async ctx => {
    const uid = String(ctx.from?.id || "");
    const picked = autoPickExactTopics(uid);
    await ctx.answerCallbackQuery({ text: picked ? `${picked} exact topic match${picked === 1 ? "" : "es"} selected` : "No exact matches found" });
    await editOrReply(ctx, topicsIndexScreen(uid));
  });
  bot.callbackQuery("v1_dest_filters_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, filtersScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery(/^v1_dest_filter_v13:(all|ready|partial|pending|verification|topics|inactive|forum)$/, async ctx => {
    const uid = String(ctx.from?.id || "");
    patchQolState(uid, { destinationFilter: ctx.match[1] });
    await ctx.answerCallbackQuery({ text: `Filter: ${ctx.match[1]}` });
    await editOrReply(ctx, destinationBrowseScreen(uid));
  });
  bot.callbackQuery("v1_dest_search_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setInputFromCtx(ctx, "destination_search");
    await ctx.editMessageText("🔎 Search Destinations\n\nSend a group/channel name, @username or note keyword.\n\nYour search only filters your saved TelePilot destinations.", { reply_markup: { inline_keyboard: [[inline("📁 Cancel", "v1_dest_filters_v13")]] } });
  });
  bot.callbackQuery("v1_dest_search_clear_v13", async ctx => {
    const uid = String(ctx.from?.id || "");
    patchQolState(uid, { destinationSearch: "", destinationFilter: "all" });
    await ctx.answerCallbackQuery({ text: "Search cleared" });
    await editOrReply(ctx, destinationsScreen(uid));
  });
  bot.callbackQuery("v1_dest_browse_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, destinationBrowseScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery(/^v1_dest_detail_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = String(ctx.from?.id || "");
    const group = destinationByToken(uid, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, group ? destinationDetailScreen(uid, group) : destinationsScreen(uid));
  });
  bot.callbackQuery(/^v1_dest_note_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    const group = destinationByToken(uid, ctx.match[1]);
    if (!group) return editOrReply(ctx, destinationsScreen(uid));
    setInputFromCtx(ctx, "destination_note", { destinationToken: ctx.match[1] });
    await ctx.editMessageText(`📝 Note for ${destinationLabel(group)}\n\nSend a short note (max 240 characters).\nSend - to clear the note.`, { reply_markup: { inline_keyboard: [[inline("📁 Cancel", `v1_dest_detail_v13:${ctx.match[1]}`)]] } });
  });
  bot.callbackQuery(/^v1_dest_toggle_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = String(ctx.from?.id || "");
    const group = destinationByToken(uid, ctx.match[1]);
    if (!group) { await ctx.answerCallbackQuery({ text: "Destination unavailable" }); return; }
    const pro = readV1(uid);
    const disabled = new Set((pro.disabledDestinationIds || []).map(String));
    if (disabled.has(String(group.id))) disabled.delete(String(group.id)); else disabled.add(String(group.id));
    pro.disabledDestinationIds = [...disabled];
    writeV1(uid, pro);
    await ctx.answerCallbackQuery({ text: disabled.has(String(group.id)) ? "Destination inactive" : "Destination restored" });
    await editOrReply(ctx, destinationDetailScreen(uid, group));
  });
  bot.callbackQuery("v1_import_history_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, importHistoryScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery("v1_topic_preferences_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, topicPreferenceScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery(/^v1_topic_mode_v13:(suggest|auto_exact|manual)$/, async ctx => {
    const uid = String(ctx.from?.id || "");
    const state = readQolState(uid);
    state.topicPreference.mode = ctx.match[1];
    writeQolState(uid, state);
    await ctx.answerCallbackQuery({ text: `Topic mode: ${ctx.match[1]}` });
    await editOrReply(ctx, topicPreferenceScreen(uid));
  });
  bot.callbackQuery("v1_topic_words_v13", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    setInputFromCtx(ctx, "topic_words");
    await ctx.editMessageText("✏️ Preferred Topic Words\n\nSend comma-separated names TelePilot should prefer, for example:\n\nadvertising, ads, marketplace, services\n\nThese words affect suggestions. Auto-pick still requires one exact unambiguous match.", { reply_markup: { inline_keyboard: [[inline("⚙️ Cancel", "v1_topic_preferences_v13")]] } });
  });
  bot.callbackQuery("v1_aliases_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, aliasListScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery(/^v1_alias_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    const account = accountByToken(uid, ctx.match[1]);
    if (!account) return editOrReply(ctx, accountsScreen(uid));
    setInputFromCtx(ctx, "account_alias", { accountToken: ctx.match[1] });
    await ctx.editMessageText(`✏️ Rename ${accountDisplayLabel(account)}\n\nSend a short account name, for example Main, Backup or Shop.\nSend - to clear the alias.`, { reply_markup: { inline_keyboard: [[inline("👤 Cancel", "v1_aliases_v13")]] } });
  });
  bot.callbackQuery("v1_account_presets_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, accountPresetsScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery("v1_account_preset_save_v13", async ctx => {
    const uid = String(ctx.from?.id || ""); saveAccountPreset(uid); await ctx.answerCallbackQuery({ text: "Sender preset saved" }); await editOrReply(ctx, accountPresetsScreen(uid));
  });
  bot.callbackQuery(/^v1_account_preset_apply_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = String(ctx.from?.id || ""); const state = readQolState(uid); const preset = state.accountPresets.find(item => item.id === ctx.match[1]); const result = preset ? applyAccountPreset(uid, preset) : { ok: false, error: "Preset unavailable" }; await ctx.answerCallbackQuery({ text: result.ok ? `Applied ${preset.name}` : result.error, show_alert: !result.ok }); await editOrReply(ctx, accountPresetsScreen(uid));
  });
  bot.callbackQuery("v1_destination_presets_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, destinationPresetsScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery("v1_destination_preset_save_v13", async ctx => { const uid = String(ctx.from?.id || ""); saveDestinationPreset(uid); await ctx.answerCallbackQuery({ text: "Destination set saved" }); await editOrReply(ctx, destinationPresetsScreen(uid)); });
  bot.callbackQuery(/^v1_destination_preset_apply_v13:([A-Za-z0-9_-]+)$/, async ctx => { const uid = String(ctx.from?.id || ""); const state = readQolState(uid); const preset = state.destinationPresets.find(item => item.id === ctx.match[1]); if (preset) applyDestinationPreset(uid, preset); await ctx.answerCallbackQuery({ text: preset ? `Applied ${preset.name}` : "Preset unavailable" }); await editOrReply(ctx, destinationPresetsScreen(uid)); });
  bot.callbackQuery("v1_setups_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, postingSetupsScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery("v1_setup_save_v13", async ctx => { const uid = String(ctx.from?.id || ""); saveSetupPreset(uid); await ctx.answerCallbackQuery({ text: "Posting setup saved" }); await editOrReply(ctx, postingSetupsScreen(uid)); });
  bot.callbackQuery(/^v1_setup_apply_v13:([A-Za-z0-9_-]+)$/, async ctx => { const uid = String(ctx.from?.id || ""); const state = readQolState(uid); const preset = state.postingSetups.find(item => item.id === ctx.match[1]); const result = preset ? applySetupPreset(uid, preset) : { ok: false, error: "Setup unavailable" }; await ctx.answerCallbackQuery({ text: result.ok ? `Applied ${preset.name}` : result.error, show_alert: !result.ok }); await editOrReply(ctx, postingSetupsScreen(uid)); });
  bot.callbackQuery(/^v1_setup_clone_v13:([A-Za-z0-9_-]+)$/, async ctx => { const uid = String(ctx.from?.id || ""); const state = readQolState(uid); const preset = state.postingSetups.find(item => item.id === ctx.match[1]); if (preset) state.postingSetups.push({ ...preset, id: makePresetId("setup"), name: `${preset.name} Copy`.slice(0, 48), createdAt: Date.now() }); writeQolState(uid, state); await ctx.answerCallbackQuery({ text: preset ? "Setup cloned" : "Setup unavailable" }); await editOrReply(ctx, postingSetupsScreen(uid)); });
  bot.callbackQuery(/^v1_preset_rename_v13:(account|destination|setup):([A-Za-z0-9_-]+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    const state = readQolState(uid);
    const preset = presetCollection(state, ctx.match[1]).find(item => item.id === ctx.match[2]);
    if (!preset) return editOrReply(ctx, ctx.match[1] === "account" ? accountPresetsScreen(uid) : ctx.match[1] === "destination" ? destinationPresetsScreen(uid) : postingSetupsScreen(uid));
    setInputFromCtx(ctx, "preset_rename", { kind: ctx.match[1], presetId: ctx.match[2] });
    await ctx.editMessageText(`✏️ Rename ${preset.name}\n\nSend the new name.`, { reply_markup: { inline_keyboard: [[inline("📊 Cancel", "v1_dashboard_v13")]] } });
  });
  bot.callbackQuery(/^v1_preset_delete_v13:(account|destination|setup):([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = String(ctx.from?.id || ""); const state = readQolState(uid); const items = presetCollection(state, ctx.match[1]); const before = items.length; const next = items.filter(item => item.id !== ctx.match[2]); setPresetCollection(state, ctx.match[1], next); writeQolState(uid, state); await ctx.answerCallbackQuery({ text: before === next.length ? "Preset unavailable" : "Preset deleted" }); await editOrReply(ctx, ctx.match[1] === "account" ? accountPresetsScreen(uid) : ctx.match[1] === "destination" ? destinationPresetsScreen(uid) : postingSetupsScreen(uid));
  });
  bot.callbackQuery("v1_pause_menu_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, pauseMenuScreen(String(ctx.from?.id || ""))); });
  bot.callbackQuery(/^v1_pause_v13:(60|180|tomorrow)$/, async ctx => {
    const uid = String(ctx.from?.id || ""); const until = ctx.match[1] === "tomorrow" ? tomorrowAtLocalMidnight(uid) : Date.now() + Number(ctx.match[1]) * 60_000; setPause(uid, until); await ctx.answerCallbackQuery({ text: "Posting paused" }); await editOrReply(ctx, activityScreen(uid));
  });
  bot.callbackQuery("v1_resume_posting_v13", async ctx => { const uid = String(ctx.from?.id || ""); resumePosting(uid); await ctx.answerCallbackQuery({ text: "Posting resumed" }); await editOrReply(ctx, activityScreen(uid)); });
  bot.callbackQuery("v1_retry_failed_v13", async ctx => {
    const uid = String(ctx.from?.id || ""); await ctx.answerCallbackQuery({ text: "Rechecking failed destinations…" }); try { await recheckDestinations(uid, 30); } catch {} const result = retryFailed(uid); await editOrReply(ctx, { text: ["↻ Retry Failed", "", `Recent failed destinations  ${result.failed}`, `Ready to retry  ${result.reenabled}`, "", readAppSettings(uid).postingEnabled ? "Ready destinations will be retried by the normal posting cycle." : "Ready destinations will be used the next time you Start posting."].join("\n"), rows: [[inline("📊 Activity", "v1_activity_v13")], [inline("⚡ Fix Issues", "v1_fix_issues_v13")]] });
  });
  bot.callbackQuery("v1_dest_browse_from_main_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, destinationBrowseScreen(String(ctx.from?.id || ""))); });
}

export function installUxV13Navigation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotUxV13BotInstalled) return;
  Object.defineProperty(BotClass.prototype, "__telepilotUxV13BotInstalled", { value: true });

  const originalOn = BotClass.prototype.on;
  if (typeof originalOn === "function" && !BotClass.prototype.__telepilotUxV13TextPatched) {
    Object.defineProperty(BotClass.prototype, "__telepilotUxV13TextPatched", { value: true });
    BotClass.prototype.on = function(filter, ...middleware) {
      const isText = filter === "message:text" || (Array.isArray(filter) && filter.includes("message:text"));
      if (isText && !this.__telepilotUxV13TextHandlerRegistered) {
        Object.defineProperty(this, "__telepilotUxV13TextHandlerRegistered", { value: true });
        originalOn.call(this, "message:text", qolTextMiddleware);
      }
      return originalOn.call(this, filter, ...middleware);
    };
  }

  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot v1.3 navigation");
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotUxV13HandlersRegistered) {
      Object.defineProperty(this, "__telepilotUxV13HandlersRegistered", { value: true });
      installCallbacks(this);
    }
    return originalStart.apply(this, args);
  };
}

export function installUxV13(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUxV13ApiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot v1.3 UX");
  Object.defineProperty(ApiClass.prototype, "__telepilotUxV13ApiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = transformScreen(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = transformScreen(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}

let worker = null;
let workerBusy = false;
export function startQolV13Worker() {
  if (worker) return worker;
  const tick = async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      for (const uid of listUserIds()) {
        const state = readQolState(uid);
        if (!state.pauseUntil || state.pauseUntil > Date.now()) continue;
        const pro = readV1(uid);
        if (pro.paused) {
          pro.paused = false;
          writeV1(uid, pro);
        }
        patchQolState(uid, { pauseUntil: 0 });
      }
    } finally { workerBusy = false; }
  };
  worker = setInterval(() => void tick(), 60_000);
  worker.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
  console.log("TelePilot 1.3 QOL worker enabled");
  return worker;
}
