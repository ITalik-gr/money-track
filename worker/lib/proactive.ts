// Telegram Фаза 3 — проактивність (§ROADMAP): раз на тиждень пушимо в TG свіжий
// інсайт і попереджаємо про перевищені/майже вичерпані бюджети-конверти. Гейт —
// налаштовані TG-секрети (TG_BOT_TOKEN + TG_CHAT_ID). Викликається з кроном.
import type { Env } from "../env.ts";
import { sendMessage } from "./telegram.ts";
import { getStoredInsight, buildAndStoreInsight, type StoredInsight } from "./insight.ts";

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

// Перевищені / майже вичерпані бюджети-конверти цього місяця (рол-ап підкатегорій).
async function overBudget(env: Env): Promise<{ name: string; spent: number; budget: number; ratio: number }[]> {
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);

  const budgets = await env.DB.prepare(
    `SELECT b.category_id AS id, b.amount AS amount, c.name AS name
     FROM budgets b JOIN categories c ON c.id = b.category_id
     WHERE b.period = 'month' AND b.amount > 0`,
  ).all<{ id: number; amount: number; name: string }>();
  if (!budgets.results?.length) return [];

  const spendRows = await env.DB.prepare(
    `SELECT COALESCE(c.parent_id, t.category_id) AS cat, SUM(-t.amount) AS spent
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.time >= ? AND t.amount < 0 AND t.hold = 0 AND t.is_transfer = 0 AND t.currency_code = 980
     GROUP BY COALESCE(c.parent_id, t.category_id)`,
  ).bind(monthStart).all<{ cat: number; spent: number }>();
  const spentByCat = new Map((spendRows.results ?? []).map((r) => [r.cat, r.spent]));

  return (budgets.results ?? [])
    .map((b) => { const spent = spentByCat.get(b.id) ?? 0; return { name: b.name, spent, budget: b.amount, ratio: spent / b.amount }; })
    .filter((x) => x.ratio >= 0.9)
    .sort((a, b) => b.ratio - a.ratio);
}

// Наступне списання планового платежу: від start_date крокуємо періодом у майбутнє
// (дзеркалить фронтові Subscriptions.nextCharge — тримати синхронними).
function nextCharge(startDate: number, period: string, count = 1): number {
  const now = Math.floor(Date.now() / 1000);
  const n = Math.max(1, count);
  if (period === "week") { let t = startDate; while (t <= now) t += 7 * 86400 * n; return t; }
  const d = new Date(startDate * 1000);
  while (d.getTime() / 1000 <= now) d.setMonth(d.getMonth() + n);
  return Math.floor(d.getTime() / 1000);
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
    const when = nextCharge(p.start_date, p.period, p.period_count ?? 1);
    if (when > horizon) continue;                    // ще не скоро
    if (p.end_date != null && when > p.end_date) continue; // розстрочку вже завершено
    out.push({ title: p.title, amount: p.period_amount, currency_code: p.currency_code, when });
  }
  return out.sort((a, b) => a.when - b.when);
}

const CUR_SIGN: Record<number, string> = { 980: "₴", 840: "$", 978: "€" };
const dayMonth = (t: number) => new Date(t * 1000).toLocaleDateString("uk-UA", { day: "2-digit", month: "short" });

export async function runWeeklyProactive(env: Env): Promise<{ sent: boolean; reason?: string }> {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return { sent: false, reason: "TG not configured" };

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
