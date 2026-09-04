/**
 * §Обробка помилок — the advice given when the model cannot be reached.
 *
 * Split out of `advisor.ts` on 2026-09-04 under lint C3. The seam is real rather than a line
 * count: that file is about the MODEL's answer — the payload it is given, the ledger of what it
 * said, §NOVELTY — while this one produces an answer with no model in it at all, from the same
 * canonical snapshot. They share a return shape and nothing else, and the import runs one way.
 */
import type { Env } from "../../env.ts";
import { st, num, resolveLocale } from "../platform/i18n.ts";
import { currencySign } from "../../../shared/currency.ts";
import { resolveBaseCurrency } from "../finance/money.ts";
import { collectFinanceSnapshot, type StoredAdvice } from "./advisor.ts";
import { normaliseSuggestions } from "./advice-actions.ts";
import type { AdviceResult, AiFact } from "./generate.ts";

/**
 * Детермінований fallback поради — коли AI недоступний (нема ключа, ліміт, збій моделі).
 *
 * Правило §Обробка помилок: краще ДЕГРАДУВАТИ, ніж мовчати. Порожня сторінка не відрізняється
 * від «нема даних», тож користувач не знає, чи щось зламалось. Тут — ті самі канонічні числа
 * (`collectFinanceSnapshot`), просто складені без моделі: подушка, burn, runway, найбільша
 * категорія, необовʼязкові витрати, перевитрачені бюджети, найближчі списання.
 *
 * ⚠️ НЕ зберігаємо в `app_state.advisor` і НЕ пишемо в історію: інакше слабша детермінована
 * порада затерла б останню нормальну AI-пораду, і користувач мовчки втратив би кращий результат.
 */
export async function fallbackAdvice(env: Env, reason?: string): Promise<StoredAdvice> {
  const snap = await collectFinanceSnapshot(env);
  const { funds, ownFunds, monthlyBurn, runwayMonths, subsMonthly, context } = snap;
  // This whole block is rendered verbatim on the Advisor screen — including for a demo visitor
  // whose AI budget ran out — so it is localized, digit grouping included (B3).
  const loc = await resolveLocale(env);
  const uah = (minor: number) => Math.round(minor / 100);
  const n = (v: number) => num(loc, v);
  // §BASE-CUR: one symbol, resolved once, threaded into every template below as `cur`.
  const cur = currencySign(await resolveBaseCurrency(env));
  const fmt = (minor: number) => (loc === "uk" ? `${n(uah(minor))} ${cur}` : `${cur}${n(uah(minor))}`);

  type Cat = { id: number; name: string; avg_month_uah: number };
  const cats = (context.top_categories as Cat[] | undefined) ?? [];
  const budgets = (context.budgets as { category: string; used_pct: number | null }[] | undefined) ?? [];
  const importance = (context.by_importance as { level: string; spent_90d_uah: number }[] | undefined) ?? [];
  const upcoming = (context.upcoming_charges as { title: string; in_days: number; amount_uah: number }[] | undefined) ?? [];

  const runwayText = runwayMonths == null
    ? st(loc, "advRunwayTooLittle")
    : st(loc, "advRunwayText", { cushion: fmt(funds.cushion), months: runwayMonths.toFixed(1), burn: fmt(monthlyBurn) });

  const suggestions: AdviceResult["suggestions"] = [];

  // 1. Найбільша категорія — найбільший важіль. Ефект рахуємо явно, щоб порада була дієвою.
  const top = cats[0];
  if (top && top.avg_month_uah > 0) {
    const cut = Math.round(top.avg_month_uah * 0.15);
    suggestions.push({
      title: st(loc, "advTopCatTitle", { name: top.name }),
      detail: st(loc, "advTopCatDetail", { cur, avg: n(top.avg_month_uah), cut: n(cut), year: n(cut * 12) }),
      action: { type: "create_budget", label: st(loc, "advTopCatAction", { cur, amount: n(top.avg_month_uah - cut), name: top.name }), category_id: top.id, category_name: top.name, amount_uah: top.avg_month_uah - cut },
    });
  }

  // 2. Необовʼязкові витрати — найбезпечніше, що можна різати (§6 вагомість).
  const optional = importance.find((x) => x.level === "optional");
  if (optional && optional.spent_90d_uah > 0) {
    suggestions.push({
      title: st(loc, "advOptionalTitle"),
      detail: st(loc, "advOptionalDetail", { cur, sum: n(optional.spent_90d_uah), perMonth: n(Math.round(optional.spent_90d_uah / 3)) }),
      action: null,
    });
  }

  // 3. Перевитрачені бюджети — конкретний факт, а не абстракція.
  const over = budgets.filter((b) => (b.used_pct ?? 0) > 100);
  if (over.length) {
    suggestions.push({
      title: over.length === 1 ? st(loc, "advBudgetOverOne", { category: over[0].category }) : st(loc, "advBudgetOverMany", { n: over.length }),
      detail: over.map((b) => `${b.category} — ${b.used_pct}%`).join(" · ") + st(loc, "advBudgetOverTail"),
      action: null,
    });
  }

  // 4. Підписки — фіксований відтік, який легко не помічати.
  if (subsMonthly > 0) {
    suggestions.push({
      title: st(loc, "advSubsTitle"),
      detail: st(loc, "advSubsDetail", { cur, month: n(subsMonthly), year: n(subsMonthly * 12) }),
      action: null,
    });
  }

  // 5. Найближчі списання — тайминг, а не тільки суми.
  const soon = upcoming.filter((u) => u.in_days <= 7);
  if (soon.length) {
    const total = soon.reduce((s, u) => s + u.amount_uah, 0);
    suggestions.push({
      title: st(loc, "advUpcomingTitle", { cur, total: n(total) }),
      detail: soon.slice(0, 4).map((u) => st(loc, "advUpcomingItem", { cur, title: u.title, amount: n(u.amount_uah), days: u.in_days })).join(" · "),
      action: null,
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      title: st(loc, "advEmptyTitle"),
      detail: st(loc, "advEmptyDetail"),
      action: null,
    });
  }

  const facts: AiFact[] = [
    { label: st(loc, "advFactCushion"), amount: uah(funds.cushion), category: null, delta_pct: null, tone: funds.cushion > 0 ? "pos" : "neg" },
    { label: st(loc, "advFactBurn"), amount: uah(monthlyBurn), category: null, delta_pct: null, tone: "neutral" },
  ];
  if (funds.debt > 0) facts.push({ label: st(loc, "advFactDebt"), amount: uah(funds.debt), category: null, delta_pct: null, tone: "neg" });
  if (top) facts.push({ label: st(loc, "advFactTopCat"), amount: top.avg_month_uah, category: top.name, delta_pct: null, tone: "neutral" });

  return {
    runway_comment: runwayText,
    summary: st(loc, "advSummary"),
    facts,
    // §ADVICE-LOOP — the fallback speaks the same shape. It is deliberately NOT remembered
    // (`buildAdviceFallback` writes nothing, by the rule three lines below its own header), so
    // every state here is `open`: a weaker deterministic answer must not be able to mark a
    // suggestion as said, or a model outage would silence the real advice for a month.
    suggestions: normaliseSuggestions(suggestions.slice(0, 5), new Map()),
    own_funds: ownFunds,
    cushion: funds.cushion,
    debt: funds.debt,
    investment: funds.investment,
    monthly_burn: monthlyBurn,
    runway_months: runwayMonths,
    generated_at: snap.now,
    cur: await resolveBaseCurrency(env),
    fallback: true,
    fallback_reason: reason,
  };
}
