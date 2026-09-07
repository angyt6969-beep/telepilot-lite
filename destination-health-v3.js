import crypto from "node:crypto";
import { accountDisplayLabel, listAccounts } from "./account-store.js";
import { readAppSettings } from "./posting-engine-enhancements.js";

const PAGE_SIZE = 8;

function token(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("base64url").slice(0, 11);
}
function inline(text, data) { return { text, callback_data: data }; }
function groupLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }

export function destinationHealthStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "topic";
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return "unchecked";
  if (rows.some(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "not_member")) return "not_member";
  return "issue";
}

export function destinationHealthSummary(uid) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings?.groups) ? settings.groups : [];
  const counts = { total: 0, ready: 0, topic: 0, not_member: 0, unchecked: 0, issue: 0 };
  for (const group of groups) {
    counts.total++;
    const status = destinationHealthStatus(group);
    counts[status] = Number(counts[status] || 0) + 1;
  }
  counts.attention = counts.topic + counts.not_member + counts.unchecked + counts.issue;
  return { groups, counts };
}

function statusIcon(status) {
  return status === "topic" ? "💬" : status === "not_member" ? "↗️" : status === "unchecked" ? "◌" : "⚠️";
}
function statusTitle(status) {
  return status === "topic" ? "Choose a topic"
    : status === "not_member" ? "Join in Telegram"
      : status === "unchecked" ? "Access not checked"
        : "Other Telegram/access issue";
}
function groupIssueReason(group, status) {
  if (status === "topic") return "Choose an open forum topic before TelePilot posts here.";
  if (status === "not_member") return "The selected sender is not currently joined to this destination.";
  if (status === "unchecked") return "TelePilot has no current access result for this destination yet.";
  const rows = Object.values(group?.accountJoin || {});
  const reasons = [...new Set(rows.map(row => String(row?.reason || "").trim()).filter(Boolean))];
  if (reasons.length) return reasons.slice(0, 2).join(" · ");
  const statuses = [...new Set(rows.map(row => String(row?.status || "unknown")).filter(Boolean))];
  return statuses.length ? `Telegram access status: ${statuses.join(", ")}.` : "Telegram access needs review.";
}
function issueGroups(uid) {
  return destinationHealthSummary(uid).groups
    .map(group => ({ group, status: destinationHealthStatus(group) }))
    .filter(row => row.status !== "ready");
}
function groupByToken(uid, value) {
  return destinationHealthSummary(uid).groups.find(group => token(group.id) === String(value)) || null;
}
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }

export function destinationIssuesScreen(uid, page = 0) {
  const summary = destinationHealthSummary(uid);
  const issues = issueGroups(uid);
  const pages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = issues.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const lines = slice.map(({ group, status }, index) => {
    const n = current * PAGE_SIZE + index + 1;
    return `${n}. ${statusIcon(status)} ${groupLabel(group)}\n   ${statusTitle(status)} — ${groupIssueReason(group, status)}`;
  });
  const rows = slice.map(({ group, status }) => [inline(`${statusIcon(status)} ${groupLabel(group).slice(0, 38)}`, `d5_issue:${token(group.id)}:${current}`)]);
  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push(inline("◀", `d5_issues:${current - 1}`));
    nav.push(inline(`${current + 1}/${pages}`, "d5_noop"));
    if (current < pages - 1) nav.push(inline("▶", `d5_issues:${current + 1}`));
    rows.push(nav);
  }
  rows.push([inline("↻ Check access", "d2_refresh"), inline("📁 Destination Hub", "v1_destinations_v13")]);
  return {
    text: [
      "⚠️ Review Destination Issues",
      "",
      `Needs attention  ${summary.counts.attention} / ${summary.counts.total}`,
      summary.counts.topic ? `💬 Choose topic  ${summary.counts.topic}` : null,
      summary.counts.not_member ? `↗️ Join in Telegram  ${summary.counts.not_member}` : null,
      summary.counts.unchecked ? `◌ Not checked yet  ${summary.counts.unchecked}` : null,
      summary.counts.issue ? `⚠️ Other issues  ${summary.counts.issue}` : null,
      "",
      lines.length ? lines.join("\n\n") : "Everything currently looks ready.",
      issues.length > PAGE_SIZE ? `\nShowing ${current * PAGE_SIZE + 1}-${current * PAGE_SIZE + slice.length} of ${issues.length}.` : null,
    ].filter(Boolean).join("\n"),
    rows,
  };
}

export function destinationIssueDetailScreen(uid, group, page = 0) {
  const status = destinationHealthStatus(group);
  const accounts = listAccounts(uid);
  const accessLines = Object.entries(group?.accountJoin || {}).map(([accountId, row]) => {
    const account = accounts.find(item => String(item.id) === String(accountId));
    const label = account ? accountDisplayLabel(account) : `Account ${accountId}`;
    const state = String(row?.status || "unchecked");
    const reason = String(row?.reason || "").trim();
    return `${state === "ready" ? "✅" : "⚠️"} ${label}\n   ${state}${reason ? ` — ${reason}` : ""}`;
  });
  const rows = [];
  if (status === "topic") rows.push([inline("💬 Choose topic", `d2_topic_open:${token(group.id)}:0`)]);
  rows.push([inline("↻ Check access", "d2_refresh")]);
  rows.push([inline("← Review Issues", `d5_issues:${Number(page) || 0}`)]);
  return {
    text: [
      `${statusIcon(status)} ${groupLabel(group)}`,
      "",
      `Status  ${statusTitle(status)}`,
      `What it means  ${groupIssueReason(group, status)}`,
      group?.topicRequired ? `Topic  ${group?.topicTitle || "Not selected"}` : null,
      "",
      accessLines.length ? accessLines.join("\n\n") : "No sender-access result is stored for this destination yet.",
      "",
      status === "topic" ? "Choose an open topic, then retry the next posting cycle."
        : status === "not_member" ? "Join the destination with the selected sender account, then run Check access."
          : status === "unchecked" ? "Run Check access to refresh this destination."
            : "Use the exact Telegram/access reason above to fix this destination, then run Check access.",
    ].filter(Boolean).join("\n"),
    rows,
  };
}

function enhancedHub(uid, base) {
  const { counts } = destinationHealthSummary(uid);
  const lines = String(base?.text || "").split("\n");
  const existing = new Set(lines.map(line => line.trim()));
  const insertAtRaw = lines.findIndex(line => line.startsWith("TelePilot only uses"));
  const insertAt = insertAtRaw >= 0 ? insertAtRaw : lines.length;
  const healthLines = [];
  if (counts.unchecked && ![...existing].some(line => line.startsWith("Not checked yet"))) healthLines.push(`Not checked yet  ${counts.unchecked}`);
  if (counts.issue) healthLines.push(`Other issues  ${counts.issue}`);
  if (counts.attention) healthLines.push(`Needs attention  ${counts.attention}`);
  if (healthLines.length) lines.splice(insertAt, 0, ...healthLines, "");
  const rows = Array.isArray(base?.rows) ? base.rows.map(row => Array.isArray(row) ? row.map(button => ({ ...button })) : row) : [];
  if (counts.attention && !rows.flat().some(button => button?.callback_data === "d5_issues:0")) {
    const dashboardIndex = rows.findIndex(row => row?.some?.(button => button?.callback_data === "v1_dashboard_v13"));
    const issueRow = [inline(`⚠ Review Issues · ${counts.attention}`, "d5_issues:0")];
    if (dashboardIndex >= 0) rows.splice(dashboardIndex, 0, issueRow); else rows.push(issueRow);
  }
  return { ...base, text: lines.join("\n"), rows };
}

function transformDashboardPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const text = String(payload.text || "");
  const match = text.match(/[⚠❗]\ufe0f?\s*(\d+)\s+items?\s+need attention/i);
  if (!match) return payload;
  const count = Number(match[1] || 0);
  const next = { ...payload, text: text.replace(match[0], `⚠ ${count} destinations need attention — tap Review Issues`) };
  const markup = payload.reply_markup;
  if (markup && Array.isArray(markup.inline_keyboard)) {
    const rows = markup.inline_keyboard.map(row => row.map(button => ({ ...button })));
    if (!rows.flat().some(button => button?.callback_data === "d5_issues:0")) {
      const insertAt = rows.findIndex(row => row.some(button => button?.callback_data === "admin"));
      rows.splice(insertAt >= 0 ? insertAt : rows.length, 0, [inline(`⚠ Review Issues · ${count}`, "d5_issues:0")]);
    }
    next.reply_markup = { ...markup, inline_keyboard: rows };
  }
  return next;
}

function installDashboardTransformer(bot) {
  if (!bot?.api?.config?.use || bot.__telepilotDestinationHealthTransformerInstalled) return false;
  Object.defineProperty(bot, "__telepilotDestinationHealthTransformerInstalled", { value: true });
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "sendMessage" || method === "editMessageText") {
      return prev(method, transformDashboardPayload(payload), signal);
    }
    return prev(method, payload, signal);
  });
  return true;
}

export function installDestinationHealthV3(BotClass, destinationsHomeScreen) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationHealthV3Installed) return false;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination health v3");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationHealthV3Installed", { value: true });
  BotClass.prototype.start = function(...args) {
    installDashboardTransformer(this);
    if (!this.__telepilotDestinationHealthV3Handlers) {
      Object.defineProperty(this, "__telepilotDestinationHealthV3Handlers", { value: true });
      this.callbackQuery(/^d5_issues:(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const screen = destinationIssuesScreen(uid, Number(ctx.match[1]));
        await ctx.editMessageText(screen.text, { reply_markup: keyboard(screen.rows) }).catch(() => ctx.reply(screen.text, { reply_markup: keyboard(screen.rows) }));
      });
      this.callbackQuery(/^d5_issue:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const group = groupByToken(uid, ctx.match[1]);
        const screen = group ? destinationIssueDetailScreen(uid, group, Number(ctx.match[2])) : destinationIssuesScreen(uid, 0);
        await ctx.editMessageText(screen.text, { reply_markup: keyboard(screen.rows) }).catch(() => ctx.reply(screen.text, { reply_markup: keyboard(screen.rows) }));
      });
      this.callbackQuery("d5_noop", async ctx => { await ctx.answerCallbackQuery(); });
      this.callbackQuery("v1_destinations_v13", async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const screen = enhancedHub(uid, destinationsHomeScreen(uid));
        await ctx.editMessageText(screen.text, { reply_markup: keyboard(screen.rows) }).catch(() => ctx.reply(screen.text, { reply_markup: keyboard(screen.rows) }));
      });
      this.callbackQuery("v1_dest_issues_v13", async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const screen = destinationIssuesScreen(uid, 0);
        await ctx.editMessageText(screen.text, { reply_markup: keyboard(screen.rows) }).catch(() => ctx.reply(screen.text, { reply_markup: keyboard(screen.rows) }));
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export const __test = { enhancedHub, transformDashboardPayload, groupIssueReason };
