const EXPIRED_ADDLIST_CODE = "INVITE_SLUG_EXPIRED";
const EMPTY_SHARED_FOLDER_TEXT = /Telegram returned no chats for this shared folder\.?/i;

function sourceCount(review) {
  const explicit = Number(review?.sourceCount || 0);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return String(review?.sourceText || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
}

function unavailableRows(review) {
  return Array.isArray(review?.unavailable) ? review.unavailable.filter(Boolean) : [];
}

function issueText(value) {
  if (typeof value === "string") return value;
  return `${String(value?.code || "")} ${String(value?.reason || "")}`.trim();
}

export function isExpiredAddlistError(value) {
  return issueText(value).toUpperCase().includes(EXPIRED_ADDLIST_CODE);
}

export function hasExpiredAddlist(review) {
  return unavailableRows(review).some(isExpiredAddlistError);
}

export function normalizedUnavailable(review) {
  const rows = unavailableRows(review);
  const expired = rows.filter(isExpiredAddlistError);
  const singleSourceExpired = expired.length > 0 && sourceCount(review) === 1;
  const out = [];
  const seen = new Set();
  let emittedSingleExpired = false;

  for (const item of rows) {
    const reason = String(item?.reason || "");
    if (singleSourceExpired && EMPTY_SHARED_FOLDER_TEXT.test(reason)) continue;

    if (singleSourceExpired && isExpiredAddlistError(item)) {
      if (emittedSingleExpired) continue;
      emittedSingleExpired = true;
      out.push({
        ...item,
        code: EXPIRED_ADDLIST_CODE,
        fatal: true,
        reason: "This shared-folder link has expired in Telegram. Copy a fresh t.me/addlist/... link and scan it again.",
      });
      continue;
    }

    const key = `${String(item?.original || "")}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function reviewCouldNotUseCount(review) {
  return (Array.isArray(review?.invalid) ? review.invalid.length : 0) + normalizedUnavailable(review).length;
}

export function expiredAddlistOnly(review) {
  if (!hasExpiredAddlist(review) || sourceCount(review) !== 1) return false;
  const accessible = Array.isArray(review?.accessible) ? review.accessible.length : 0;
  const notJoined = Array.isArray(review?.notJoined) ? review.notJoined.length : 0;
  return accessible === 0 && notJoined === 0;
}

export function canPrepareReview(review) {
  return Boolean(review?.sourceText) && !expiredAddlistOnly(review);
}

export function expiredAddlistMessage() {
  return "This shared-folder link has expired in Telegram. Copy a fresh t.me/addlist/... link from Telegram and scan it again. TelePilot cannot recover the folder contents from an expired link.";
}

export const __test = {
  sourceCount,
  EMPTY_SHARED_FOLDER_TEXT,
  EXPIRED_ADDLIST_CODE,
};
