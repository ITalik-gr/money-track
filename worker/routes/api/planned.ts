// `/planned/*` — planned payments and subscriptions.
//
// `period_amount` is in the PLAN's currency and its period is the PLAN's period: never sum it
// raw. ₴ totals go through `plannedUAH`/`sumPlannedUAH` (§CUR-PLAN), a monthly burden through
// `monthlyPlannedUAH` (§SUB-MONTH), and "what is charged before month end" through `chargesBetween`.
import { getRates } from "../../lib/finance/money.ts";
import * as planningRepo from "../../repo/planning.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { PlannedPayment, PlannedActual } from "../../../shared/types.ts";
import type { UpcomingSubs, RecurringCandidate, PlanFromHabit } from "../../../shared/api/planning.ts";

export const planned = apiRoutes();

// §Хвіст: факт vs план по підписках — фактичні списання, лічильник, ознака подорожчання.
planned.get("/planned/actuals", async (c) => {
  const { plannedActuals } = await import("../../lib/finance/subscriptions.ts");
  return c.json(await plannedActuals(c.env.DB) satisfies PlannedActual[]);
});

planned.get("/planned", async (c) => {
  return c.json(await planningRepo.listActive(c.env.DB) satisfies PlannedPayment[]);
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
  return c.json({ ok: true, id, occurrences, end_date });
});

// AI-детект підписки за описом (§F4): користувач описує словами → AI дістає пошуковий
// запит; шукаємо схожі транзакції, рахуємо середню суму/валюту/каденцію → кандидат.
planned.post("/planned/ai-detect", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { description } = await c.req.json<{ description?: string }>();
  if (!description?.trim()) return c.json({ error: "description required" }, 400);

  const { callHaikuJson } = await import("../../lib/ai/json.ts");
  const { MODEL_SMART } = await import("../../lib/ai/models.ts");
  let query = "";
  try {
    // Sonnet 5 — точніше витягує ключове слово мерчанта з вільного опису підписки.
    const { result } = await callHaikuJson<{ merchant_query: string }>(
      c.env,
      [{ type: "text", text: "Користувач описує рекурентний платіж (підписку). Витягни коротке ключове слово для пошуку мерчанта в транзакціях (латиницею або як у виписці, напр. «моя підписка на Anthropic»→«Anthropic», «інтернет Київстар»→«Київстар»). Відповідай ВИКЛЮЧНО JSON {\"merchant_query\": \"...\"}." }],
      [{ type: "text", text: description.slice(0, 300) }],
      120,
      MODEL_SMART,
    );
    query = (result.merchant_query ?? "").trim();
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
  if (!query) return c.json({ candidates: [] });

  // Схожі витрати за ~200 днів згруповані по мерчанту+валюті (без переказів/холдів).
  const since = Math.floor(Date.now() / 1000) - 200 * 86400;
  const matches = await planningRepo.merchantMatches(c.env.DB, query, since);

  const candidates = matches.map((r) => ({
    title: r.merchant,
    period_amount: Math.round(r.avg_amount),
    currency_code: r.currency_code,
    n: r.n,
    last_time: r.last_time,
    category_id: r.category_id,
    avg_interval_days: r.n > 1 ? Math.round((r.last_time - r.first_time) / (r.n - 1) / 86400) : 30,
  }));
  return c.json({ query, candidates });
});

planned.delete("/planned/:id", async (c) => {
  await planningRepo.deactivate(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// §R5: редагувати підписку (наразі — опис для AI; розширювано за потреби).
planned.patch("/planned/:id", async (c) => {
  const b = await c.req.json<{ note?: string | null; category_id?: number | null }>();
  await planningRepo.update(c.env.DB, Number(c.req.param("id")), {
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
    ...(b.category_id !== undefined ? { category_id: b.category_id } : {}),
  });
  return c.json({ ok: true });
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

// Detect recurring payments (§7 "детект підписок"): same merchant+amount charged in
// ≥2 distinct months over the last ~120 days, on a roughly monthly cadence. Heuristic,
// no AI. Excludes merchants already declared as active planned payments.
planned.get("/planned/detect", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 200 * 86400; // ширше вікно — щоб зловити квартальні/рідші підписки
  // §G2: ВИКЛЮЧАЄМО перекази (is_transfer) і бакет «Перекази і зняття» (13 + діти) —
  // інакше в кандидати лізуть «Округлення балансу», перекази брату/людям тощо.
  // §G3: пропонуємо суджену категорію (найчастіша серед матчів) для звʼязку з підпискою.
  const rows = await planningRepo.detectCandidates(c.env.DB, since);
  const declaredSet = await planningRepo.declaredTitles(c.env.DB);
  // §R5: виключаємо закриті користувачем кандидати («це не підписка»).
  const dismissedSet = await planningRepo.dismissedMerchants(c.env.DB);

  const candidates = rows
    .map((r) => ({
      ...r,
      avg_interval_days: r.n > 1 ? Math.round((r.last_time - r.first_time) / (r.n - 1) / 86400) : 0,
    }))
    // Каденція від ~тижня до ~кварталу (виключає щоденні однакові покупки, напр. каву).
    .filter((r) => r.avg_interval_days >= 6 && r.avg_interval_days <= 100)
    .filter((r) => !declaredSet.has(r.merchant.toLowerCase()))
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
