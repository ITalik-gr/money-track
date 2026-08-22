/**
 * The bot's AI-backed commands — `/insight`, `/advice`, `/ask`.
 *
 * Split out of `routes/telegram.ts` on 2026-08-21 under the C3 ceiling, and the seam is the right
 * one anyway: what is left in the route is transport (webhook, chat routing, dispatch), while
 * these three assemble a reply, keep a conversation and render money. `lib/messaging/` already
 * owns everything the bot SAYS — `alert.ts` and `proactive.ts` are its outbound half, and these
 * are the same job with an inbound trigger.
 */
import type { Env } from "../../env.ts";
import type { ChatMsg } from "../ai/ai.ts";
import type { AiFact } from "../ai/generate.ts";
import { buildAndStoreInsight, getStoredInsight } from "../ai/insight.ts";
import { buildAdvice, chatReply, getStoredAdvice } from "../ai/advisor.ts";
import { getState, setState } from "../finance/repo.ts";

import { st, resolveLocale, type ServerLocale } from "../platform/i18n.ts";
import { escapeHtml, tgMoney } from "./tg-format.ts";
import { sendChatAction, sendMessage, getFileBytes } from "./telegram.ts";
import { ingestReceipt } from "../ai/receipt.ts";
import { bar, capMessage } from "./tg-format.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import * as planningRepo from "../../repo/planning.ts";
import * as goalsRepo from "../../repo/goals.ts";
import { budgetStatus } from "../finance/budgets.ts";
import { NOTIF_KINDS, getPrefs, setPrefs } from "./notify.ts";
import { goalPace } from "../finance/goals.ts";
import { sumMonthlyPlannedUAH, chargesBetween } from "../finance/subscriptions.ts";
import { savingsRatePct } from "../finance/finance.ts";
import { getPeriodMode, periodBounds, valueMode, type Preset } from "../finance/stats.ts";
import { getRates, toBaseMinor, uahToBaseMinor, resolveBaseCurrency } from "../finance/money.ts";

/** Same resolve as the route's `tgCtx`; a bot reply has no request, so both read stored state. */
async function ctx(env: Env): Promise<{ locale: ServerLocale; base: number }> {
  const [locale, base] = await Promise.all([resolveLocale(env), resolveBaseCurrency(env)]);
  return { locale, base };
}

// ---- Phase 2: AI insight / advice / ask -------------------------------------

// Факти AI (amount — у грн major) у рядок з тоном-емодзі.
function renderFacts(facts: AiFact[], base: number, locale: ServerLocale): string {
  return facts.map((f) => {
    const dot = f.tone === "pos" ? "🟢" : f.tone === "neg" ? "🔴" : "•";
    const parts = [escapeHtml(f.label)];
    // The insight stores MAJOR units already converted into the reader's base, so the sign has to
    // be the base's — a ₴ literal here printed hryvnia over dollars.
    if (f.amount != null) parts.push(`<b>${tgMoney(f.amount * 100, base, locale)}</b>`);
    if (f.category) parts.push(escapeHtml(f.category));
    if (f.delta_pct != null) parts.push(`${f.delta_pct > 0 ? "+" : ""}${f.delta_pct}%`);
    return `${dot} ${parts.join(" · ")}`;
  }).join("\n");
}

export async function handleInsight(env: Env, chatId: number): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await ctx(env);
  await sendChatAction(token, chatId, "typing");
  let ins = await getStoredInsight(env);
  if ((!ins || ins.empty) && env.ANTHROPIC_API_KEY) {
    try { ins = await buildAndStoreInsight(env); } catch { /* fall through */ }
  }
  if (!ins || ins.empty) { await sendMessage(token, chatId, st(locale, "tgNoInsightData")); return; }
  const s = ins.structured;
  const body = s
    ? `<b>${escapeHtml(s.headline)}</b>\n\n${renderFacts(s.facts, base, locale)}${s.note ? `\n\n💡 ${escapeHtml(s.note)}` : ""}`
    : escapeHtml(ins.text);
  await sendMessage(token, chatId, "📊 " + body);
}

export async function handleAdvice(env: Env, chatId: number): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale } = await ctx(env);
  await sendChatAction(token, chatId, "typing");
  let adv = await getStoredAdvice(env);
  if (!adv && env.ANTHROPIC_API_KEY) {
    try { adv = await buildAdvice(env); } catch { /* fall through */ }
  }
  if (!adv) { await sendMessage(token, chatId, st(locale, "tgNoAdvice")); return; }
  const runway = adv.runway_months != null ? st(locale, "tgRunway", { months: adv.runway_months }) + "\n" : "";
  const steps = (adv.suggestions ?? []).map((x, i) => `${i + 1}. <b>${escapeHtml(x.title)}</b>\n   ${escapeHtml(x.detail)}`).join("\n");
  await sendMessage(token, chatId, `${runway}${escapeHtml(adv.summary || adv.runway_comment)}\n\n${steps}`);
}

const chatHistKey = (chatId: number) => `tg_chat_${chatId}`;

export async function handleAsk(env: Env, chatId: number, question: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale } = await ctx(env);
  if (!env.ANTHROPIC_API_KEY) { await sendMessage(token, chatId, st(locale, "tgNoAiKey")); return; }
  if (!question.trim()) { await sendMessage(token, chatId, st(locale, "tgAskUsage")); return; }

  const raw = await getState(env.DB, chatHistKey(chatId));
  const history: ChatMsg[] = raw ? JSON.parse(raw) : [];
  const messages: ChatMsg[] = [...history, { role: "user" as const, content: question.trim() }].slice(-8);

  await sendChatAction(token, chatId, "typing");
  try {
    const { reply } = await chatReply(env, messages);
    await sendMessage(token, chatId, escapeHtml(reply));
    // Зберігаємо останні ~8 ходів діалогу на цей chat_id.
    await setState(env.DB, chatHistKey(chatId), JSON.stringify([...messages, { role: "assistant" as const, content: reply }].slice(-8)));
  } catch {
    await sendMessage(token, chatId, st(locale, "tgAnswerFailed"));
  }
}

// ---- update handling --------------------------------------------------------


// ---- statistics (2026-08-21) -------------------------------------------------
//
// ⚠️ **Every number below comes from the canon, and none of it is computed here.** That is the
// whole design constraint: a bot with its own SQL is how the app came to quote two different
// budget figures for the same envelope (fixed 2026-07-31, and a THIRD copy found in `alert.ts`
// on 2026-08-21). `/stats` reads `periodTotals` + `spendByCategory`, `/budget` reads
// `budgetStatus`, `/subs` reads `monthlyPlannedUAH` + `chargesBetween`, `/goals` reads `goalPace`.
// If a figure here ever disagrees with the web app, the bug is upstream of this file.

export async function handleStats(env: Env, chatId: number, arg: string, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await ctx(env);
  const preset: Preset = arg.trim().startsWith("week") ? "week" : "month";
  const mode = await getPeriodMode(env.DB);
  const { from, to } = periodBounds(mode, preset, Math.floor(Date.now() / 1000));
  const rates = await getRates(env);
  const v = valueMode(rates, null);

  const [totals, cats] = await Promise.all([
    analyticsRepo.periodTotals(env.DB, v, { from, to }),
    analyticsRepo.spendByCategory(env.DB, locale, v, { from, to }),
  ]);

  const m = (minor: number) => tgMoney(minor, base, locale);
  const rate = savingsRatePct(totals.income, totals.spend);
  const lines = [
    st(locale, "tgStatsHeader", { period: st(locale, preset === "week" ? "tgStatsWeek" : "tgStatsMonth") }),
    "",
    `${st(locale, "tgStatsSpend")}: <b>${m(totals.spend)}</b>`,
    `${st(locale, "tgStatsIncome")}: <b>${m(totals.income)}</b>`,
    `${st(locale, "tgStatsNet")}: <b>${m(totals.income - totals.spend)}</b>`,
    // §savingsRatePct — `null` when there was no income, and it says so in words rather than
    // printing 0%: a month with nothing coming in supports no verdict about saving.
    rate != null ? st(locale, "tgStatsSaved", { pct: rate }) : st(locale, "tgStatsNoIncome"),
  ];

  if (!cats.length) {
    await sendMessage(token, chatId, lines.join("\n") + "\n\n" + st(locale, "tgStatsEmpty"));
    return;
  }
  // The bar is each category against the BIGGEST one, not against the total: at five rows a share
  // of the total is mostly empty track, and the question the list answers is which line dominates.
  const top = cats.slice(0, 7);
  const max = Math.max(...top.map((c) => c.spent), 1);
  lines.push("", st(locale, "tgStatsTopCats"));
  for (const c of top) {
    const name = escapeHtml(c.category_name ?? st(locale, "tgUncategorized"));
    lines.push(`${bar(c.spent / max, 8)}  <b>${m(c.spent)}</b> — ${name}`);
  }
  await sendMessage(token, chatId, capMessage(lines.join("\n"), st(locale, "tgTruncated")) + appLink(origin, "/stats", locale));
}

export async function handleBudget(env: Env, chatId: number, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await ctx(env);
  const { mult } = valueMode(await getRates(env), null);
  const rows = await budgetStatus(env, mult);
  if (!rows.length) { await sendMessage(token, chatId, st(locale, "tgBudgetEmpty")); return; }

  const m = (minor: number) => tgMoney(minor, base, locale);
  // Worst first: the reader opens this to find out what needs attention, and alphabetical order
  // makes them read all of it to find out nothing is wrong.
  const sorted = [...rows].sort((a, b) => b.ratio - a.ratio);
  const lines = [st(locale, "tgBudgetHeader"), ""];
  for (const b of sorted) {
    const dot = b.ratio >= 1 ? "🔴" : b.ratio >= 0.9 ? "🟠" : "🟢";
    if (b.base_amount === 0) {
      // §BUDGET-ZERO: no percentage of nothing. The envelope is kept or it is broken.
      lines.push(`${dot} <b>${escapeHtml(b.name)}</b> — ${st(locale, "tgBudgetZero", {
        state: st(locale, b.spent > 0 ? "tgBudgetZeroBroken" : "tgBudgetZeroKept"),
      })}`);
      continue;
    }
    const tail = b.lumpy
      // §BUDGET-FORECAST: `projected === spent` means two different things, and saying "projected
      // 4 000" over a rent payment that simply has not moved would read as a forecast.
      ? st(locale, "tgBudgetLumpy")
      : st(locale, "tgBudgetProjected", { amount: m(b.projected) });
    lines.push(
      `${dot} <b>${escapeHtml(b.name)}</b>  ${bar(b.ratio, 8)} ${Math.round(b.ratio * 100)}%`,
      `   ${m(b.spent)} / ${m(b.amount)} · ${tail}`,
    );
  }
  await sendMessage(token, chatId, capMessage(lines.join("\n"), st(locale, "tgTruncated")) + appLink(origin, "/plan", locale));
}

export async function handleSubs(env: Env, chatId: number, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await ctx(env);
  const now = Math.floor(Date.now() / 1000);
  const rates = await getRates(env);
  const plans = await planningRepo.activeWithTitles(env.DB);
  if (!plans.length) { await sendMessage(token, chatId, st(locale, "tgSubsEmpty")); return; }

  const m = (minor: number) => tgMoney(minor, base, locale);
  // §SUB-MONTH — the AVERAGED burden, from the canon. Summing `period_amount` here would make a
  // quarterly plan weigh its full charge every month, which is the bug the rule exists for.
  const burden = sumMonthlyPlannedUAH(plans, rates, now);
  const lines = [
    st(locale, "tgSubsHeader"), "",
    st(locale, "tgSubsBurden", { amount: m(burden), year: m(burden * 12) }),
  ];

  // …and the SCHEDULE, which is a different question: a quarterly plan is either in the next
  // seven days or it is not.
  const soon = chargesBetween(plans, rates, now, now + 7 * 86400);
  lines.push("", soon.length ? st(locale, "tgSubsNext") : st(locale, "tgSubsNone7"));
  for (const ch of soon.slice(0, 12)) {
    const day = new Date(ch.at * 1000).toLocaleDateString(locale === "en" ? "en-US" : "uk-UA",
      { day: "2-digit", month: "short" });
    lines.push(`• ${escapeHtml(ch.plan.title)} — <b>${m(ch.amount)}</b> · ${day}`);
  }
  await sendMessage(token, chatId, capMessage(lines.join("\n"), st(locale, "tgTruncated")) + appLink(origin, "/subscriptions", locale));
}

export async function handleGoals(env: Env, chatId: number, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await ctx(env);
  const now = Math.floor(Date.now() / 1000);
  const rates = await getRates(env);
  const goals = await goalsRepo.listActive(env.DB);
  if (!goals.length) { await sendMessage(token, chatId, st(locale, "tgGoalsEmpty")); return; }

  const m = (minor: number) => tgMoney(minor, base, locale);
  const lines = [st(locale, "tgGoalsHeader"), ""];
  for (const g of goals) {
    // §BASE-CUR: a jar's progress is its ACCOUNT balance in the account's currency; a manual
    // goal's is stored in hryvnia. Two origins, two conversions — the same split `/goals` makes.
    const current = g.account_id != null && g.account_balance != null
      ? toBaseMinor(g.account_balance, g.account_currency ?? 980, rates)
      : uahToBaseMinor(g.current_amount, rates);
    const target = uahToBaseMinor(g.target_amount, rates);
    const pace = goalPace({ target_amount: target, current, deadline: g.deadline, created_at: g.created_at }, now);

    const statusKey = pace.status === "behind" ? "tgGoalBehind"
      : pace.status === "at_risk" ? "tgGoalAtRisk"
      : pace.status === "done" ? "tgGoalDone" : "tgGoalOnTrack";
    const dot = pace.status === "behind" || pace.status === "at_risk" ? "🟠" : "🟢";
    const ratio = target > 0 ? current / target : 0;
    lines.push(`${dot} <b>${escapeHtml(g.name)}</b>  ${bar(ratio, 8)} ${Math.round(ratio * 100)}%`);
    // §GOAL-PACE: there is NO monthly rate inside the last month — "save 120 000/mo" with 20 days
    // left is arithmetically true and practically nonsense, so it falls back on what is left.
    const need = pace.per_month != null
      ? st(locale, "tgGoalPerMonth", { amount: m(pace.per_month) })
      : st(locale, "tgGoalLeft", { amount: m(Math.max(0, target - current)) });
    lines.push(`   ${m(current)} / ${m(target)} · ${st(locale, statusKey)} · ${need}`);
  }
  await sendMessage(token, chatId, capMessage(lines.join("\n"), st(locale, "tgTruncated")) + appLink(origin, "/goals", locale));
}

// ---- two-way: settings from the chat, links back to the app (2026-08-21) -----
//
// The bot has been a one-way pipe with a few read commands. These two directions close it:
// a reply that can be opened in the app, and a SETTING that can be changed from the chat.
//
// ⚠️ The app origin comes from the webhook request URL, not from a constant. The bot is served by
// the same Worker as the app, so `new URL(req.url).origin` is by construction the deployment the
// reader is actually using — a configured value would be one more thing to get wrong per
// environment, and it would be wrong silently (a link to production from a preview deploy).

/** «Open in the app», appended to a reply. Omitted when the origin is unknown rather than guessed. */
export function appLink(origin: string | undefined, path: string, locale: ServerLocale): string {
  return origin ? `\n\n🔗 <a href="${origin}${path}">${st(locale, "tgOpenApp")}</a>` : "";
}

/**
 * `/notify` — what the feed is allowed to say, and how to change it FROM HERE.
 *
 * The same `notify_prefs` the Settings page writes, through the same `getPrefs`/`setPrefs`. A
 * person who muted a type in the app sees it muted here, and the reverse, because there is one
 * store and no second copy of the defaults.
 */
export async function handleNotify(env: Env, chatId: number, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale } = await ctx(env);
  const prefs = await getPrefs(env);
  const lines = [st(locale, "tgNotifyHeader"), ""];
  // The CODE and nothing else, deliberately. A human-readable label per kind exists in the
  // client dictionary (`notif.kind.*`), and copying those fourteen strings server-side would be
  // one more label set to keep in step — the exact duplication this codebase spent the day
  // removing. The code is what `/mute` takes, so a bare list is self-documenting.
  for (const k of NOTIF_KINDS) {
    lines.push(`${prefs[k] === false ? "🔕" : "🔔"} <code>${k}</code>`);
  }
  lines.push("", st(locale, "tgNotifyHint", { example: NOTIF_KINDS[3] }));
  await sendMessage(token, chatId, lines.join("\n") + appLink(origin, "/settings", locale));
}

/** `/mute <kind>` and `/unmute <kind>` — the write half of the same setting. */
export async function handleMute(env: Env, chatId: number, arg: string, on: boolean): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale } = await ctx(env);
  const kind = arg.trim().toLowerCase();
  if (!kind) { await sendMessage(token, chatId, st(locale, "tgNotifyUsage")); return; }
  // Validated against the canonical list rather than written blind: `setPrefs` takes a partial,
  // so an unknown key would be stored happily and silently do nothing forever.
  if (!(NOTIF_KINDS as string[]).includes(kind)) {
    await sendMessage(token, chatId, st(locale, "tgNotifyUnknown", { kind: escapeHtml(kind) }));
    return;
  }
  await setPrefs(env, { [kind]: on } as Record<string, boolean>);
  await sendMessage(token, chatId, st(locale, on ? "tgNotifyUnmuted" : "tgNotifyMuted", { kind }));
}

/**
 * `/unlink` — detach this chat, from the chat.
 *
 * The app has a button for it, and that is not enough: someone who has lost access to the web app
 * (a shared device, a forgotten password on a phone that still gets the pushes) could stop the
 * messages nowhere. Detaching is the one action a channel must always be able to perform on
 * itself. The same single writer as everywhere else, so the routing index goes with it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the dispatcher passes a chat to
// every handler; keeping the shape uniform is worth more than one unused parameter.
export async function handleUnlink(env: Env, _chatId: number): Promise<void> {
  const { unlinkTgChat } = await import("./tg-target.ts");
  // The confirmation is sent by `unlinkTgChat` itself (2026-08-21) — it goes to the chat that was
  // attached, which is this one here and is NOT this one when the button in Settings is pressed.
  // Saying it twice from here would double it on the path people actually use.
  await unlinkTgChat(env);
}

/**
 * A photographed receipt, turned into a transaction.
 *
 * Moved here from `routes/telegram.ts` on 2026-08-21 under the C3 ceiling. It belongs with the
 * other things the bot SAYS: the route is left with the webhook, the routing and the dispatch,
 * while assembling a reply out of an AI result is this module's job — the same cut the AI commands
 * took an hour earlier.
 */
export async function handlePhoto(env: Env, chatId: number, fileId: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale } = await ctx(env);
  if (!env.ANTHROPIC_API_KEY) {
    await sendMessage(token, chatId, st(locale, "tgNoAiKeyReceipt"));
    return;
  }
  await sendChatAction(token, chatId, "typing");
  try {
    const { bytes, mediaType } = await getFileBytes(token, fileId);
    const out = await ingestReceipt(env, bytes, mediaType);
    const items = out.result.items.length
      ? "\n" + out.result.items.slice(0, 15).map((it) => `• ${escapeHtml(it.name)} — ${tgMoney(Math.round(it.price * 100), out.result.currency === "USD" ? 840 : out.result.currency === "EUR" ? 978 : 980, locale)}`).join("\n")
      : "";
    const status = st(locale, out.matched ? "tgReceiptMatched" : "tgReceiptCash");
    // The receipt total is in the currency the SHOP charged, which `ingestReceipt` reports — the
    // same reasoning as the confirmation line: this is what was paid, not a roll-up.
    const cur = out.result.currency === "USD" ? 840 : out.result.currency === "EUR" ? 978 : 980;
    await sendMessage(
      token, chatId,
      `<b>${escapeHtml(out.result.store || st(locale, "tgReceiptFallbackName"))}</b> — ${tgMoney(Math.round(out.result.total * 100), cur, locale)}\n${status}${items}`,
    );
  } catch {
    await sendMessage(token, chatId, st(locale, "tgReceiptFailed"));
  }
}
