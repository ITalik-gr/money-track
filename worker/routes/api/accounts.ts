// `/accounts/*`, `/summary` and `/rates` — balances and what converts them.
//
// Own funds are `balance − credit_limit` and a credit card in debt stays NEGATIVE (owner
// decision, 2026-08-03); the canonical breakdown is `fundsBreakdown()` in lib/ai/advisor.ts.
import { setState } from "../../lib/finance/repo.ts";
import { computeSummary } from "../../lib/finance/finance.ts";
import {
  localMonthStart, } from "../../lib/finance/stats.ts";
import * as accountsRepo from "../../repo/accounts.ts";
import * as stateRepo from "../../repo/state.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { Summary, FundsBreakdown, AccountHistory } from "../../../shared/api/accounts.ts";
import type { Account } from "../../../shared/types.ts";

export const accounts = apiRoutes();

accounts.get("/accounts", async (c) => {
  return c.json(await accountsRepo.listActive(c.env.DB) satisfies Account[]);
});

// Канонічна розбивка коштів (§R3) — ТА САМА, що бачить Порадник. Огляд на сторінці Рахунків
// бере її, а не рахує композицію на клієнті, щоб «подушка/борг/інвестиції» тут = у Пораднику.
accounts.get("/accounts/funds", async (c) => {
  const { fundsBreakdown } = await import("../../lib/ai/advisor.ts");
  return c.json(await fundsBreakdown(c.env) satisfies FundsBreakdown);
});

// Архівовані рахунки (is_active=0) — для секції «Архів». Історія операцій лишається.
accounts.get("/accounts/archived", async (c) => {
  return c.json(await accountsRepo.listArchived(c.env.DB) satisfies Account[]);
});

// Історія балансу ручних рахунків по місяцях — для міні-спарклайнів на картках. Значення у
// ВАЛЮТІ рахунку (для тренду валюта не важлива); крок = останній зріз ≤ кінець місяця (carry-forward).
accounts.get("/accounts/history", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(24, Math.max(3, Number(url.searchParams.get("months") ?? 6)));
  const rows = await accountsRepo.balanceHistory(c.env.DB);
  if (rows === null) return c.json({ history: {} } satisfies AccountHistory); // таблиця може ще не бути на remote (0026)
  const byAcc = new Map<string, { at: number; balance: number }[]>();
  for (const r of rows) (byAcc.get(r.acc) ?? byAcc.set(r.acc, []).get(r.acc)!).push({ at: r.at, balance: r.balance });
  const now = Math.floor(Date.now() / 1000);
  const ends: number[] = [];
  for (let i = months - 1; i >= 0; i--) {
    // кінець i-го місяця назад; для поточного (i=0) — «зараз», бо кінець місяця ще попереду.
    ends.push(i === 0 ? now : localMonthStart(now, -i + 1) - 1);
  }
  const out: Record<string, number[]> = {};
  for (const [acc, hist] of byAcc) {
    if (!hist.length) continue;
    out[acc] = ends.map((t) => {
      let v = hist[0].balance;
      for (const p of hist) { if (p.at <= t) v = p.balance; else break; }
      return Math.round(v / 100);
    });
  }
  return c.json({ history: out } satisfies AccountHistory);
});

// ---- net-worth summary (§5 credit-limit handling) ---------------------------

accounts.get("/summary", async (c) => {
  return c.json(await computeSummary(c.env) satisfies Summary);
});

// ---- manual accounts (позамоно картка / крипта, §5) -------------------------

const MANUAL_TYPES = new Set(["manual_card", "crypto", "cash", "jar"]);
accounts.post("/accounts/manual", async (c) => {
  const b = await c.req.json<{
    type: string; title: string; currency_code: number; balance: number;
    role?: "liquid" | "investment"; credit_limit?: number; ai_note?: string;
  }>();
  const type = MANUAL_TYPES.has(b.type) ? b.type : "manual_card";
  const role = b.role === "investment" ? "investment" : "liquid";
  const creditLimit = typeof b.credit_limit === "number" && b.credit_limit > 0 ? Math.round(b.credit_limit) : 0;
  const aiNote = b.ai_note?.trim() || null;
  const id = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  await accountsRepo.createManual(c.env.DB, {
    id, type, title: b.title, currency_code: b.currency_code, balance: b.balance,
    credit_limit: creditLimit, role, ai_note: aiNote, updated_at: nowS,
  });
  // Перший зріз балансу одразу: без нього нетворт не має від чого відштовхнутись і малює
  // рахунок так, ніби він зʼявився сьогодні.
  await accountsRepo.recordBalance(c.env.DB, id, b.balance, nowS);
  return c.json({ ok: true, id });
});

accounts.patch("/accounts/manual/:id", async (c) => {
  const b = await c.req.json<{ balance?: number; title?: string }>();
  const id = c.req.param("id");
  const nowS = Math.floor(Date.now() / 1000);
  await accountsRepo.updateManual(c.env.DB, id, b, nowS);
  // Зріз балансу в історію → нетворт крокує по ньому назад (не плоский). Лише коли баланс змінили:
  // перейменування — не подія балансу, і крок на графіку там означав би зміну, якої не було.
  if (b.balance !== undefined) await accountsRepo.recordBalance(c.env.DB, id, b.balance, nowS);
  return c.json({ ok: true });
});

// Cached rates map (currency code → DISPLAY-base per unit, §BASE-CUR) + the base itself +
// last-updated, for client-side conversion of FX cards/jars. Same source computeSummary uses,
// so a jar's "≈" line and the header total cannot disagree about the rate or about the unit.
accounts.get("/rates", async (c) => {
  return c.json(await stateRepo.rates(c.env));
});

// Перейменувати рахунок (напр. банку — mono дає generic «БАНКА»). Title — лише
// показ, тож дозволяємо для будь-якого рахунку; синк банок його вже не перезапише.
accounts.patch("/accounts/:id/title", async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: "title required" }, 400);
  await accountsRepo.rename(c.env.DB, c.req.param("id"), title.trim());
  return c.json({ ok: true });
});

// §R3: роль рахунку (ліквідний/інвестиційний) + опис для AI. Для будь-якого рахунку.
// + умови кредитки (statement_day/payment_day/min_payment) — живлять нагадування про платіж.
accounts.patch("/accounts/:id/meta", async (c) => {
  const b = await c.req.json<{ role?: "liquid" | "investment"; ai_note?: string; statement_day?: number | null; payment_day?: number | null; min_payment?: number | null }>();
  // День місяця валідуємо 1..31; порожнє/некоректне → NULL (умову знято): нагадування «на 40-те
  // число» не спрацювало б ніколи, тобто виглядало б налаштованим, будучи мертвим.
  const dayOrNull = (v: number | null | undefined) => (typeof v === "number" && v >= 1 && v <= 31 ? Math.trunc(v) : null);
  await accountsRepo.updateMeta(c.env.DB, c.req.param("id"), {
    ...(b.role !== undefined ? { role: b.role === "investment" ? "investment" : "liquid" } : {}),
    ...(b.ai_note !== undefined ? { ai_note: b.ai_note.trim() || null } : {}),
    ...(b.statement_day !== undefined ? { statement_day: dayOrNull(b.statement_day) } : {}),
    ...(b.payment_day !== undefined ? { payment_day: dayOrNull(b.payment_day) } : {}),
    ...(b.min_payment !== undefined
      ? { min_payment: typeof b.min_payment === "number" && b.min_payment > 0 ? Math.round(b.min_payment) : null } : {}),
  });
  return c.json({ ok: true });
});

// Архів/відновлення рахунку (is_active). Схований рахунок не показується й не входить у
// підсумки/подушку/нетворт. Історію операцій НЕ чіпаємо — лише ховаємо рахунок зі списку.
accounts.patch("/accounts/:id/active", async (c) => {
  const { active } = await c.req.json<{ active: boolean }>();
  await accountsRepo.setActive(c.env.DB, c.req.param("id"), active);
  return c.json({ ok: true });
});

// Видалення РУЧНОГО рахунку — лише якщо на ньому немає операцій (інакше лишились би
// сирітські tx / FK). Для mono-рахунків видалення нема — тільки архів вище.
accounts.delete("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const acc = await accountsRepo.findKind(c.env.DB, id);
  if (!acc) return c.json({ error: st(c.get("locale"), "errAccountNotFound") }, 404);
  if (!acc.is_manual) return c.json({ error: st(c.get("locale"), "errAccountOnlyManual") }, 400);
  if (await accountsRepo.transactionCount(c.env.DB, id) > 0) {
    return c.json({ error: st(c.get("locale"), "errAccountHasTx") }, 400);
  }
  await accountsRepo.removeManual(c.env.DB, id);
  return c.json({ ok: true });
});

// Refresh currency rates cache from public mono endpoint (call daily / on demand).
accounts.post("/rates/refresh", async (c) => {
  const { getCurrencyRates } = await import("../../lib/bank/mono.ts");
  try {
    const rates = await getCurrencyRates();
    const map: Record<string, number> = {};
    for (const r of rates) {
      if (r.currencyCodeB === 980 && r.rateSell) map[String(r.currencyCodeA)] = r.rateSell;
      else if (r.currencyCodeB === 980 && r.rateCross) map[String(r.currencyCodeA)] = r.rateCross;
    }
    await setState(c.env.DB, "rates", JSON.stringify(map));
    await setState(c.env.DB, "rates_updated", String(Math.floor(Date.now() / 1000)));
    return c.json({ ok: true, rates: map });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});
