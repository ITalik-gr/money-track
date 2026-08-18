// `/settings/*` and `/profile` — per-owner preferences: period mode, UI locale, per-task AI
// model, saved filters. `period_mode` decides the boundaries every other screen counts within.
import { setState, getState } from "../../lib/finance/repo.ts";
import { getPeriodMode } from "../../lib/finance/stats.ts";
import { BASE_CURRENCY_KEY, resolveBaseCurrency, setBaseCurrency } from "../../lib/finance/money.ts";
import { asBaseCurrency, BASE_CURRENCIES } from "../../../shared/currency.ts";

import type { AppDb } from "../../lib/platform/db-shim.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { PeriodMode } from "../../../shared/api/analytics.ts";
import type { SavedFilter as SharedSavedFilter } from "../../../shared/api/platform.ts";

export const settings = apiRoutes();

// Режим періоду (календарний ⇄ ковзний) — єдине джерело для Головної/Статистики/AI.
settings.get("/settings/period-mode", async (c) => {
  const mode = await getPeriodMode(c.env.DB);
  return c.json({ mode } satisfies { mode: PeriodMode });
});

settings.put("/settings/period-mode", async (c) => {
  const { mode } = await c.req.json<{ mode: PeriodMode }>();
  await setState(c.env.DB, "period_mode", mode === "rolling" ? "rolling" : "calendar");
  return c.json({ ok: true, mode });
});

// UI locale (PLATFORM.md §12). Stored per-user in app_state so it is durable across devices
// and readable server-side (AI/notify locale, P3.4). The client renders from localStorage for
// instant paint; this endpoint is the durable mirror, not the render source. Empty = unset,
// the client then falls back to the browser language.
settings.get("/settings/locale", async (c) => {
  const locale = (await getState(c.env.DB, "locale")) || "";
  return c.json({ locale });
});

settings.put("/settings/locale", async (c) => {
  const { locale } = await c.req.json<{ locale: string }>();
  const v = locale === "uk" ? "uk" : locale === "en" ? "en" : null;
  if (!v) return c.json({ error: "invalid locale" }, 400);
  await setState(c.env.DB, "locale", v);
  return c.json({ ok: true, locale: v });
});

/**
 * Display currency (§BASE-CUR) — which unit every rolled-up number is expressed in.
 *
 * GET returns the EFFECTIVE base (what the numbers on this screen are actually in) alongside the
 * stored choice, which may be empty: an account that never picked one follows its language, and
 * the two answers differ exactly then. The client needs both — one to print the sign, one to show
 * the control as "not set" rather than as a choice nobody made.
 */
settings.get("/settings/base-currency", async (c) => {
  const stored = asBaseCurrency(await getState(c.env.DB, BASE_CURRENCY_KEY)) ?? null;
  return c.json({ currency: await resolveBaseCurrency(c.env), stored, options: [...BASE_CURRENCIES] });
});

settings.put("/settings/base-currency", async (c) => {
  const { currency } = await c.req.json<{ currency: number | null }>();
  // `null` clears the choice on purpose — going back to "follow my language" must be sayable,
  // or the only way out of a choice is another choice (the §BUDGET-ZERO lesson, smaller).
  const v = currency === null ? null : asBaseCurrency(currency);
  if (currency !== null && !v) return c.json({ error: st(c.get("locale"), "errCurrencyUnsupported") }, 400);
  await setBaseCurrency(c.env.DB, v ?? null);
  return c.json({ ok: true, currency: await resolveBaseCurrency({ ...c.env, UI_CURRENCY: undefined }) });
});

// AI-моделі ОКРЕМО НА ЗАДАЧУ (report/advisor/insight/…): токен haiku|sonnet|opus на кожну.
// UI редагує три головні (report/advisor/insight); решта — дефолти. Enrich/OCR завжди Haiku.
const AI_MODEL_TASKS = ["report", "advisor", "insight", "chat", "budget", "group", "notify"] as const;
settings.get("/settings/ai-models", async (c) => {
  const { AI_TASK_DEFAULTS, TOKEN_BY_MODEL, MODEL_BY_TOKEN } = await import("../../lib/ai/models.ts");
  const out: Record<string, string> = {};
  for (const t of AI_MODEL_TASKS) {
    const saved = await getState(c.env.DB, `ai_model_${t}`);
    out[t] = saved && MODEL_BY_TOKEN[saved] ? saved : TOKEN_BY_MODEL[AI_TASK_DEFAULTS[t]];
  }
  return c.json({ models: out });
});

settings.put("/settings/ai-models", async (c) => {
  const { MODEL_BY_TOKEN } = await import("../../lib/ai/models.ts");
  const { task, model } = await c.req.json<{ task: string; model: string }>();
  if (!AI_MODEL_TASKS.includes(task as typeof AI_MODEL_TASKS[number]) || !MODEL_BY_TOKEN[model]) {
    return c.json({ error: "invalid task or model" }, 400);
  }
  await setState(c.env.DB, `ai_model_${task}`, model);
  return c.json({ ok: true, task, model });
});

// ---- AI advisor: financial profile + structured advice ----------------------

settings.get("/profile", async (c) => {
  const { getProfile } = await import("../../lib/ai/advisor.ts");
  return c.json({ text: await getProfile(c.env) });
});

settings.put("/profile", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const { setProfile } = await import("../../lib/ai/advisor.ts");
  await setProfile(c.env, (text ?? "").slice(0, 4000));
  return c.json({ ok: true });
});

/**
 * Збережені фільтри Транзакцій («Робочі витрати», «Готівка цього місяця»).
 *
 * Зберігаємо САМ QUERY-РЯДОК, а не розібрані поля: фільтри й так живуть в URL (єдине
 * джерело стану сторінки), тож збережений набір — це просто той самий URL. Нове поле
 * фільтра почне зберігатись автоматично, без міграції й без правок тут.
 * Ліміт 24 — це особистий список швидкого доступу, а не сховище.
 */
const FILTERS_KEY = "saved_filters";
// The contract type, imported — the shape is a response, so it belongs in `shared/api/`.
type SavedFilter = SharedSavedFilter;

async function readFilters(db: AppDb): Promise<SavedFilter[]> {
  const raw = await getState(db, FILTERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SavedFilter[];
    return Array.isArray(parsed) ? parsed.filter((f) => f?.id && f?.name) : [];
  } catch { return []; }
}

settings.get("/settings/saved-filters", async (c) => c.json(await readFilters(c.env.DB)));

settings.post("/settings/saved-filters", async (c) => {
  const b = await c.req.json<{ name?: string; query?: string }>().catch(() => ({} as { name?: string; query?: string }));
  const name = (b.name ?? "").trim().slice(0, 60);
  const query = (b.query ?? "").replace(/^\?/, "").slice(0, 500);
  if (!name) return c.json({ error: st(c.get("locale"), "errFilterNameRequired") }, 400);
  if (!query) return c.json({ error: st(c.get("locale"), "errFilterNoActive") }, 400);

  const list = await readFilters(c.env.DB);
  if (list.length >= 24) return c.json({ error: st(c.get("locale"), "errFilterTooMany", { max: 24 }) }, 400);
  // Та сама назва — перезапис, а не дубль: інакше список швидко заростає «Робочі (2)».
  const idx = list.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
  const item: SavedFilter = { id: idx >= 0 ? list[idx].id : crypto.randomUUID(), name, query };
  if (idx >= 0) list[idx] = item; else list.push(item);
  await setState(c.env.DB, FILTERS_KEY, JSON.stringify(list));
  return c.json(list satisfies SavedFilter[]);
});

settings.delete("/settings/saved-filters/:id", async (c) => {
  const list = (await readFilters(c.env.DB)).filter((f) => f.id !== c.req.param("id"));
  await setState(c.env.DB, FILTERS_KEY, JSON.stringify(list));
  return c.json(list);
});
