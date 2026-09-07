import {
  enqueueJoinRecovery,
  joinQueueSummary,
} from "./destination-join-queue-v1.js";

export function buildRecoveryPlan(review, accounts) {
  const rows = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const candidates = (review?.notJoined || [])
      .filter(candidate => candidate?.sourceKind === "addlist"
        && candidate?.accountJoin?.[String(account.id)]?.status === "not_member")
      .slice(0, 200);
    if (candidates.length) rows.push({ accountId: String(account.id), candidates });
  }
  return rows;
}

export async function recoverNotJoinedAddlistPeers(uid, initialResult) {
  const postReview = initialResult?.postReview;
  const hasAddlistWork = (postReview?.notJoined || []).some(candidate => candidate?.sourceKind === "addlist");
  if (!hasAddlistWork) {
    return {
      ...initialResult,
      recovery: { queued: 0, requeued: 0, summary: joinQueueSummary(uid) },
    };
  }

  const queued = enqueueJoinRecovery(uid, postReview);
  console.log(`TelePilot Addlist recovery queued for ${uid}: created=${queued.created}, requeued=${queued.requeued}, pending=${queued.pending}`);

  return {
    ...initialResult,
    recovery: {
      queued: Number(queued.created || 0),
      requeued: Number(queued.requeued || 0),
      summary: joinQueueSummary(uid),
    },
  };
}
