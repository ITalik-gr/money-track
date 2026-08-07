// `/reports/*` — stored AI reports (weekly / monthly), their listing and generation.
import * as reportsRepo from "../../repo/reports.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";

export const reports = apiRoutes();

// §Аналітика 2.0 — AI-репорти (щотижня/щомісяця, історія зберігається).
reports.get("/reports", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 24), 60);
  return c.json(await reportsRepo.list(c.env.DB, url.searchParams.get("type"), limit));
});

reports.get("/reports/:id", async (c) => {
  const row = await reportsRepo.find(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const { data_json, ...meta } = row;
  return c.json({ ...meta, data: JSON.parse(data_json) });
});

// Видалити репорт (напр. тестові генерації). Ідемпотентно — 404 не критично.
reports.delete("/reports/:id", async (c) => {
  await reportsRepo.remove(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

// Згенерувати репорт на вимогу (кнопка).
//   type=week|month + scope=last (завершений період, як у крона) | current (поточний до сьогодні);
//   type=custom + from/to (unix, секунди) — довільний діапазон, обраний користувачем.
// force перегенеровує наявний репорт того самого періоду.
//
// ⚠️ `scope` за замовчуванням був `current`, і це й був баг: кнопка «за тиждень» завжди рахувала
// ПОТОЧНИЙ тиждень до сьогодні, тож у понеділок вранці вона давала майже порожній звіт, а
// завершений тиждень вручну не генерувався взагалі. Тепер дефолт — `last`, як у крона.
reports.post("/reports/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ type?: string; force?: boolean; scope?: string; from?: number; to?: number }>()
    .catch(() => ({} as { type?: string; force?: boolean; scope?: string; from?: number; to?: number }));
  const locale = c.get("locale");

  const { generateAndStoreReport, CUSTOM_MIN_DAYS, CUSTOM_MAX_DAYS } = await import("../../lib/ai/report.ts");

  // Кастомний діапазон розпізнаємо і за явним type, і за самою присутністю меж — клієнт, що
  // прислав from/to, точно не хоче пресетний тиждень.
  const wantsCustom = body.type === "custom" || (Number.isFinite(body.from) && Number.isFinite(body.to));
  let range: { from: number; to: number } | undefined;
  if (wantsCustom) {
    const from = Math.floor(Number(body.from));
    const to = Math.floor(Number(body.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return c.json({ error: st(locale, "reportBadRange") }, 400);
    }
    const days = (to - from) / 86400;
    if (days < CUSTOM_MIN_DAYS || days > CUSTOM_MAX_DAYS) {
      return c.json({ error: st(locale, "reportRangeLimits", { min: CUSTOM_MIN_DAYS, max: CUSTOM_MAX_DAYS }) }, 400);
    }
    range = { from, to };
  }

  const t = wantsCustom ? "custom" as const : body.type === "month" ? "month" as const : "week" as const;
  try {
    const res = await generateAndStoreReport(c.env, t, {
      force: body.force ?? true,
      scope: body.scope === "current" ? "current" : "last",
      range,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
