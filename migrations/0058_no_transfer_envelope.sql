-- §BUDGET-TRANSFER: an envelope on «Перекази і зняття» (id 13) or its children can never count
-- anything — moving one's own money is excluded from spending — so it read 0% forever. The API now
-- refuses one; this removes the ones that already exist. Closed-month history is left untouched.
DELETE FROM budgets WHERE category_id IN (SELECT id FROM categories WHERE id = 13 OR parent_id = 13);
