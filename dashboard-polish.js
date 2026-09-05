const FLYING_DUCK_ID = BigInt("0x4899877500001e52").toString();

function cloneOptions(options) {
  return {
    ...(options || {}),
    ...(Array.isArray(options?.entities)
      ? { entities: options.entities.map(entity => ({ ...entity })) }
      : {}),
  };
}

function replaceText(text, entities, needle, replacement) {
  const start = text.indexOf(needle);
  if (start < 0) return text;
  const end = start + needle.length;
  const delta = replacement.length - needle.length;

  for (let i = entities.length - 1; i >= 0; i--) {
    const entity = entities[i];
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= start) continue;
    if (entity.offset >= end) {
      entity.offset += delta;
      continue;
    }
    entities.splice(i, 1);
  }

  return text.slice(0, start) + replacement + text.slice(end);
}

function styleLabel(entities, text, label, italic = false) {
  const offset = text.indexOf(label);
  if (offset < 0) return;
  entities.push({ type: "bold", offset, length: label.length });
  if (italic) entities.push({ type: "italic", offset, length: label.length });
}

function polishDashboard(text, options) {
  if (!String(text || "").startsWith("✈️ TelePilot")) return { text, options };

  const next = cloneOptions(options);
  const entities = Array.isArray(next.entities) ? next.entities : [];
  const premiumActive = entities.some(entity => entity.type === "custom_emoji");
  let value = String(text);

  value = replaceText(value, entities, "  ⭐️", "");
  value = replaceText(value, entities, "\nSender  ", "\nSender - ");
  value = replaceText(value, entities, "\nMessage  ", "\nMessage - ");
  value = replaceText(value, entities, "\nDestinations  ", "\nDestinations - ");
  value = replaceText(value, entities, "\nSchedule  ", "\nSchedule - ");
  value = replaceText(value, entities, "\n💎 Access  ", "\n💎 Access - ");

  if (premiumActive) {
    entities.push({
      type: "custom_emoji",
      offset: 0,
      length: "✈️".length,
      custom_emoji_id: FLYING_DUCK_ID,
    });
  }

  styleLabel(entities, value, "TelePilot");
  styleLabel(entities, value, "SETUP");
  styleLabel(entities, value, "READY");
  styleLabel(entities, value, "LIVE");
  styleLabel(entities, value, "Sender");
  styleLabel(entities, value, "Message");
  styleLabel(entities, value, "Destinations", true);
  styleLabel(entities, value, "Schedule", true);
  styleLabel(entities, value, "Next step", true);
  styleLabel(entities, value, "Access", true);

  entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  next.entities = entities;
  return { text: value, options: next };
}

export function installDashboardPolish(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDashboardPolishInstalled) return;
  const send = ApiClass.prototype.sendMessage;
  const edit = ApiClass.prototype.editMessageText;
  if (typeof send !== "function" || typeof edit !== "function") {
    throw new Error("Unsupported grammY Api shape for dashboard polish");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotDashboardPolishInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, options, ...rest) {
    const result = polishDashboard(text, options);
    return send.call(this, chatId, result.text, result.options, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, options, ...rest) {
    const result = polishDashboard(text, options);
    return edit.call(this, chatId, messageId, result.text, result.options, ...rest);
  };
}
