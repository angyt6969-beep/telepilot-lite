from pathlib import Path

p = Path("app.js")
s = p.read_text()

old = '''  if (state.awaiting === "license_key") {
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    const result = redeemLicenseKey(state, ctx.message.text);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!result.ok) {
      const n = await ctx.reply(`❌ ${result.error}\\n\\nSend a valid key or tap Cancel.`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000);
      return;
    }
    clearAwaiting(state);
    const plan = result.record.lifetime ? "Lifetime" : `${result.record.durationDays} days`;
    await autoDeleteNotice(ctx.chat.id, `✅ Key redeemed. ${plan} of TelePilot access activated.`, 8000);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard(state) });
    }
    return;
  }
'''

new = '''  if (state.awaiting === "license_key") {
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    const onboardingComplete = readJson(path.join(userDir(state.uid), "onboarding.json"), {}).completed === true;
    const result = redeemLicenseKey(state, ctx.message.text);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!result.ok) {
      const n = await ctx.reply(`❌ ${result.error}\\n\\nSend a valid key or tap Cancel.`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000);
      return;
    }
    clearAwaiting(state);
    const plan = result.record.lifetime ? "Lifetime" : `${result.record.durationDays} days`;
    if (!onboardingComplete) {
      const expires = result.record.lifetime ? "Lifetime" : formatAccessExpiry(state);
      const text = `✅ ACCESS ACTIVATED\\n\\nPlan: ${plan}\\nExpires: ${expires}\\n\\nYour TelePilot account is ready to set up.`;
      const keyboard = new InlineKeyboard()
        .text("🚀 Start Tutorial", "tutorial:begin").row()
        .text("Skip tutorial", "tutorial:skip");
      try { await bot.api.editMessageText(pc, pm, text, { reply_markup: keyboard }); }
      catch { await ctx.reply(text, { reply_markup: keyboard }); }
      return;
    }
    await autoDeleteNotice(ctx.chat.id, `✅ Key redeemed. ${plan} of TelePilot access activated.`, 8000);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard(state) });
    }
    return;
  }
'''

if new in s:
    print("Onboarding access activation patch already applied")
    raise SystemExit(0)

count = s.count(old)
if count != 1:
    raise SystemExit(f"Expected exactly one access redemption block, found {count}; refusing to patch")

p.write_text(s.replace(old, new, 1))
print("Patched first access activation into the tutorial flow")
