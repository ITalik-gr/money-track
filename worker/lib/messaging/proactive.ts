// Telegram Фаза 3 — проактивність (§ROADMAP): раз на тиждень пушимо в TG свіжий
// інсайт і попереджаємо про перевищені/майже вичерпані бюджети-конверти. Гейт —
// налаштовані TG-секрети (TG_BOT_TOKEN + TG_CHAT_ID). Викликається з кроном.
import type { Env } from "../../env.ts";
import { sendMessage } from "./telegram.ts";
import { getStoredInsight, buildAndStoreInsight, type StoredInsight } from "../ai/insight.ts";
import { nextChargeUnix } from "../finance/subscriptions.ts";
import { valueMode } from "../finance/stats.ts";
import { budgetStatus } from "../finance/budgets.ts";
import { getRates } from "../finance/money.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uah = (minor: number) => Math.round(minor / 100).toLocaleString("uk-UA");

function insightText(ins: StoredInsight): string {
  const s = ins.structured;
  if (!s) return esc(ins.text);
  const facts = (s.facts ?? []).map((f) => {
    const parts: string[] = [];
    if (f.amount != null) parts.push(`<b>${f.amount.toLocaleString("uk-UA")} ₴</b>`);
    if (f.category) parts.push(esc(f.category));
    if (f.delta_pct != null) parts.push(`${f.delta_pct > 0 ? "+" : ""}${f.delta_pct}%`);
    const dot = f.tone === "neg" ? "🔴" : f.tone === "pos" ? "🟢" : "•";
    return `${dot} ${esc(f.label)}: ${parts.join(" · ")}`;
  }).join("\n");
  return `<b>${esc(s.headline)}</b>\n\n${facts}${s.note ? `\n\n💡 ${esc(s.note)}` : ""}`;
}

// Перевищені / майже вичерпані бюджети-конверти цього місяця.
//
// Розрахунок — канонічний `budgetStatus` (stats.ts), той самий, що наповнює стрічку сповіщень.
// Раніше тут жив власний SQL (`t.hold = 0 AND t.is_transfer = 0 AND t.currency_code = 980`), і
// саме тому Telegram казав про той самий бюджет інше число, ніж застосунок: він рахував спліт
// повною сумою, не віднімав компенсації, викидав усі валютні витрати замість зводити їх у ₴ і
// не робив рол-ап зняття за реальною категорією.
async function overBudget(env: Env): Promise<{ name: string; spent: number; budget: number; ratio: number }[]> {
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  return (await budgetStatus(env, mult))
    .filter((b) => b.ratio >= 0.9)
    .map((b) => ({ name: b.name, spent: b.spent, budget: b.amount, ratio: b.ratio }))
    .sort((a, b) => b.ratio - a.ratio);
}

interface PlannedRow {
  title: string; period: string; period_count: number | null; period_amount: number | null; start_date: number;
  end_date: number | null; currency_code: number;
}

// Планові платежі/підписки, що спишуться протягом наступних `days` днів (для TG-нагадування).
async function upcomingPlanned(env: Env, days = 7): Promise<{ title: string; amount: number | null; currency_code: number; when: number }[]> {
  const rows = await env.DB.prepare(
    "SELECT title, period, period_count, period_amount, start_date, end_date, currency_code FROM planned_payments WHERE is_active = 1",
  ).all<PlannedRow>();
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + days * 86400;
  const out: { title: string; amount: number | null; currency_code: number; when: number }[] = [];
  for (const p of rows.results ?? []) {
    const when = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now);
    if (when > horizon) continue;                    // ще не скоро
    if (p.end_date != null && when > p.end_date) continue; // розстрочку вже завершено
    out.push({ title: p.title, amount: p.period_amount, currency_code: p.currency_code, when });
  }
  return out.sort((a, b) => a.when - b.when);
}

const CUR_SIGN: Record<number, string> = { 980: "₴", 840: "$", 978: "€" };
const dayMonth = (t: number) => new Date(t * 1000).toLocaleDateString("uk-UA", { day: "2-digit", month: "short" });

export async function runWeeklyProactive(env: Env): Promise<{ sent: boolean; reason?: string }> {
  // §D1 — this user's own linked chat; the global secret is an owner-only fallback (`tgTarget`).
  // See `notify.pushPendingToTelegram` for the cross-tenant leak the old owner-gate prevented.
  const { tgTarget } = await import("./tg-target.ts");
  const target = await tgTarget(env);
  if (!target) return { sent: false, reason: "no Telegram chat linked" };
  const { token, chatId } = target;

  // Інсайт: беремо збережений, або будуємо, якщо є AI-ключ.
  let ins = await getStoredInsight(env);
  if ((!ins || ins.empty) && env.ANTHROPIC_API_KEY) {
    try { ins = await buildAndStoreInsight(env); } catch { /* best-effort */ }
  }
  if (ins && !ins.empty) {
    await sendMessage(token, chatId, "📊 Тижневий підсумок\n\n" + insightText(ins));
  }

  // Попередження про бюджети.
  const over = await overBudget(env);
  if (over.length) {
    const lines = over.map((o) => {
      const icon = o.ratio >= 1 ? "🔴" : "🟠";
      const pct = Math.round(o.ratio * 100);
      return `${icon} <b>${esc(o.name)}</b> — ${uah(o.spent)} / ${uah(o.budget)} ₴ (${pct}%)`;
    }).join("\n");
    await sendMessage(token, chatId, "⚠️ Бюджети під загрозою\n\n" + lines);
  }

  // Нагадування про підписки/планові платежі, що спишуться цього тижня.
  const upcoming = await upcomingPlanned(env, 7);
  if (upcoming.length) {
    const lines = upcoming.map((u) => {
      const amt = u.amount != null ? ` — <b>${uah(u.amount)} ${CUR_SIGN[u.currency_code] ?? ""}</b>` : "";
      return `• ${esc(u.title)}${amt} · ${dayMonth(u.when)}`;
    }).join("\n");
    await sendMessage(token, chatId, "🔔 Скоро списання (7 днів)\n\n" + lines);
  }

  return { sent: true };
}
