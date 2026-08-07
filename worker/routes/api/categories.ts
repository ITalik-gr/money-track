// `/categories/*` — the category tree. The delete is a CASCADE and its step ORDER is the
// behaviour: the harness enforces foreign keys, so a step moved after the row is deleted fails.
import * as categoriesRepo from "../../repo/categories.ts";
import { localizeCatName } from "../../lib/finance/categories-i18n.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normImportance } from "./_shared.ts";

export const categories = apiRoutes();

// ---- reference data ---------------------------------------------------------

categories.get("/categories", async (c) => {
  const rows = await categoriesRepo.listAll(c.env.DB);
  const loc = c.get("locale");
  // Localize seed names in JS (the row already carries `name`); user categories pass through.
  return c.json(rows.map((r) => ({ ...r, name: localizeCatName(loc, r.name) })));
});

// ---- custom categories ------------------------------------------------------

categories.post("/categories", async (c) => {
  const b = await c.req.json<{ name: string; color?: string; icon?: string; parent_id?: number | null; is_income?: boolean; importance?: string | null }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = await categoriesRepo.create(c.env.DB, {
    name: b.name.trim(),
    color: b.color ?? "#6B7A74",
    icon: b.icon ?? "dots",
    parent_id: b.parent_id ?? null,
    is_income: !!b.is_income,
    importance: normImportance(b.importance),
  });
  return c.json({ ok: true, id });
});

// Редагувати будь-яку категорію (зокрема вбудовану): назва/колір/іконка/батько.
// Колонки вже є (міграція 0005), нової міграції не треба. parent_id=null → верхній рівень.
categories.patch("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ name?: string; color?: string; icon?: string; parent_id?: number | null; importance?: string | null }>();
  if (!(await categoriesRepo.exists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  if (b.name !== undefined && !b.name.trim()) return c.json({ error: "name required" }, 400);

  await categoriesRepo.update(c.env.DB, id, {
    ...(b.name !== undefined ? { name: b.name.trim() } : {}),
    ...(b.color !== undefined ? { color: b.color } : {}),
    ...(b.icon !== undefined ? { icon: b.icon } : {}),
    ...(b.importance !== undefined ? { importance: normImportance(b.importance) } : {}),
    ...(b.parent_id !== undefined ? { parent_id: b.parent_id } : {}),
  });
  return c.json({ ok: true });
});

// Видалити можна лише кастомну категорію; транзакції знеприв'язуються.
// Скільки всього прив'язано до категорії (для діалогу «куди перенести перед видаленням»).
categories.get("/categories/:id/usage", async (c) => {
  return c.json(await categoriesRepo.usage(c.env.DB, Number(c.req.param("id"))));
});

// Видалити категорію, перенісши всі прив'язки на іншу (reassign) або знявши їх (null).
// Захищена лише категорія «Перекази і зняття» (13) — на ній тримається логіка бакета.
categories.delete("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 13) return c.json({ error: st(c.get("locale"), "errTransferCatLocked") }, 400);
  if (!(await categoriesRepo.exists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);

  const raw = new URL(c.req.url).searchParams.get("reassign");
  const target = raw && raw !== "none" && Number(raw) !== id ? Number(raw) : null;

  try {
    // ORDER IS THE BEHAVIOUR: every table referencing the category is dealt with first, and the
    // row itself goes last — the schema enforces those foreign keys, so a step moved after the
    // delete fails. Each call is one table; what "no target" means differs per table and is
    // documented at each function.
    const db = c.env.DB;
    await categoriesRepo.reassignTransactions(db, id, target);
    await categoriesRepo.reassignTags(db, id, target);
    await categoriesRepo.reassignAliases(db, id, target);
    await categoriesRepo.reassignReceiptItems(db, id, target);
    await categoriesRepo.reassignRules(db, id, target);
    await categoriesRepo.reassignPlanned(db, id, target);
    await categoriesRepo.reassignBudgets(db, id, target);
    await categoriesRepo.reassignChildren(db, id, target);
    await categoriesRepo.remove(db, id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
