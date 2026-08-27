// `/planned/*` — planned payments and subscriptions.
//
// `period_amount` is in the PLAN's currency and its period is the PLAN's period: never sum it
// raw. ₴ totals go through `plannedUAH`/`sumPlannedUAH` (§CUR-PLAN), a monthly burden through
// `monthlyPlannedUAH` (§SUB-MONTH), and "what is charged before month end" through `chargesBetween`.
import { getRates } from "../../lib/finance/money.ts";
import { monthlyPlannedUAH } from "../../lib/finance/subscriptions.ts";
import * as planningRepo from "../../repo/planning.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { PlannedActual } from "../../../shared/types.ts";
import type { UpcomingSubs, RecurringCandidate, PlanFromHabit, PlannedRow, AiDetectResult, SubscriptionOverview } from "../../../shared/api/planning.ts";

export const planned = apiRoutes();

// §Хвіст: факт vs план по підписках — фактичні списання, лічильник, ознака подорожчання.
planned.get("/planned/actuals", async (c) => {
  const { plannedActuals } = await import("../../lib/finance/subscriptions.ts");
  return c.json(await plannedActuals(c.env.DB) satisfies PlannedActual[]);
});

planned.get("/planned", async (c) => {
  const rows = await planningRepo.listActive(c.env.DB);
  // §SUB-MONTH: the monthly burden travels WITH each plan, from the canon. The Subscriptions page
  // used to average `period_amount` itself, and its "is this plan over" rule had drifted to cover
  // installments only — so a cancelled subscription with an end date counted on that page and
  // nowhere else. A component must not multiply `period_amount` by anything.
  const rates = await getRates(c.env);
  const now = Math.floor(Date.now() / 1000);
  return c.json(rows.map((p) => ({
    ...p, monthly_base: monthlyPlannedUAH(p, rates, now),
  })) satisfies PlannedRow[]);
});

planned.post("/planned", async (c) => {
  const b = await c.req.json<{
    title: string; kind: "subscription" | "installment" | "income"; total_amount?: number;
    period_amount?: number; period: "month" | "week"; period_count?: number; start_date: number;
    category_id?: number; account_id?: string; currency_code?: number; amount_varies?: boolean;
  }>();
  // §INCOME-PLAN: an expected inflow is the same schedule with the sign flipped, so it reuses
  // everything here. `amount_varies` only marks the figure as an ESTIMATE — the owner's actual
  // constraint is that income is neither the same size nor on time, and a number presented as
  // exact when it is not is the thing that makes the forecast untrustworthy.
  if (b.kind === "income" && !(b.period_amount && b.period_amount > 0)) {
    return c.json({ error: st(c.get("locale"), "errIncomeAmount") }, 400);
  }
  const periodCount = Math.max(1, Math.round(b.period_count ?? 1)); // «кожні N періодів» (§SUB4)
  // Installment auto-math (§6.5): derive occurrences/end_date from total & per-period.
  let occurrences: number | null = null;
  let end_date: number | null = null;
  if (b.kind === "installment" && b.total_amount && b.period_amount) {
    occurrences = Math.ceil(b.total_amount / b.period_amount);
    const step = (b.period === "week" ? 7 * 86400 : 30 * 86400) * periodCount;
    end_date = b.start_date + occurrences * step;
  }
  const id = await planningRepo.create(c.env.DB, {
    title: b.title, kind: b.kind,
    total_amount: b.total_amount ?? null, period_amount: b.period_amount ?? null,
    period: b.period, period_count: periodCount, start_date: b.start_date,
    end_date, occurrences,
    category_id: b.category_id ?? null, account_id: b.account_id ?? null,
    currency_code: b.currency_code ?? 980,
    amount_varies: !!b.amount_varies,
  });
  // §PLAN-LINK: a plan is declared BECAUSE it has been charging for a while, so the history it
  // describes already exists. Without this the plan opened with zero charges and every screen said
  // «списань не видно» about a subscription paid every month — see `linkPlanHistory`.
  // ⚠️ An income plan has no outflow to link, and linking is best-effort: failing to attach the
  // past must not fail the creation the user asked for.
  let linked = 0;
  if (b.kind !== "income") {
    try {
      const { linkPlanHistoryById } = await import("../../lib/finance/subscriptions.ts");
      linked = (await linkPlanHistoryById(c.env.DB, id)).linked;
    } catch { /* the plan exists; the back-link can be redone from Settings */ }
  }
  return c.json({ ok: true, id, occurrences, end_date, linked });
});

/**
 * §SUB-FIND — "describe the subscription and I'll find it in your history".
 *
 * The model's job is NAMES, not search: a brand is one thing under several strings («X», «Twitter»,
 * «твітер»), the ledger holds one of them and the person remembers another. It used to return a
 * single `merchant_query`, and the two failures that produced were the bug report of 2026-08-27:
 *   • «твітер» found nothing, because the charge is stored as «X Corp.» — while the user had
 *     already told the AI, on that very transaction, that it is his Twitter subscription, and the
 *     model had written it into `ai_note`. The app knew and did not look (fixed in `searchHaystack`).
 *   • «X підписка» returned OnTa**x**i, E**x**pres and PADDLE.NET — `LIKE '%X%'` over a one-letter
 *     term. Hence MIN_TERM: a term too short to identify anything is dropped, never searched.
 * If the model gives nothing usable we fall back to the user's OWN words, which is worse at
 * spelling and better than an empty screen.
 */
const MIN_TERM = 3;

planned.post("/planned/ai-detect", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { description } = await c.req.json<{ description?: string }>();
  if (!description?.trim()) return c.json({ error: "description required" }, 400);

  const { callHaikuJson } = await import("../../lib/ai/json.ts");
  const { MODEL_SMART } = await import("../../lib/ai/models.ts");
  let terms: string[] = [];
  try {
    const { result } = await callHaikuJson<{ terms?: string[] }>(
      c.env,
      [{
        type: "text",
        text:
          "The user is describing a recurring payment (a subscription) they want found in their bank history. " +
          "Return the SEARCH TERMS a bank statement might actually carry for it — the brand's names in every " +
          "form it is billed or spoken about: the current legal/billing name, the well-known former name, and " +
          "the Cyrillic transliteration when the user's language is Ukrainian. " +
          "Example: \"моя підписка на твітер\" → [\"X Corp\", \"Twitter\", \"твітер\", \"X\"]; " +
          "\"інтернет Київстар\" → [\"Київстар\", \"Kyivstar\"]. " +
          "2-5 terms, each a NAME and nothing else — no words like \"subscription\", \"monthly\" or \"payment\", " +
          "which appear in half the statement and identify nothing. " +
          "Answer with VALID JSON ONLY: {\"terms\": [\"...\"]}",
      }],
      [{ type: "text", text: description.slice(0, 300) }],
      200,
      MODEL_SMART,
    );
    terms = (result.terms ?? []).map((t) => String(t).trim()).filter(Boolean);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
  // ⚠️ The floor is applied to the MODEL's answer too, not only to ours: it happily returns "X"
  // for X Corp., which is a true name and a useless query.
  let usable = terms.filter((t) => t.length >= MIN_TERM);
  if (!usable.length) {
    usable = description.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_TERM).slice(0, 4);
  }
  if (!usable.length) return c.json({ terms, candidates: [] } satisfies AiDetectResult);

  // Схожі витрати за ~200 днів згруповані по мерчанту+валюті (без переказів).
  const since = Math.floor(Date.now() / 1000) - 200 * 86400;
  const matches = await planningRepo.merchantMatches(c.env.DB, usable, since);

  const candidates = matches.map((r) => ({
    title: r.merchant,
    period_amount: Math.round(r.avg_amount),
    currency_code: r.currency_code,
    n: r.n,
    last_time: r.last_time,
    category_id: r.category_id,
    avg_interval_days: r.n > 1 ? Math.round((r.last_time - r.first_time) / (r.n - 1) / 86400) : 30,
  }));
  return c.json({ terms: usable, candidates } satisfies AiDetectResult);
});

/**
 * §SUB-PAGE — one subscription, with the analytics a decision about it needs.
 *
 * Declared ABOVE `/planned/:id` handlers is not required (this literal is longer), but it is
 * declared before them anyway so the file reads in the order Hono matches (lint C7).
 */
planned.get("/planned/:id/overview", async (c) => {
  const { subscriptionOverview } = await import("../../lib/finance/subscription-overview.ts");
  // A path id is not a query param with a sensible default: `Number("abc")` is NaN, and NaN in a
  // `.bind()` is a silent zero that answers "no such plan" as though the plan had been deleted.
  const id = Number(c.req.param("id"));
  const out = Number.isFinite(id) ? await subscriptionOverview(c.env, id) : null;
  if (!out) return c.json({ error: st(c.get("locale"), "errPlanNotFound") }, 404);
  return c.json(out satisfies SubscriptionOverview);
});

/**
 * §PLAN-LINK — re-run the back-link for ONE plan, from its own page.
 *
 * The page can now SEE a hole in the schedule (§RHYTHM `skipped_gaps`), and a screen that points
 * at a problem it could fix itself but does not is worse than one that stays quiet. The real case:
 * Apple bills on the 6th without fail, five charges in the ledger, four linked — so the page read
 * «кожні ~41 дн» and warned about drift, over one row nothing had attached.
 *
 * Declared above `/planned/:id` for the same reason as `/overview` (lint C7 reads top-down).
 */
planned.post("/planned/:id/relink", async (c) => {
  const { linkPlanHistoryById } = await import("../../lib/finance/subscriptions.ts");
  // A PATH id is not a query param: `numParam` clamps a query default, while here a non-numeric
  // segment is a bad request, and `Number("abc")` is NaN — which `.bind()` would treat as a silent
  // zero and answer "no such plan" as though it had been deleted (§Обробка помилок).
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: st(c.get("locale"), "errPlanNotFound") }, 404);
  return c.json(await linkPlanHistoryById(c.env.DB, id));
});

planned.delete("/planned/:id", async (c) => {
  await planningRepo.deactivate(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// §R5: редагувати підписку (наразі — опис для AI; розширювано за потреби).
planned.patch("/planned/:id", async (c) => {
  const b = await c.req.json<{ note?: string | null; category_id?: number | null }>();
  const id = Number(c.req.param("id"));
  await planningRepo.update(c.env.DB, id, {
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
    ...(b.category_id !== undefined ? { category_id: b.category_id } : {}),
  });
  // §PLAN-LINK: both editable fields CHANGE WHAT THE PLAN MATCHES. The note carries the plan's
  // other names (§SUB-ALIAS — «X Corp.» is the owner's Twitter), and the category is what an
  // uncategorised charge can now be filed under. Adding either and seeing nothing happen is the
  // same dead end the create route had.
  let linked = 0;
  try {
    const { linkPlanHistoryById } = await import("../../lib/finance/subscriptions.ts");
    linked = (await linkPlanHistoryById(c.env.DB, id)).linked;
  } catch { /* best-effort, as on create */ }
  return c.json({ ok: true, linked });
});

/**
 * §HABITS → a plan in one click.
 *
 * The "newly regular" block found what the user had declared nowhere, and stopped there: to track
 * what it just found you had to go to Plans and retype what the app already knew. Detection
 * without an action is a report, not a tool.
 *
 * ⚠️ The amount and the date are computed by the SERVER, not the client, and not taken from the
 * request body. `HabitChange.monthly` is already converted to UAH, while
 * `planned_payments.period_amount` is stored in the PLAN's own currency (§CUR-PLAN) — passing a
 * UAH figure together with `currency_code: USD` is precisely the bug that made a $5 subscription
 * weigh 5 ₴. So the client sends only the merchant name, and the profile (amount in its own
 * currency, first charge, most common category) is read from the transactions.
 * ⚠️ The period is monthly and is NOT guessed: most of what §HABITS catches is monthly, and a
 * wrong quarterly plan would quietly corrupt both the month forecast and safe-to-spend. Fixing the
 * period in the plan form is one click; noticing that it is wrong is not.
 */
planned.post("/planned/from-habit", async (c) => {
  const { merchant } = await c.req.json<{ merchant?: string }>();
  const name = merchant?.trim();
  if (!name) return c.json({ error: "merchant required" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const profile = await planningRepo.merchantProfile(c.env.DB, name, now - 400 * 86400);
  if (!profile) return c.json({ error: st(c.get("locale"), "errHabitNoCharges") }, 404);

  const id = await planningRepo.create(c.env.DB, {
    title: name,
    kind: "subscription",
    total_amount: null,
    period_amount: Math.round(profile.avg_amount),
    period: "month",
    period_count: 1,
    start_date: profile.first_time,
    end_date: null,
    occurrences: null,
    category_id: profile.category_id,
    account_id: null,
    currency_code: profile.currency_code,
  });
  return c.json({ ok: true, id } satisfies PlanFromHabit);
});

// §R5: закрити кандидата в підписки («це не підписка») — детект більше не пропонує.
planned.post("/planned/dismiss", async (c) => {
  const { merchant } = await c.req.json<{ merchant?: string }>();
  if (!merchant?.trim()) return c.json({ error: "merchant required" }, 400);
  await planningRepo.dismissMerchant(c.env.DB, merchant.trim(), Math.floor(Date.now() / 1000));
  return c.json({ ok: true });
});

// Ре-світ: виправити категорію наявних операцій, що підпадають під активну підписку,
// але зараз розкладені інакше (fix для вже неправильних, як Apple $1 у «Розвагах»). Без AI.
planned.post("/planned/apply-categories", async (c) => {
  const { applySubscriptionCategories } = await import("../../lib/finance/subscriptions.ts");
  const r = await applySubscriptionCategories(c.env.DB);
  return c.json(r);
});

/**
 * §SUB-DETECT — recurring charges the user has NOT declared.
 *
 * The grouping and every threshold live in `lib/finance/recurring.ts`; the route reads the ledger
 * and subtracts what the user has already answered for. The old version grouped by exact
 * merchant+amount in SQL and therefore could not see a single foreign-currency subscription — see
 * that file for what that cost.
 */
planned.get("/planned/detect", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 400 * 86400; // ширше вікно — щоб зловити квартальні/рідші підписки
  const { recurringCandidates } = await import("../../lib/finance/recurring.ts");
  const { planNeedles, planMatches } = await import("../../lib/finance/subscriptions.ts");

  const [charges, aiFlagged, declared, dismissedSet] = await Promise.all([
    planningRepo.detectCharges(c.env.DB, since),
    // §AI-RECURRING: the model's guess from a SINGLE charge — 120 days, because a subscription
    // nobody has confirmed in four months is one they have decided not to.
    planningRepo.aiRecurringCandidates(c.env.DB, now - 120 * 86400),
    planningRepo.declaredPlans(c.env.DB),
    // §R5: виключаємо закриті користувачем кандидати («це не підписка»).
    planningRepo.dismissedMerchants(c.env.DB),
  ]);

  const deterministic = recurringCandidates(charges, now);
  // §AI-RECURRING rides BEHIND the deterministic ones and never replaces one: a rhythm measured in
  // the ledger is evidence, a model reading one charge is a guess, and the screen labels them
  // differently for that reason. A merchant the rhythm already found is not proposed twice.
  const found = new Set(deterministic.map((r) => r.merchant.toLowerCase()));
  const aiRows: RecurringCandidate[] = aiFlagged
    .filter((r) => !found.has(r.merchant.toLowerCase()))
    .map((r) => ({
      merchant: r.merchant, amount: r.amount, n: r.n,
      first_time: r.first_time, last_time: r.last_time,
      // One charge is one month. Claiming two would put a rhythm behind a guess.
      months: 1,
      // The plan has to start somewhere and monthly is what a subscription overwhelmingly is; the
      // user edits it on the form, and §PLAN-LINK will attach whatever actually matches.
      avg_interval_days: 30,
      currency_code: r.currency_code, category_id: r.category_id, ai: true,
    }));

  const candidates = [...deterministic, ...aiRows]
    // ⚠️ §SUB-ALIAS: a declared plan is known by EVERY one of its names, not by its title alone.
    // Comparing titles byte-for-byte left «X Corp.» proposed as new while the plan «Twitter» that
    // covers it sat two rows above — the app offering to create what it already has.
    .filter((r) => !declared.some((p) => planMatches(p, r.merchant)
      || planNeedles(p).some((n) => n.toLowerCase() === r.merchant.toLowerCase())))
    .filter((r) => !dismissedSet.has(r.merchant.toLowerCase()));

  return c.json(candidates satisfies RecurringCandidate[]);
});

// §4 Прийдешні планові списання (підписки/розстрочки) у горизонті N днів — для віджета
// «скоро спишеться» на Головній. Перетинає межу місяця (на відміну від forecast).
planned.get("/planned/upcoming", async (c) => {
  const url = new URL(c.req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + days * 86400;

  const { nextChargeUnix, plannedUAH } = await import("../../lib/finance/subscriptions.ts");
  const rates = await getRates(c.env);
  const planned = await planningRepo.activeWithCategory(c.env.DB);

  // §CUR-PLAN: `amount` лишається у ВАЛЮТІ ПЛАНУ (щоб показати «$5», а не «≈208 ₴»),
  // `amount_uah` — зведення для підсумків. Раніше валюта губилась і $5 ставало 5 ₴.
  const items = planned
    .filter((p) => !(p.kind === "installment" && p.end_date != null && p.end_date <= now))
    .map((p) => ({
      id: p.id, title: p.title,
      amount: p.period_amount ?? 0,
      currency_code: p.currency_code ?? 980,
      amount_uah: plannedUAH(p.period_amount, p.currency_code, rates),
      at: nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now),
      days_until: 0,
    }))
    .filter((p) => p.amount > 0 && p.at <= horizon)
    .map((p) => ({ ...p, days_until: Math.max(0, Math.round((p.at - now) / 86400)) }))
    .sort((a, b) => a.at - b.at);

  return c.json({ days, total: items.reduce((s, p) => s + p.amount_uah, 0), items } satisfies UpcomingSubs);
});
