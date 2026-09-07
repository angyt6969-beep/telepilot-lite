import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
} from "./account-store.js";
import {
  saveReviewedDestinations,
  scanDestinationSources,
} from "./destinations-v2.js";
import {
  enqueueCleanup,
  runDestinationPreparationTick,
} from "./destination-preparation-v1.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const MAX_DIRECT_RECOVERY_PER_ACCOUNT = 100;
const DIRECT_JOIN_GAP_MS = 350;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function errorText(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220);
}
function errorCode(err) { return errorText(err).toUpperCase(); }
function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const match = errorCode(err).match(/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}
function accountLabel(account) {
  return account?.username ? `@${String(account.username).replace(/^@/, "")}` : String(account?.label || account?.firstName || account?.id || "Telegram account");
}
function candidateAccountNeedsJoin(candidate, accountId) {
  return candidate?.sourceKind === "addlist"
    && candidate?.accountJoin?.[String(accountId)]?.status === "not_member";
}

export function buildRecoveryPlan(review, accounts) {
  const rows = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const candidates = (review?.notJoined || [])
      .filter(candidate => candidateAccountNeedsJoin(candidate, account.id))
      .slice(0, MAX_DIRECT_RECOVERY_PER_ACCOUNT);
    if (candidates.length) rows.push({ accountId: String(account.id), candidates });
  }
  return rows;
}

function inputChannelFromCandidate(candidate) {
  const id = String(candidate?.id || "");
  const accessHash = String(candidate?.accessHash || "");
  if (!/^-100\d+$/.test(id) || !/^\d+$/.test(accessHash)) return null;
  return new Api.InputChannel({
    channelId: bigInt(id.slice(4)),
    accessHash: bigInt(accessHash),
  });
}

async function openAccountClient(uid, account) {
  const session = loadAccountSession(uid, account.id);
  if (!session) throw new Error("Saved Telegram session is missing");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  try {
    const me = await client.getMe();
    updateAccountStatus(uid, account.id, {
      telegramId: me?.id,
      username: me?.username,
      firstName: me?.firstName,
      lastName: me?.lastName,
      status: "connected",
      lastError: "",
      lastVerifiedAt: Date.now(),
    });
  } catch {}
  return client;
}

async function joinCandidate(client, candidate) {
  const username = String(candidate?.username || "").replace(/^@/, "");
  try {
    if (username) {
      await client.joinChannel(`@${username}`);
      return { status: "joined", method: "username" };
    }

    const channel = inputChannelFromCandidate(candidate);
    if (!channel) {
      return { status: "unsupported", method: "none", reason: "This private group cannot be reconstructed from the shared-folder preview." };
    }
    await client.invoke(new Api.channels.JoinChannel({ channel }));
    return { status: "joined", method: "input_channel" };
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("USER_ALREADY_PARTICIPANT")) return { status: "already", method: username ? "username" : "input_channel" };
    if (code.includes("INVITE_REQUEST_SENT")) return { status: "pending", method: username ? "username" : "input_channel" };
    throw err;
  }
}

export async function recoverNotJoinedAddlistPeers(uid, initialResult) {
  const postReview = initialResult?.postReview;
  const sourceText = String(postReview?.sourceText || "").trim();
  if (!sourceText || !(postReview?.notJoined || []).some(candidate => candidate?.sourceKind === "addlist")) {
    return { ...initialResult, recovery: { attempted: 0, joined: 0, pending: 0, errors: [] } };
  }
  if (!API_ID || !API_HASH) throw new Error("Telegram API credentials are not configured");

  const accounts = listAccounts(uid);
  const plan = buildRecoveryPlan(postReview, accounts);
  if (!plan.length) {
    return { ...initialResult, recovery: { attempted: 0, joined: 0, pending: 0, errors: [] } };
  }

  let attempted = 0;
  let joined = 0;
  let pendingCount = 0;
  const errors = [];

  console.log(`TelePilot Addlist recovery starting for ${uid}: ${plan.reduce((sum, row) => sum + row.candidates.length, 0)} not-joined chat(s)`);

  for (const row of plan) {
    const account = accounts.find(item => String(item.id) === row.accountId);
    if (!account) continue;
    let client;
    try {
      client = await openAccountClient(uid, account);
      for (let index = 0; index < row.candidates.length; index++) {
        const candidate = row.candidates[index];
        attempted++;
        try {
          const outcome = await joinCandidate(client, candidate);
          if (outcome.status === "joined" || outcome.status === "already") joined++;
          else if (outcome.status === "pending") pendingCount++;
          else if (outcome.status === "unsupported") errors.push(`${accountLabel(account)} · ${candidate.username || candidate.label} · ${outcome.reason}`);
        } catch (err) {
          const wait = floodWaitSeconds(err);
          errors.push(`${accountLabel(account)} · ${candidate.username || candidate.label} · ${errorText(err)}`);
          if (wait) {
            console.warn(`TelePilot Addlist recovery flood wait for ${uid}/${row.accountId}: ${wait}s; stopping this account recovery batch`);
            break;
          }
        }
        if (index < row.candidates.length - 1) await delay(DIRECT_JOIN_GAP_MS);
      }
    } catch (err) {
      errors.push(`${accountLabel(account)} · ${errorText(err)}`);
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  }

  await delay(800);
  const rescanned = await scanDestinationSources(uid, sourceText);
  rescanned.sourceText = sourceText;
  const recoverySaved = saveReviewedDestinations(uid, rescanned);
  const recoveryCleanup = enqueueCleanup(uid, rescanned);
  void runDestinationPreparationTick();

  const beforeAccessible = new Set((postReview?.accessible || []).map(item => String(item.id)));
  const recoveredAccessible = (rescanned?.accessible || []).filter(item => !beforeAccessible.has(String(item.id))).length;
  const combinedSaved = {
    added: Number(initialResult?.saved?.added || 0) + Number(recoverySaved?.added || 0),
    existing: Number(recoverySaved?.existing || initialResult?.saved?.existing || 0),
    topics: Math.max(Number(initialResult?.saved?.topics || 0), Number(recoverySaved?.topics || 0)),
  };

  console.log(`TelePilot Addlist recovery finished for ${uid}: attempted=${attempted}, directAccepted=${joined}, confirmedAccessible=${rescanned?.accessible?.length || 0}, stillNotJoined=${rescanned?.notJoined?.length || 0}, errors=${errors.length}`);

  return {
    ...initialResult,
    postReview: rescanned,
    saved: combinedSaved,
    cleanup: recoveryCleanup,
    newlyAccessible: Number(initialResult?.newlyAccessible || 0) + recoveredAccessible,
    pending: [...(initialResult?.pending || []), ...Array(pendingCount).fill("Direct join request pending")],
    failures: [...(initialResult?.failures || []), ...errors],
    recovery: { attempted, joined, pending: pendingCount, recoveredAccessible, errors },
  };
}

export const __test = {
  inputChannelFromCandidate,
  candidateAccountNeedsJoin,
};
