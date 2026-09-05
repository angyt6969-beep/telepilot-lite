from pathlib import Path

P = Path("pro-controls.js")
source = P.read_text()
MARKER = "TELEPILOT_SECURITY_PACK_V1"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_section(text, start, end, replacement, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"{label}: start marker not found")
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f"{label}: end marker not found")
    return text[:a] + replacement.rstrip() + "\n\n" + text[b:]


if MARKER in source:
    print("pro-controls.js security migration already applied")
    raise SystemExit(0)

source = replace_once(
    source,
    '} from "./posting-engine-enhancements.js";\n',
    r'''} from "./posting-engine-enhancements.js";
import {
  appendSecurityEvent,
  assertSafeObject,
  consumeConfirmationToken,
  getExternalSessionKey,
  isSecurityLockdown,
  isUserFrozen,
  issueConfirmationToken,
  signBackupPayload,
  verifyBackupSignature,
} from "./security-core.js";

// TELEPILOT_SECURITY_PACK_V1
''',
    "security imports",
)

source = replace_section(
    source,
    "async function openPersonalClient(uid) {",
    "function toMtprotoEntities(entities = []) {",
    r'''async function openPersonalClient(uid) {
  const payload = fs.readFileSync(sessionPath(uid), "utf8");
  const parsed = JSON.parse(payload);
  let key = null;
  if (parsed?.v === 2 && parsed?.keyVersion === "env") key = getExternalSessionKey();
  else {
    try {
      const legacy = fs.readFileSync(SESSION_KEY_FILE);
      if (legacy.length === 32) key = legacy;
    } catch {}
  }
  if (!key) throw new Error("Personal-session encryption key is unavailable.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const session = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Personal account session is no longer authorized.");
  return client;
}''',
    "session reader",
)

source = replace_section(
    source,
    "function safeExport(uid) {",
    "async function showAdmin(ctx) {",
    r'''const IMPORT_INTERVALS = new Set([1, 5, 10, 15, 30, 45, 60, 90, 120]);
const BACKUP_MAX_BYTES = 256 * 1024;
function safeEntity(entity, textLength) {
  const allowed = new Set([
    "bold", "italic", "underline", "strikethrough", "spoiler", "blockquote",
    "expandable_blockquote", "code", "pre", "text_link", "custom_emoji",
  ]);
  if (!entity || !allowed.has(entity.type)) return null;
  const offset = Number(entity.offset);
  const length = Number(entity.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > textLength) return null;
  const out = { type: entity.type, offset, length };
  if (entity.type === "text_link" && typeof entity.url === "string" && entity.url.length <= 2048) out.url = entity.url;
  if (entity.type === "pre" && typeof entity.language === "string") out.language = entity.language.slice(0, 64);
  if (entity.type === "custom_emoji" && /^\d+$/.test(String(entity.custom_emoji_id || ""))) out.custom_emoji_id = String(entity.custom_emoji_id);
  return out;
}
function safeEntities(entities, textLength) {
  return (Array.isArray(entities) ? entities : []).slice(0, 200).map(item => safeEntity(item, textLength)).filter(Boolean);
}
function safeSchedule(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  const schedule = { ...fallback };
  if (typeof source.enabled === "boolean") schedule.enabled = source.enabled;
  if (Array.isArray(source.days)) {
    const days = [...new Set(source.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    if (days.length) schedule.days = days;
  }
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(source.start || ""))) schedule.start = source.start;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(source.end || ""))) schedule.end = source.end;
  const offset = Number(source.utcOffsetMinutes);
  if (Number.isInteger(offset) && offset >= -840 && offset <= 840) schedule.utcOffsetMinutes = offset;
  return schedule;
}
function backupPayload(uid) {
  const settings = readAppSettings(uid);
  const pro = readProSettings(uid);
  const text = String(settings.adMessage || "").slice(0, 4096);
  return {
    kind: "TelePilotConfig",
    version: 2,
    ownerUid: String(uid),
    exportedAt: new Date().toISOString(),
    message: { text, entities: safeEntities(settings.adEntities, text.length) },
    destinations: (settings.groups || [])
      .filter(group => /^@[A-Za-z0-9_]{5,32}$/.test(String(group.username || "")))
      .slice(0, 1000)
      .map(group => ({
        label: String(group.label || "").slice(0, 120),
        type: String(group.type || "").slice(0, 24),
        username: String(group.username),
      })),
    intervalMinutes: IMPORT_INTERVALS.has(Number(settings.intervalMinutes)) ? Number(settings.intervalMinutes) : 30,
    pro: {
      placeholders: pro.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(pro.staggerSeconds)) ? Number(pro.staggerSeconds) : 0,
      schedule: safeSchedule(pro.schedule, defaultProSettings().schedule),
      templates: (pro.templates || []).slice(0, 20).map(template => {
        const message = String(template.message || "").slice(0, 4096);
        return {
          name: sanitizeName(template.name),
          message,
          entities: safeEntities(template.entities, message.length),
          createdAt: Number(template.createdAt || Date.now()),
        };
      }),
    },
  };
}
function safeExport(uid) {
  const payload = backupPayload(uid);
  return { ...payload, signature: signBackupPayload(payload) };
}
function validateSignedImport(uid, parsed) {
  assertSafeObject(parsed, { maxDepth: 20, maxNodes: 6000 });
  if (parsed?.kind !== "TelePilotConfig" || Number(parsed?.version) !== 2) {
    throw new Error("This backup uses an unsupported format. Create a fresh TelePilot export first.");
  }
  if (String(parsed.ownerUid || "") !== String(uid)) {
    throw new Error("This signed backup belongs to a different Telegram account.");
  }
  const { signature, ...payload } = parsed;
  if (!/^[a-f0-9]{64}$/i.test(String(signature || "")) || !verifyBackupSignature(payload, signature)) {
    throw new Error("Backup signature is invalid or the file was modified.");
  }
  const messageText = String(payload.message?.text || "");
  if (Buffer.byteLength(messageText, "utf8") > 16_384 || messageText.length > 4096) throw new Error("Backup message is too large.");
  const intervalMinutes = Number(payload.intervalMinutes);
  if (!IMPORT_INTERVALS.has(intervalMinutes)) throw new Error("Backup interval is invalid.");
  const destinations = (Array.isArray(payload.destinations) ? payload.destinations : []).slice(0, 1000).map(item => ({
    username: String(item?.username || ""),
    label: String(item?.label || "").slice(0, 120),
    type: String(item?.type || "").slice(0, 24),
  }));
  if (destinations.some(item => !/^@[A-Za-z0-9_]{5,32}$/.test(item.username))) throw new Error("Backup contains an invalid destination.");
  const currentPro = readProSettings(uid);
  const templates = (Array.isArray(payload.pro?.templates) ? payload.pro.templates : []).slice(0, 20).map((template, index) => {
    const message = String(template?.message || "");
    if (message.length > 4096) throw new Error("Backup contains an oversized template.");
    return {
      id: crypto.randomBytes(4).toString("hex"),
      name: sanitizeName(template?.name, `Template ${index + 1}`),
      message,
      entities: safeEntities(template?.entities, message.length),
      createdAt: Date.now(),
    };
  });
  return {
    message: { text: messageText, entities: safeEntities(payload.message?.entities, messageText.length) },
    destinations,
    intervalMinutes,
    pro: {
      placeholders: payload.pro?.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(payload.pro?.staggerSeconds)) ? Number(payload.pro.staggerSeconds) : 0,
      schedule: safeSchedule(payload.pro?.schedule, currentPro.schedule),
      templates,
    },
  };
}
function savePreImportBackup(uid) {
  const file = path.join(userDir(uid), "pre-import-backup.json");
  fs.mkdirSync(userDir(uid), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(safeExport(uid), null, 2), { mode: 0o600 });
}''',
    "signed backup subsystem",
)

source = replace_section(
    source,
    '  bot.callbackQuery("export_config", async ctx => {',
    '  bot.callbackQuery("admin_panel", async ctx => {',
    r'''  bot.callbackQuery("export_config", async ctx => {
    const uid = uidOf(ctx);
    await ctx.answerCallbackQuery({ text: "Preparing signed backup…" });
    const buffer = Buffer.from(JSON.stringify(safeExport(uid), null, 2), "utf8");
    await ctx.replyWithDocument(new InputFile(buffer, "telepilot-backup.json"), {
      caption: "📦 Signed TelePilot backup\n\nSessions, access keys, access status, admin data and login credentials are never included.",
    });
    appendSecurityEvent("backup_exported", { uid });
  });
  bot.callbackQuery("import_config", async ctx => {
    const uid = uidOf(ctx);
    if (isSecurityLockdown() || isUserFrozen(uid)) {
      return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    }
    await ctx.answerCallbackQuery();
    proAwaiting.set(uid, { type: "import", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText(
      "📥 Restore signed backup\n\nSend a TelePilot backup JSON file. The signature and every supported field will be validated before anything changes.",
      { reply_markup: new InlineKeyboard().text("Cancel", "tools") },
    );
  });
  bot.callbackQuery(/^import_config_confirm:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pending = proAwaiting.get(uid);
    if (!consumeConfirmationToken(ctx.match[1], uid, "import", uid) || pending?.type !== "import_confirm") {
      return ctx.answerCallbackQuery({ text: "This restore confirmation expired or was already used.", show_alert: true });
    }
    if (isSecurityLockdown() || isUserFrozen(uid)) {
      return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    }
    proAwaiting.delete(uid);
    await ctx.answerCallbackQuery({ text: "Restoring…" });
    try {
      savePreImportBackup(uid);
      const config = pending.config;
      const importedPro = readProSettings(uid);
      importedPro.schedule = config.pro.schedule;
      importedPro.placeholders = config.pro.placeholders;
      importedPro.staggerSeconds = config.pro.staggerSeconds;
      importedPro.templates = config.pro.templates;
      writeProSettings(uid, importedPro);
      if (config.message.text) await applyMessage(ctx, config.message.text, config.message.entities);
      await applyInterval(ctx, config.intervalMinutes);
      let added = 0;
      for (const destination of config.destinations) {
        try { await applyDestination(ctx, destination.username); added++; } catch {}
      }
      appendSecurityEvent("backup_imported", { uid, destinations: added });
      await ctx.editMessageText(
        `📥 Restore complete\n\n✅ Signed backup verified\n✅ Message/settings restored\n✅ ${added} public destination${added === 1 ? "" : "s"} processed\n\nA signed pre-import rollback backup was saved server-side.`,
        { reply_markup: new InlineKeyboard().text("⬅️ Dashboard", "home") },
      );
    } catch (err) {
      appendSecurityEvent("backup_import_failed", { uid, reason: String(err?.message || err).slice(0, 120) });
      await ctx.editMessageText(
        `📥 Restore backup\n\n❌ ${String(err?.message || "Restore failed").slice(0, 180)}`,
        { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") },
      );
    }
  });''',
    "backup handlers",
)

source = replace_section(
    source,
    '    if (pending?.type === "import" && ctx.message.document) {',
    '    await saveIncomingMedia(ctx);',
    r'''    if (pending?.type === "import" && ctx.message.document) {
      try {
        if (Number(ctx.message.document.file_size || 0) > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const file = await ctx.api.getFile(ctx.message.document.file_id);
        if (!file.file_path) throw new Error("Telegram did not provide the file.");
        const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        if (!response.ok) throw new Error("Could not download backup file.");
        const raw = await response.text();
        if (Buffer.byteLength(raw, "utf8") > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const parsed = JSON.parse(raw);
        const config = validateSignedImport(uid, parsed);
        const token = issueConfirmationToken(uid, "import", uid, 120_000);
        proAwaiting.set(uid, { type: "import_confirm", messageId: pending.messageId, config });
        try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
        await ctx.api.editMessageText(
          ctx.chat.id,
          pending.messageId,
          [
            "📥 BACKUP VERIFIED",
            "",
            `Message: ${config.message.text ? `${config.message.text.length} characters` : "not set"}`,
            `Public destinations: ${config.destinations.length}`,
            `Templates: ${config.pro.templates.length}`,
            `Interval: ${config.intervalMinutes} min`,
            "",
            "TelePilot will make a rollback backup before applying this restore.",
          ].join("\n"),
          { reply_markup: new InlineKeyboard().text("✅ Restore", `import_config_confirm:${token}`).success().row().text("✖️ Cancel", "tools") },
        );
      } catch (err) {
        proAwaiting.delete(uid);
        appendSecurityEvent("backup_import_rejected", { uid, reason: String(err?.message || err).slice(0, 120) });
        await ctx.api.editMessageText(
          ctx.chat.id,
          pending.messageId,
          `📥 Restore backup\n\n❌ ${String(err?.message || err).slice(0, 180)}`,
          { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") },
        );
      }
      return;
    }''',
    "backup document parser",
)

P.write_text(source)
print("pro-controls.js security migration applied")
