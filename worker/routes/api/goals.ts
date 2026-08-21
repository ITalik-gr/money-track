// `/goals/*` — savings goals and their contribution history. `current_amount` is derived from
// the contributions (§P2.1), so every write goes through `recalcGoal`.
import * as goalsRepo from "../../repo/goals.ts";
import { getRates, toBaseMinor, uahToBaseMinor, baseToUah, type Rates } from "../../lib/finance/money.ts";
import { recalcGoal, isGoalKind, isAutofillKind, goalPace } from "../../lib/finance/goals.ts";
import { st } from "../../lib/platform/i18n.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { SavingsGoal, GoalContribution, GoalProgressSeries } from "../../../shared/api/planning.ts";

export const goals = apiRoutes();

// ---- savings goals (§7) -----------------------------------------------------

// Список цілей із прогресом. Якщо привʼязано банку (account_id) — прогрес = її баланс,
// інакше — ручний current_amount.
goals.get("/goals", async (c) => {
  // One `now` for the whole list: otherwise two cards from the same request could end up with a
  // different number of days to their deadline if the response were assembled across midnight.
  const now = Math.floor(Date.now() / 1000);
  // §BASE-CUR: a goal's target and its manual progress are stored in hryvnia (no currency column
  // on `savings_goals`), while a linked jar's balance is in the JAR's currency. Two different
  // conversions for two different origins — collapsing them would price a dollar jar as hryvnia.
  const rates = await getRates(c.env);
  const goals = (await goalsRepo.listActive(c.env.DB)).map((g) => {
    const current = g.account_id != null && g.account_balance != null
      ? toBaseMinor(g.account_balance, g.account_currency ?? 980, rates)
      : uahToBaseMinor(g.current_amount, rates);
    g = {
      ...g,
      target_amount: uahToBaseMinor(g.target_amount, rates),
      current_amount: uahToBaseMinor(g.current_amount, rates),
      // §BASE-CUR: `autofill_value` is a PERCENTAGE for `income_pct` and a MONEY AMOUNT for
      // `fixed`. One column, two units — so the conversion has to read the kind. It converted
      // neither until 2026-08-21, which meant a dollar reader who set «$200 щомісяця» was shown
      // "200" beside a dollar sign while 200 ₴ was what actually moved.
      autofill_value: g.autofill_kind === "fixed" && g.autofill_value != null
        ? uahToBaseMinor(g.autofill_value, rates)
        : g.autofill_value,
    };
    // §GOAL-PACE is computed HERE, not in the component: `draftGoalRisk` calls the same function,
    // so "behind" on the card and "behind" in the feed are literally one computation.
    return { ...g, current, pace: goalPace({ ...g, current }, now) };
  });
  return c.json(goals satisfies SavingsGoal[]);
});

/**
 * §P2.1 — правило авто-поповнення з тіла запиту (міграція 0037).
 *
 * Валідуємо ОБИДВА поля разом: `autofill_kind` без осмисленого значення = мовчазне «нічого
 * не нараховується», а це найгірший стан для фічі, суть якої «воно саме». `null` (вимкнути)
 * лишається легальним, тож `undefined` (не чіпати) і `null` тут різні речі.
 */
function parseAutofill(
  kind: unknown, value: unknown, locale: NotifLocale, rates: Rates,
): { kind: string | null; value: number | null } | { error: string } {
  if (kind == null) return { kind: null, value: null };
  if (!isAutofillKind(kind)) return { error: st(locale, "goalAutofillKind") };
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v <= 0) return { error: st(locale, "goalAutofillValue") };
  // Відсоток — саме відсоток: 150% доходу не «агресивна ціль», а помилка вводу.
  if (kind === "income_pct" && v > 100) return { error: st(locale, "goalAutofillPct") };
  // §BASE-CUR: a FIXED rule is an amount the reader typed, and the column has no currency — so it
  // is stored in hryvnia like every other typed amount. The percentage is a ratio and is stored
  // as it came. Validation happens BEFORE the conversion on purpose: «100» must mean 100% of
  // income regardless of the reader's currency, and a converted number would fail the ≤100 check
  // for no reason the reader could see.
  return { kind, value: kind === "fixed" ? baseToUah(v, rates) : v };
}

goals.post("/goals", async (c) => {
  const b = await c.req.json<{ name: string; target_amount: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string; kind?: string; autofill_kind?: string | null; autofill_value?: number | null }>();
  const locale = c.get("locale");
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (!(b.target_amount > 0)) return c.json({ error: "target required" }, 400);
  if (b.kind !== undefined && !isGoalKind(b.kind)) return c.json({ error: st(locale, "goalKind") }, 400);
  // §BASE-CUR: what the reader typed is in THEIR currency; the columns hold hryvnia.
  const rates = await getRates(c.env);
  const auto = parseAutofill(b.autofill_kind ?? null, b.autofill_value, locale, rates);
  if ("error" in auto) return c.json({ error: auto.error }, 400);
  const id = await goalsRepo.create(c.env.DB, {
    name: b.name.trim(),
    target_amount: baseToUah(b.target_amount, rates),
    current_amount: baseToUah(b.current_amount ?? 0, rates),
    account_id: b.account_id ?? null,
    deadline: b.deadline ?? null,
    color: b.color ?? "#2e6be6",
    note: b.note ?? null,
    kind: b.kind ?? "save_up",
    autofill_kind: auto.kind,
    autofill_value: auto.value,
    created_at: Math.floor(Date.now() / 1000),
  });
  return c.json({ ok: true, id });
});

goals.patch("/goals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const locale = c.get("locale");
  const b = await c.req.json<{ name?: string; target_amount?: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string; kind?: string; autofill_kind?: string | null; autofill_value?: number | null }>();
  if (b.name !== undefined && !b.name.trim()) return c.json({ error: "name required" }, 400);
  if (b.kind !== undefined && !isGoalKind(b.kind)) return c.json({ error: st(locale, "goalKind") }, 400);

  const rates = await getRates(c.env);
  const patch: goalsRepo.GoalPatch = {
    name: b.name !== undefined ? b.name.trim() : undefined,
    target_amount: b.target_amount === undefined ? undefined : baseToUah(b.target_amount, rates),
    current_amount: b.current_amount === undefined ? undefined : baseToUah(b.current_amount, rates),
    account_id: b.account_id, deadline: b.deadline,
    color: b.color, note: b.note, kind: b.kind,
  };
  if (b.autofill_kind !== undefined) {
    const auto = parseAutofill(b.autofill_kind, b.autofill_value, locale, rates);
    if ("error" in auto) return c.json({ error: auto.error }, 400);
    patch.autofill = auto;
  }
  await goalsRepo.update(c.env.DB, id, patch);
  return c.json({ ok: true });
});

goals.delete("/goals/:id", async (c) => {
  await goalsRepo.archive(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---- §P2.1: внески в ціль ---------------------------------------------------
//
// `current_amount` — денормалізований SUM внесків; його ЄДИНИЙ писар — `recalcGoal`
// (`lib/finance/goals.ts`). Переїхав у lib, щойно зʼявився другий охочий писати цю суму —
// крон авто-поповнення. Те саме правило, що для §COMPENSATION.
//
// ⚠️ Ціль, привʼязану до БАНКИ (`account_id`), внески не чіпають: там джерело правди —
// баланс рахунку, який веде банк. Дозволити ще й ручні внески означало б рахувати ті самі
// гроші двічі.

/**
 * §GOAL-CHART — the progress series, resolved server-side for both goal kinds.
 *
 * ⚠️ Declared ABOVE `/goals/:id/contributions` is not required (different literal), but it IS a
 * literal segment after the parameter, so lint C7 is satisfied either way.
 */
goals.get("/goals/:id/progress", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const goal = (await goalsRepo.listActive(c.env.DB)).find((g) => g.id === id);
  if (!goal) return c.json({ error: st(c.get("locale"), "goalNotFound") }, 404);

  const { goalProgressSeries } = await import("../../lib/finance/goals.ts");
  const isJar = goal.account_id != null;
  const start = goal.created_at ?? (goal.deadline != null ? goal.deadline - 180 * 86400 : 0);
  const [contributions, balances] = await Promise.all([
    isJar ? Promise.resolve([]) : goalsRepo.listContributions(c.env.DB, id),
    isJar ? goalsRepo.balanceHistory(c.env.DB, goal.account_id!, start) : Promise.resolve([]),
  ]);

  // §GOAL-CHART already resolves both storages into ONE series; §BASE-CUR converts that one
  // series once, at the end — a jar's balance is in the jar's currency, contributions in hryvnia.
  const rates = await getRates(c.env);
  const points = goalProgressSeries(
    { created_at: goal.created_at ?? null, deadline: goal.deadline },
    contributions, balances, isJar,
  ).map((p) => ({
    ...p,
    amount: isJar
      ? toBaseMinor(p.amount, goal.account_currency ?? 980, rates)
      : uahToBaseMinor(p.amount, rates),
  }));
  return c.json({
    points,
    is_jar: isJar,
  } satisfies GoalProgressSeries);
});

goals.get("/goals/:id/contributions", async (c) => {
  const rates = await getRates(c.env);
  const rows = await goalsRepo.listContributions(c.env.DB, Number(c.req.param("id")));
  return c.json(rows.map((r) => ({ ...r, amount: uahToBaseMinor(r.amount, rates) })) satisfies GoalContribution[]);
});

goals.post("/goals/:id/contributions", async (c) => {
  const id = Number(c.req.param("id"));
  const locale = c.get("locale");
  const b = await c.req.json<{ amount?: number; at?: number; note?: string | null }>()
    .catch(() => ({} as { amount?: number; at?: number; note?: string | null }));
  const amount = Math.round(Number(b.amount));
  // Нуль забороняємо окремо від NaN: «0» проходить `Number.isFinite`, але внесок на нуль —
  // це рядок в історії, який нічого не означає.
  if (!Number.isFinite(amount) || amount === 0) return c.json({ error: st(locale, "goalContribAmount") }, 400);

  const goal = await goalsRepo.findActive(c.env.DB, id);
  if (!goal) return c.json({ error: st(locale, "goalNotFound") }, 404);
  if (goal.account_id) return c.json({ error: st(locale, "goalJarNoContrib") }, 400);

  await goalsRepo.addContribution(c.env.DB, id, baseToUah(amount, await getRates(c.env)),
    Math.floor(b.at ?? Date.now() / 1000), b.note?.trim() || null);
  return c.json({ ok: true, current: uahToBaseMinor(await recalcGoal(c.env.DB, id), await getRates(c.env)) });
});

goals.delete("/goals/:id/contributions/:cid", async (c) => {
  const id = Number(c.req.param("id"));
  await goalsRepo.deleteContribution(c.env.DB, id, Number(c.req.param("cid")));
  // §BASE-CUR: the SAME field as the add path two handlers up, so the same conversion. It was raw
  // hryvnia here — adding a contribution returned a converted total and removing one returned an
  // unconverted one, so on a dollar screen the goal jumped ~40× on delete. The currency sweep
  // cannot see this class at all: it reads GETs, and this is a mutation's reply.
  return c.json({ ok: true, current: uahToBaseMinor(await recalcGoal(c.env.DB, id), await getRates(c.env)) });
});
