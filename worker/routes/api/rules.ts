/**
 * `/rules/*` — the DETERMINISTIC categorisation layer, finally editable.
 *
 * `rules` has been the fourth step of `categorize()` since migration 0001 (learned alias →
 * active subscription → merchant consensus → **rules** → AI), and until now the only way to add
 * one was to edit the database by hand: the table carried ~100 seeded MCC lines and nothing else,
 * forever. Every correction a person made instead went through the AI on the next similar
 * operation, or through a learned alias that matches ONE exact merchant.
 *
 * What a rule buys over an alias is the PATTERN: "anything whose description contains таксі" is a
 * standing instruction, costs nothing to run, and cannot hallucinate. Making it writable is the
 * cheapest accuracy the app has left.
 *
 * ⚠️ Ordering is `mcc` first, then `text`, both by descending priority — that is `categorize()`,
 * not a choice made here, and the UI must not imply otherwise. A user who needs to beat a seeded
 * MCC rule creates an `mcc` rule with a higher priority (the seed uses 10); no migration and no
 * special case is needed for that, which is why none exists.
 */
import * as rulesRepo from "../../repo/rules.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import { catNameSql } from "../../lib/finance/categories-i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { RuleRow, RulePreview, RuleApplyResult } from "../../../shared/api/rules.ts";

export const rules = apiRoutes();

/** How far back a preview or an apply looks. A year is enough to judge a pattern and bounded. */
const WINDOW_DAYS = 365;
const since = () => Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;

/** Only the two the engine understands — a third value would be a rule that silently never fires. */
const isMatchType = (v: unknown): v is "mcc" | "text" => v === "mcc" || v === "text";

/**
 * Validate a rule's body once, for both create and update.
 *
 * The pattern floor is 2 characters: a one-letter substring matches nearly every operation, and a
 * rule that files the whole history into one category is not a mistake anyone spots quickly.
 */
async function parseBody(
  db: Parameters<typeof categoriesRepo.existingIds>[0],
  b: { match_type?: unknown; pattern?: unknown; category_id?: unknown; priority?: unknown },
): Promise<{ match_type: "mcc" | "text"; pattern: string; category_id: number; priority: number } | { error: string }> {
  if (!isMatchType(b.match_type)) return { error: "match_type must be 'mcc' or 'text'" };
  const pattern = typeof b.pattern === "string" ? b.pattern.trim() : "";
  if (pattern.length < 2) return { error: "pattern must be at least 2 characters" };
  if (b.match_type === "mcc" && !/^\d{2,4}$/.test(pattern)) return { error: "an MCC pattern must be 2-4 digits" };
  const category_id = Math.trunc(Number(b.category_id));
  if (!Number.isFinite(category_id)) return { error: "category_id required" };
  // §FK-GUARD: the id has to EXIST. Category ids have gaps from deletions, so a plausible-looking
  // number lands on no row and the insert dies with a foreign-key error at write time.
  const ok = await categoriesRepo.existingIds(db, [category_id]);
  if (!ok.length) return { error: "no such category" };
  const priority = Number.isFinite(Number(b.priority)) ? Math.trunc(Number(b.priority)) : 0;
  return { match_type: b.match_type, pattern, category_id, priority };
}

rules.get("/rules", async (c) => {
  return c.json(await rulesRepo.listAll(c.env.DB, catNameSql(c.get("locale"), "c.name")) satisfies RuleRow[]);
});

/**
 * What this rule would do — asked BEFORE it exists, which is why it takes a body rather than an id.
 *
 * ⚠️ Declared above `/rules/:id` (lint C7): `preview` would otherwise be read as an id.
 */
rules.post("/rules/preview", async (c) => {
  const b = await c.req.json<{ match_type?: string; pattern?: string }>()
    .catch(() => ({} as { match_type?: string; pattern?: string }));
  if (!isMatchType(b.match_type)) return c.json({ error: "match_type must be 'mcc' or 'text'" }, 400);
  const pattern = (b.pattern ?? "").trim();
  if (pattern.length < 2) return c.json({ error: "pattern must be at least 2 characters" }, 400);
  return c.json(await rulesRepo.preview(c.env.DB, b.match_type, pattern, since()) satisfies RulePreview);
});

rules.post("/rules", async (c) => {
  const parsed = await parseBody(c.env.DB, await c.req.json().catch(() => ({})));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  return c.json({ ok: true, id: await rulesRepo.create(c.env.DB, parsed) });
});

/**
 * File the operations this rule matches that have NO category yet.
 *
 * Separate from creating the rule, and never automatic: a rule is about FUTURE operations, and
 * rewriting the past is a different decision that the person should make deliberately. Only
 * uncategorised rows are touched — see `applyToUncategorised` for why.
 */
rules.post("/rules/:id/apply", async (c) => {
  const id = Number(c.req.param("id"));
  const rule = await rulesRepo.byId(c.env.DB, id);
  if (!rule) return c.json({ error: "not_found" }, 404);
  const updated = await rulesRepo.applyToUncategorised(
    c.env.DB, rule.match_type, rule.pattern, rule.category_id, since());
  return c.json({ ok: true, updated } satisfies RuleApplyResult);
});

rules.patch("/rules/:id", async (c) => {
  const b = await c.req.json<{ pattern?: string; category_id?: number; priority?: number }>()
    .catch(() => ({} as { pattern?: string; category_id?: number; priority?: number }));
  const patch: { pattern?: string; category_id?: number; priority?: number } = {};
  if (b.pattern !== undefined) {
    const p = b.pattern.trim();
    if (p.length < 2) return c.json({ error: "pattern must be at least 2 characters" }, 400);
    patch.pattern = p;
  }
  if (b.category_id !== undefined) {
    const ok = await categoriesRepo.existingIds(c.env.DB, [Number(b.category_id)]);
    if (!ok.length) return c.json({ error: "no such category" }, 400);
    patch.category_id = Number(b.category_id);
  }
  if (b.priority !== undefined) patch.priority = Math.trunc(Number(b.priority)) || 0;
  await rulesRepo.update(c.env.DB, Number(c.req.param("id")), patch);
  return c.json({ ok: true });
});

rules.delete("/rules/:id", async (c) => {
  await rulesRepo.remove(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});
