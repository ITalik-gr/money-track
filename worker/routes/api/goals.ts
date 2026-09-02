// `/goals/*` — savings goals and their contribution history. `current_amount` is derived from
// the contributions (§P2.1), so every write goes through `recalcGoal`.
import * as goalsRepo from "../../repo/goals.ts";
import * as accountsRepo from "../../repo/accounts.ts";
import { getRates, uahToMinorIn, convertMinorBetween, resolveBaseCurrency } from "../../lib/finance/money.ts";
import { recalcGoal, isGoalKind, isAutofillKind, goalPace, goalCurrency } from "../../lib/finance/goals.ts";
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
  /**
   * §GOAL-CUR — every figure on a goal is returned IN THE GOAL'S OWN CURRENCY, unconverted.
   *
   * It used to convert both sides into the display base: the jar balance from the jar's currency,
   * the target from hryvnia (it had no currency of its own). Arithmetically consistent, factually
   * wrong — a jar the owner funded in dollars was measured against a target he had typed as
   * dollars and stored as hryvnia, so «На ланос» read 100% at roughly 5%. A goal is one pot of
   * money; the honest unit is the one that pot is in, and the card prints its sign.
   */
  const rates = await getRates(c.env);
  const goals = (await goalsRepo.listActive(c.env.DB)).map((g) => {
    const cur = goalCurrency(g);
    // Legacy rows carry no currency and are hryvnia; if the goal now answers in something else
    // (a jar), the stored target has to be brought into that unit before it is compared.
    const conv = (v: number) => (g.currency_code == null && cur !== 980 ? uahToMinorIn(v, cur, rates) : v);
    const current = g.account_id != null && g.account_balance != null ? g.account_balance : conv(g.current_amount);
    g = {
      ...g,
      currency_code: cur,
      target_amount: conv(g.target_amount),
      current_amount: conv(g.current_amount),
      // §BASE-CUR: `autofill_value` is a PERCENTAGE for `income_pct` and a MONEY AMOUNT for
      // `fixed`. One column, two units — so the conversion has to read the kind.
      autofill_value: g.autofill_kind === "fixed" && g.autofill_value != null
        ? conv(g.autofill_value)
        : g.autofill_value,
    };
    // §GOAL-PACE is computed HERE, not in the component: `draftGoalRisk` calls the same function,
    // so "behind" on the card and "behind" in the feed are literally one computation. Both sides
    // are now in ONE unit by construction, which is what makes the ratio mean anything.
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
  kind: unknown, value: unknown, locale: NotifLocale,
): { kind: string | null; value: number | null } | { error: string } {
  if (kind == null) return { kind: null, value: null };
  if (!isAutofillKind(kind)) return { error: st(locale, "goalAutofillKind") };
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v <= 0) return { error: st(locale, "goalAutofillValue") };
  // Відсоток — саме відсоток: 150% доходу не «агресивна ціль», а помилка вводу.
  if (kind === "income_pct" && v > 100) return { error: st(locale, "goalAutofillPct") };
  // §GOAL-CUR: a FIXED rule is an amount typed against THIS GOAL, so it is stored in the goal's
  // own currency, like its target — no conversion. The percentage is a ratio and is stored as it
  // came, and it is validated as a percentage regardless of any currency.
  return { kind, value: v };
}

/** The jar's own currency — §GOAL-CUR's answer for a linked goal, read once per write. */
async function accountCurrency(env: Parameters<typeof getRates>[0], id: string): Promise<number | null> {
  const rows = await accountsRepo.currenciesFor(env.DB, [id]);
  return rows[0]?.currency_code ?? null;
}

goals.post("/goals", async (c) => {
  const b = await c.req.json<{ name: string; target_amount: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string; kind?: string; autofill_kind?: string | null; autofill_value?: number | null }>();
  const locale = c.get("locale");
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (!(b.target_amount > 0)) return c.json({ error: "target required" }, 400);
  if (b.kind !== undefined && !isGoalKind(b.kind)) return c.json({ error: st(locale, "goalKind") }, 400);
  const auto = parseAutofill(b.autofill_kind ?? null, b.autofill_value, locale);
  if ("error" in auto) return c.json({ error: auto.error }, 400);
  /**
   * §GOAL-CUR — the goal declares its currency at birth and the figures are stored in it.
   *
   * A jar-linked goal takes the JAR's: its progress will BE that account's balance, so any other
   * choice guarantees a comparison across units. Everything else takes the reader's display base,
   * which is the unit the form was typed in. Nothing is converted into hryvnia any more — the
   * conversion is precisely what made «$2 000» into «2 000 ₴».
   */
  const jarCur = b.account_id ? await accountCurrency(c.env, b.account_id) : null;
  const currency_code = jarCur ?? await resolveBaseCurrency(c.env);
  const id = await goalsRepo.create(c.env.DB, {
    name: b.name.trim(),
    currency_code,
    target_amount: Math.round(b.target_amount),
    current_amount: Math.round(b.current_amount ?? 0),
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

  const cur = await goalsRepo.currencyOf(c.env.DB, id);
  if (!cur) return c.json({ error: st(locale, "goalNotFound") }, 404);
  const oldCur = goalCurrency(cur);
  /**
   * §GOAL-CUR — re-pointing a goal at a jar in ANOTHER currency converts what is already stored.
   *
   * The alternative — keeping the number and swapping the label — is the very defect migration
   * 0048 exists to repair, only performed deliberately. The typed values in this same request are
   * in the goal's NEW currency, because that is the unit the form was showing after the link
   * changed; the stored ones are in the old one.
   */
  const newCur = b.account_id === undefined
    ? oldCur
    : (b.account_id ? (await accountCurrency(c.env, b.account_id)) ?? oldCur : (cur.currency_code ?? oldCur));
  const rates = await getRates(c.env);
  const move = (v: number) => convertMinorBetween(v, oldCur, newCur, rates);

  const patch: goalsRepo.GoalPatch = {
    name: b.name !== undefined ? b.name.trim() : undefined,
    currency_code: newCur === oldCur && cur.currency_code != null ? undefined : newCur,
    target_amount: b.target_amount === undefined ? (newCur === oldCur ? undefined : move(cur.target_amount)) : Math.round(b.target_amount),
    current_amount: b.current_amount === undefined ? (newCur === oldCur ? undefined : move(cur.current_amount)) : Math.round(b.current_amount),
    account_id: b.account_id, deadline: b.deadline,
    color: b.color, note: b.note, kind: b.kind,
  };
  if (b.autofill_kind !== undefined) {
    const auto = parseAutofill(b.autofill_kind, b.autofill_value, locale);
    if ("error" in auto) return c.json({ error: auto.error }, 400);
    patch.autofill = auto;
  } else if (newCur !== oldCur && cur.autofill_kind === "fixed" && cur.autofill_value != null) {
    patch.autofill = { kind: cur.autofill_kind, value: move(cur.autofill_value) };
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

  // §GOAL-CHART resolves both storages into ONE series, and §GOAL-CUR says that series is already
  // in the goal's own currency: a jar's balance IS the jar's currency, and a contribution is
  // stored in the currency of the goal it belongs to. Nothing to convert — converting was what
  // let the line and the card underneath it be drawn in two different units.
  const points = goalProgressSeries(
    { created_at: goal.created_at ?? null, deadline: goal.deadline },
    contributions, balances, isJar,
  );
  return c.json({
    points,
    is_jar: isJar,
    currency_code: goalCurrency(goal),
  } satisfies GoalProgressSeries);
});

/**
 * §GOAL-CUR — a contribution is denominated by its GOAL.
 *
 * `goal_contributions` has no currency column and does not need one: `recalcGoal` sums these rows
 * into `savings_goals.current_amount`, so a contribution in any other unit would be added to a
 * target it does not share. Read and written raw for exactly that reason.
 */
goals.get("/goals/:id/contributions", async (c) => {
  const id = Number(c.req.param("id"));
  const [rows, cur] = await Promise.all([
    goalsRepo.listContributions(c.env.DB, id),
    goalsRepo.currencyOf(c.env.DB, id),
  ]);
  const currency_code = cur ? goalCurrency(cur) : 980;
  return c.json(rows.map((r) => ({ ...r, currency_code })) satisfies GoalContribution[]);
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

  await goalsRepo.addContribution(c.env.DB, id, amount,
    Math.floor(b.at ?? Date.now() / 1000), b.note?.trim() || null);
  return c.json({ ok: true, current: await recalcGoal(c.env.DB, id) });
});

goals.delete("/goals/:id/contributions/:cid", async (c) => {
  const id = Number(c.req.param("id"));
  await goalsRepo.deleteContribution(c.env.DB, id, Number(c.req.param("cid")));
  // The SAME field as the add path two handlers up, so the same unit — the goal's own (§GOAL-CUR).
  // These two once disagreed (one converted, one did not) and a dollar screen saw the goal jump
  // ~40× on delete. The currency sweep cannot see this class at all: it reads GETs, and this is a
  // mutation's reply.
  return c.json({ ok: true, current: await recalcGoal(c.env.DB, id) });
});
