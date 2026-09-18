/**
 * `drafts-due` — WHAT IS DUE SOON: subscriptions, instalments, a credit-card payment.
 *
 * Split out of `notify.ts` on 2026-09-18 under lint C3 (that file sits at its size exception and
 * an exception may never rise). The seam is the one the feed already draws for the reader: every
 * draft here answers «money leaves on a date you did not choose», which is why they share ONE
 * preference (`deadline`) — muting one and keeping the others would be muting half a concern.
 *
 * ⚠️ The ФОП drafters moved to `drafts-fop.ts` later the same day. They had landed here because
 * the tax deadlines ARE due dates, and then «an official page changed» and «a client went quiet»
 * followed them in — neither of which is money leaving on a date. A file whose header no longer
 * describes its contents is the first step back towards `notify.ts` at a thousand lines.
 */
import type { Env } from "../../env.ts";
import { debtMinor } from "../../../shared/own-funds.ts";
import { getRates } from "../finance/money.ts";
import { nextChargeUnix, plannedUAH } from "../finance/subscriptions.ts";
import { localYmd } from "../finance/stats.ts";

// The same one-liner the sibling drafters keep (`drafts-ai.ts`, `drafts-goals.ts`): a dedup key
// needs a Kyiv calendar day, and importing one another's private helper would couple four files
// that otherwise share nothing.
const isoDay = (unix: number) => localYmd(unix);
import type { Draft } from "./notify.ts";

/** Списання планів/підписок у горизонті 3 днів. §CUR-PLAN: сума зводиться plannedUAH. */
export async function draftDeadlines(env: Env, now: number): Promise<Draft[]> {
  const rates = await getRates(env);
  const rows = await env.DB.prepare(
    `SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date
     FROM planned_payments WHERE is_active = 1`,
  ).all<{
    id: number; title: string; kind: string; period_amount: number | null; currency_code: number | null;
    period: string; period_count: number | null; start_date: number; end_date: number | null;
  }>();

  const out: Draft[] = [];
  for (const p of rows.results ?? []) {
    const amt = p.period_amount ?? 0;
    if (amt <= 0) continue;
    const at = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now);
    if (p.end_date != null && at > p.end_date) continue;   // розстрочка добігла кінця
    const days = Math.round((at - now) / 86400);
    if (days > 3) continue;
    const amountUAH = plannedUAH(amt, p.currency_code, rates);
    out.push({
      kind: "deadline",
      tkey: "deadline_plan",
      tparams: { title: p.title, days, amount: amountUAH, at },
      severity: days <= 2 ? "warn" : "info",
      entity_type: "planned", entity_id: String(p.id),
      // Ключ по ДАТІ списання: наступного разу подія має зʼявитись знову.
      dedup_key: `deadline:${p.id}:${isoDay(at)}`,
    });
  }

  // Платіж по кредитці (§Кредитка): рахунки з payment_day + використаним кредитом. Нагадуємо
  // за ≤3 дні. Це той самий `deadline` (та сама пресета/фільтр), лише entity=account.
  let cards: { id: string; title: string | null; type: string | null; balance: number; credit_limit: number; currency_code: number; payment_day: number | null; min_payment: number | null }[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, title, type, balance, credit_limit, currency_code, payment_day, min_payment
       FROM accounts WHERE is_active = 1 AND credit_limit > 0 AND payment_day IS NOT NULL`,
    ).all<typeof cards[number]>();
    cards = r.results ?? [];
  } catch { /* колонки кредитки можуть ще не бути на remote (0027) — гілка мовчки пропускається */ }
  for (const a of cards) {
    // Борг — це відʼємні власні кошти, а не окрема формула (§Інваріанти, `own-funds.ts`).
    // Писати тут `credit_limit − balance` вдруге означало б завести другий вираз для одного
    // числа — саме це реєстр дублювання й прийняв був за «інвертовану копію».
    const used = debtMinor(a.balance, a.credit_limit);
    if (used <= 0) continue;                                // нема боргу — нема про що нагадувати
    const at = nextMonthlyDay(a.payment_day!, now);
    const days = Math.round((at - now) / 86400);
    if (days > 3) continue;
    const amt = a.min_payment && a.min_payment > 0 ? a.min_payment : used;
    const amtUAH = plannedUAH(amt, a.currency_code, rates);
    const isMin = !!(a.min_payment && a.min_payment > 0);
    out.push({
      kind: "deadline",
      tkey: "deadline_credit",
      tparams: { title: a.title, days, isMin, amount: amtUAH, at },
      severity: "warn",  // пропущений платіж по кредитці дорогий → завжди у TG-пуш
      entity_type: "account", entity_id: a.id,
      dedup_key: `deadline:credit:${a.id}:${isoDay(at).slice(0, 7)}`,
    });
  }
  return out;
}

// Наступна дата, коли настане задане число місяця (payment_day), ≥ now. UTC-полудень, щоб
// уникнути крайових зсувів; якщо в місяці менше днів — беремо останній день місяця.
function nextMonthlyDay(day: number, now: number): number {
  const d = new Date(now * 1000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  const mk = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return Math.floor(Date.UTC(yy, mm, Math.min(day, last), 12, 0, 0) / 1000);
  };
  let at = mk(y, m);
  if (at < now) { m++; if (m > 11) { m = 0; y++; } at = mk(y, m); }
  return at;
}
