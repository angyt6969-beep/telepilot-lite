import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const MAX_HISTORY = 40;
const MAX_PRESETS = 24;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function storePath(uid) { return path.join(userDir(uid), "qol-v13.json"); }

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
function cleanName(value, fallback = "Preset") {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return text || fallback;
}
function cleanId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
}
function cleanPresetList(items) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const id = cleanId(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...raw, id, name: cleanName(raw?.name, "Preset") });
  }
  return out.slice(-MAX_PRESETS);
}
function cleanNotes(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, note] of Object.entries(value)) {
    const id = String(key || "").slice(0, 120);
    const text = String(note || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    if (id && text) out[id] = text;
  }
  return out;
}
function cleanWords(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const word = String(raw || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 /]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (word && !out.includes(word)) out.push(word);
  }
  return out.slice(0, 30);
}

export function defaultQolState() {
  return {
    version: 1,
    pendingInput: null,
    resume: null,
    accountPresets: [],
    destinationPresets: [],
    postingSetups: [],
    destinationNotes: {},
    topicPreference: {
      mode: "suggest",
      words: ["advertising", "ads", "marketplace", "promo", "services", "offers"],
    },
    importHistory: [],
    pauseUntil: 0,
    destinationFilter: "all",
    destinationSearch: "",
  };
}

export function readQolState(uid) {
  const base = defaultQolState();
  const saved = readJson(storePath(uid), {});
  const mode = ["suggest", "auto_exact", "manual"].includes(saved?.topicPreference?.mode)
    ? saved.topicPreference.mode
    : base.topicPreference.mode;
  return {
    ...base,
    ...saved,
    version: 1,
    pendingInput: saved?.pendingInput && typeof saved.pendingInput === "object" ? saved.pendingInput : null,
    resume: saved?.resume && typeof saved.resume === "object" ? saved.resume : null,
    accountPresets: cleanPresetList(saved?.accountPresets),
    destinationPresets: cleanPresetList(saved?.destinationPresets),
    postingSetups: cleanPresetList(saved?.postingSetups),
    destinationNotes: cleanNotes(saved?.destinationNotes),
    topicPreference: {
      mode,
      words: cleanWords(saved?.topicPreference?.words).length
        ? cleanWords(saved.topicPreference.words)
        : base.topicPreference.words,
    },
    importHistory: (Array.isArray(saved?.importHistory) ? saved.importHistory : []).slice(-MAX_HISTORY),
    pauseUntil: Math.max(0, Number(saved?.pauseUntil || 0) || 0),
    destinationFilter: ["all", "ready", "pending", "verification", "topics", "inactive", "forum", "partial"].includes(saved?.destinationFilter)
      ? saved.destinationFilter
      : "all",
    destinationSearch: String(saved?.destinationSearch || "").trim().slice(0, 80),
  };
}

export function writeQolState(uid, value) {
  const current = readQolState(uid);
  const merged = {
    ...current,
    ...(value || {}),
    version: 1,
  };
  merged.accountPresets = cleanPresetList(merged.accountPresets);
  merged.destinationPresets = cleanPresetList(merged.destinationPresets);
  merged.postingSetups = cleanPresetList(merged.postingSetups);
  merged.destinationNotes = cleanNotes(merged.destinationNotes);
  merged.importHistory = (Array.isArray(merged.importHistory) ? merged.importHistory : []).slice(-MAX_HISTORY);
  merged.topicPreference = {
    mode: ["suggest", "auto_exact", "manual"].includes(merged?.topicPreference?.mode) ? merged.topicPreference.mode : "suggest",
    words: cleanWords(merged?.topicPreference?.words).length ? cleanWords(merged.topicPreference.words) : defaultQolState().topicPreference.words,
  };
  writeJsonAtomic(storePath(uid), merged);
  return merged;
}

export function patchQolState(uid, patch = {}) {
  return writeQolState(uid, { ...readQolState(uid), ...patch });
}

export function setPendingInput(uid, pendingInput) {
  return patchQolState(uid, { pendingInput: pendingInput && typeof pendingInput === "object" ? pendingInput : null });
}

export function setResume(uid, section = "", payload = {}) {
  const name = String(section || "").slice(0, 40);
  return patchQolState(uid, {
    resume: name ? { section: name, payload: payload && typeof payload === "object" ? payload : {}, updatedAt: Date.now() } : null,
  });
}

export function clearResume(uid) { return patchQolState(uid, { resume: null }); }

export function makePresetId(prefix = "p") {
  const safe = String(prefix || "p").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "p";
  return `${safe}_${crypto.randomBytes(5).toString("hex")}`;
}

export function nextPresetName(items, baseName) {
  const base = cleanName(baseName, "Preset");
  const used = new Set((Array.isArray(items) ? items : []).map(item => String(item?.name || "").toLowerCase()));
  let n = 1;
  let candidate = `${base} ${n}`;
  while (used.has(candidate.toLowerCase()) && n < 999) candidate = `${base} ${++n}`;
  return candidate;
}

export function appendImportHistory(uid, entry = {}) {
  const state = readQolState(uid);
  const row = {
    id: makePresetId("imp"),
    at: Date.now(),
    source: String(entry.source || "destinations").slice(0, 80),
    added: Math.max(0, Number(entry.added || 0) || 0),
    duplicates: Math.max(0, Number(entry.duplicates || 0) || 0),
    attention: Math.max(0, Number(entry.attention || 0) || 0),
    failed: Math.max(0, Number(entry.failed || 0) || 0),
    destinationIds: [...new Set((Array.isArray(entry.destinationIds) ? entry.destinationIds : []).map(String))].slice(0, 500),
  };
  state.importHistory.push(row);
  state.importHistory = state.importHistory.slice(-MAX_HISTORY);
  writeQolState(uid, state);
  return row;
}

export function setDestinationNote(uid, destinationId, note) {
  const state = readQolState(uid);
  const id = String(destinationId || "");
  if (!id) return state;
  const text = String(note || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  if (text) state.destinationNotes[id] = text;
  else delete state.destinationNotes[id];
  return writeQolState(uid, state);
}
