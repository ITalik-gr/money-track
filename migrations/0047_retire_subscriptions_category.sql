-- §SUBS-CAT — retire the «Підписки» spending category (ROADMAP §0.1a, owner's decision 2026-09-02).
--
-- WHY. A subscription is a PROPERTY of an operation (`planned_id`), not a place in the taxonomy.
-- A category answers "what was this money spent on"; a plan answers "is this a recurring charge".
-- With a category of the same name, both answers competed for the same rows and nothing decided
-- between them — the owner's report: «є ж у мене софт і хмара, та підписки. підписки на клауд
-- потрапляють туди і туди». Where a given Claude charge landed was down to whether enrich, an
-- alias or a human touched it last, so the same money moved between categories month to month.
-- «Скільки я віддаю за підписки» is answered by the Subscriptions page and the canonical
-- `monthlyPlannedUAH`, and — per category — by the §CAT-SUBS block.
--
-- The two children stay: they name real spending, and only their PARENT was wrong.
--   · «Стрімінги» is entertainment, so it joins «Розваги».
--   · «Софт і хмара» is its own domain and had no top-level home, so it becomes one.
UPDATE categories SET parent_id = 6    WHERE id = 42 AND parent_id = 12;
UPDATE categories SET parent_id = NULL WHERE id = 43 AND parent_id = 12;

-- ⚠️ The category itself is removed ONLY when nothing still points at it. Silently re-filing
-- somebody's operations into «Інше» would be the app overruling a decision a human made — the
-- same rule that stops §RULES-UI apply, §SIMILAR and the §AI-AUDIT revert from touching rows that
-- already carry an answer. An account that still has rows there keeps the category, now childless,
-- and its owner moves them when they choose.
--
-- Every table that can name a category is listed. A table missing from this list would let the
-- delete succeed against a live reference — with foreign keys ON inside the Durable Object, that
-- is a failed migration; with them off, it is a dangling id nobody would ever look for.
DELETE FROM categories
WHERE id = 12
  AND NOT EXISTS (SELECT 1 FROM categories        WHERE parent_id        = 12)
  AND NOT EXISTS (SELECT 1 FROM transactions      WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM transactions      WHERE real_category_id = 12)
  AND NOT EXISTS (SELECT 1 FROM tx_splits         WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM transaction_tags  WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM merchant_aliases  WHERE category_id      = 12 OR real_category_id = 12)
  AND NOT EXISTS (SELECT 1 FROM rules             WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM planned_payments  WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM budgets           WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM budget_months     WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM receipt_items     WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM event_planned     WHERE category_id      = 12)
  AND NOT EXISTS (SELECT 1 FROM facts             WHERE category_id      = 12);
