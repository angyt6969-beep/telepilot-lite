import { TelegramClient } from "teleproto";

const DEFAULT_MIN_GAP_MS = 2_000;
const lastJoinAt = new WeakMap();

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function requiredJoinDelay(lastAt, now, gapMs = DEFAULT_MIN_GAP_MS) {
  const previous = Number(lastAt || 0);
  const current = Number(now || 0);
  const gap = Math.max(0, Number(gapMs || 0));
  if (!previous || !gap) return 0;
  return Math.max(0, previous + gap - current);
}

export function installTelegramJoinPacing(TelegramClientClass = TelegramClient, options = {}) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotJoinPacingInstalled) return false;
  const minGapMs = Math.max(0, Number(options.minGapMs ?? DEFAULT_MIN_GAP_MS));
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const now = typeof options.now === "function" ? options.now : Date.now;

  async function waitTurn(client) {
    const waitMs = requiredJoinDelay(lastJoinAt.get(client), now(), minGapMs);
    if (waitMs > 0) await sleep(waitMs);
    lastJoinAt.set(client, Number(now()));
  }

  function wrapMethod(name) {
    const original = proto[name];
    if (typeof original !== "function") return;
    proto[name] = async function(...args) {
      await waitTurn(this);
      return original.apply(this, args);
    };
  }

  wrapMethod("joinChannel");
  wrapMethod("importChatInvite");
  Object.defineProperty(proto, "__telepilotJoinPacingInstalled", { value: true });
  return true;
}

installTelegramJoinPacing();
console.log(`TelePilot Telegram join pacing enabled (${DEFAULT_MIN_GAP_MS}ms minimum gap)`);

export const __test = { DEFAULT_MIN_GAP_MS };
