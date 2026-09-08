from pathlib import Path

# 1) Defer public username joins to the durable paced queue instead of blasting
# every public source during the synchronous preparation request.
p = Path('destination-preparation-v1.js')
s = p.read_text()
marker = '''async function joinSource(client, parsed) {\n  if (parsed.kind === "public") return joinPublic(client, parsed);\n  if (parsed.kind === "invite") return joinPrivate(client, parsed);\n  if (parsed.kind === "addlist") return joinAddlist(client, parsed);\n  throw new Error("Unsupported destination source");\n}\n'''
addition = marker + '''\nfunction shouldQueueSource(source) {\n  // Public usernames are intentionally handled by destination-join-queue-v1.\n  // That worker performs one join at a time, applies local spacing, and obeys\n  // Telegram FLOOD_WAIT before doing any more work on the account.\n  return source?.kind === "public";\n}\n'''
if 'function shouldQueueSource(source)' not in s:
    assert marker in s, 'joinSource marker changed'
    s = s.replace(marker, addition, 1)

old = '''      for (const source of parsed) {\n        attempted++;\n        try {\n          const result = await joinSource(client, source);\n          accepted += Number(result?.count || 0);\n          if (result?.status === "pending") pending.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)}`);\n        } catch (err) {\n          failures.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)} · ${errorText(err)}`);\n        }\n      }\n'''
new = '''      for (const source of parsed) {\n        if (shouldQueueSource(source)) continue;\n        attempted++;\n        try {\n          const result = await joinSource(client, source);\n          accepted += Number(result?.count || 0);\n          if (result?.status === "pending") pending.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)}`);\n        } catch (err) {\n          failures.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)} · ${errorText(err)}`);\n          // Do not keep issuing join RPCs after Telegram explicitly asks this\n          // account to cool down. Remaining eligible work is recovered by the\n          // durable queue after the post-scan.\n          if (floodWaitSeconds(err)) break;\n        }\n      }\n'''
assert old in s, 'prepare source loop marker changed'
s = s.replace(old, new, 1)
old = '''  findChatForPeer,\n  sourceIdentity,\n};'''
new = '''  findChatForPeer,\n  sourceIdentity,\n  shouldQueueSource,\n};'''
assert old in s, '__test export marker changed'
s = s.replace(old, new, 1)
p.write_text(s)

# 2) Permit verified public @username candidates to use the existing durable
# join queue. Private invite candidates stay out because this queue does not
# persist an invite hash and must not guess how to rejoin them.
p = Path('destination-join-queue-v1.js')
s = p.read_text()
old = '''function candidateNeedsJoin(candidate, accountId) {\n  return candidate?.sourceKind === "addlist"\n    && candidate?.accountJoin?.[String(accountId)]?.status === "not_member";\n}\n'''
new = '''function candidateNeedsJoin(candidate, accountId) {\n  const kind = String(candidate?.sourceKind || "");\n  const username = String(candidate?.username || "").replace(/^@/, "");\n  const supportedSource = kind === "addlist"\n    || (kind === "public" && /^[A-Za-z0-9_]{5,32}$/.test(username));\n  return supportedSource\n    && candidate?.accountJoin?.[String(accountId)]?.status === "not_member";\n}\n'''
assert old in s, 'candidateNeedsJoin marker changed'
s = s.replace(old, new, 1)
s = s.replace('// One-by-one joining is only the fallback after Addlist bulk recovery could not\n// finish the work.', '// One-by-one joining is the safe path for public username joins and the fallback\n// after Addlist bulk recovery could not finish the work.')
p.write_text(s)

# 3) Always enqueue public not-member candidates even when there is no Addlist
# work. Addlist bulk recovery remains unchanged as the preferred path for shared
# folders, after which the same queue handles any residual Addlist/public work.
p = Path('destination-preparation-addlist-recovery.js')
s = p.read_text()
old = '''  if (!hasAddlistWork) {\n    return {\n      ...initialResult,\n      recovery: { bulkAccepted: 0, queued: 0, requeued: 0, summary: joinQueueSummary(uid) },\n    };\n  }\n'''
new = '''  if (!hasAddlistWork) {\n    const queued = enqueueJoinRecovery(uid, postReview);\n    return {\n      ...initialResult,\n      recovery: {\n        bulkAccepted: 0,\n        queued: Number(queued.created || 0),\n        requeued: Number(queued.requeued || 0),\n        summary: joinQueueSummary(uid),\n      },\n    };\n  }\n'''
assert old in s, 'no-addlist recovery marker changed'
s = s.replace(old, new, 1)
# Once a bulk Addlist RPC hits FLOOD_WAIT, stop issuing more bulk requests for
# that account during this synchronous recovery pass. The fallback queue keeps
# the cooldown and resumes later.
old = '''          if (!harmlessEmpty) {\n            bulkFailures.push(`${row.accountId} · addlist:${slug} · ${errorText(err)}`);\n            console.warn(`TelePilot Addlist bulk join failed ${uid}/${row.accountId}/${slug}: ${errorText(err)}`);\n          }\n        }\n'''
new = '''          if (!harmlessEmpty) {\n            bulkFailures.push(`${row.accountId} · addlist:${slug} · ${errorText(err)}`);\n            console.warn(`TelePilot Addlist bulk join failed ${uid}/${row.accountId}/${slug}: ${errorText(err)}`);\n          }\n          if (wait) break;\n        }\n'''
assert old in s, 'bulk error marker changed'
s = s.replace(old, new, 1)
p.write_text(s)

# 4) Make UI copy describe the generic join queue rather than implying every
# error is a shared-folder error.
p = Path('destination-preparation-ui.js')
s = p.read_text()
s = s.replace(
    'Telegram membership is checked first. Addlist groups that still need joining are queued safely instead of being dropped on a flood wait.',
    'Telegram membership is checked first. Missing public and Addlist groups are queued safely and resume automatically after Telegram cooldowns.'
)
s = s.replace('Folder-level join requests pending  ${result.pending.length}', 'Join requests pending  ${result.pending.length}')
s = s.replace('Folder-level join errors  ${failures}', 'Initial join errors  ${failures}')
s = s.replace('First folder-level error: ${result.failures[0]}', 'First join error: ${result.failures[0]}')
p.write_text(s)

# 5) Focused regressions for the exact user-reported public @username case.
p = Path('destination-preparation-v1-test.mjs')
s = p.read_text()
marker = '''assert.equal(mod.floodWaitSeconds({ errorMessage: "FLOOD_WAIT_17" }), 17);\nassert.equal(mod.floodWaitSeconds({ seconds: 9 }), 9);\n'''
addition = marker + '''assert.equal(mod.__test.shouldQueueSource({ kind: "public", username: "sfsmarket2" }), true, "public usernames must be deferred to the paced queue");\nassert.equal(mod.__test.shouldQueueSource({ kind: "addlist", slug: "folder" }), false, "Addlist keeps its bulk-first preparation path");\nassert.equal(mod.__test.shouldQueueSource({ kind: "invite", hash: "abc" }), false, "private invites keep their existing preparation path");\n'''
assert marker in s, 'prep test flood marker changed'
s = s.replace(marker, addition, 1)
p.write_text(s)

p = Path('destination-preparation-addlist-recovery-test.mjs')
s = p.read_text()
marker = '''assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc1"), true);\nassert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc2"), false);\n'''
addition = marker + '''assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[2], "acc1"), true, "public @username groups must enter the durable join queue");\nassert.equal(queue.__test.candidateNeedsJoin({ ...review.notJoined[2], username: "" }, "acc1"), false, "public queue work requires a validated username");\nassert.equal(queue.__test.candidateNeedsJoin({ ...review.notJoined[2], sourceKind: "invite" }, "acc1"), false, "private invite recovery must not be guessed by the username queue");\n'''
assert marker in s, 'queue candidate test marker changed'
s = s.replace(marker, addition, 1)
# Source-level guard: public-only reviews must enqueue instead of taking the old
# zero-work early return.
marker = 'assert.match(recoverySource, /enqueueJoinRecovery/);\n'
addition = marker + 'assert.match(recoverySource, /if \(!hasAddlistWork\) \{[\\s\\S]*?const queued = enqueueJoinRecovery\(uid, postReview\)/, "public-only reviews must still enqueue recovery work");\n'
assert marker in s, 'recovery source test marker changed'
s = s.replace(marker, addition, 1)
p.write_text(s)
