-- docs/JEV.md phase 3 — what Jev PROPOSES about one operation, kept apart from what is decided.
--
-- Two columns beside the two that already exist, not written INTO them:
--   `importance`  (0016) is the human override that `EFF_IMPORTANCE` reads first;
--   `is_business` (§TAX-BASE) is the human answer that moves a TAX figure.
-- A model writing either would make a guess authoritative with nobody having looked — the rule
-- §A1 facts already keep («a model-authored fact ALWAYS passes confirm: false»). So the model
-- writes here, the screen offers it, and only a person's click copies it across.
--
-- NULL means «never asked», which is different from any answer — the same distinction migration
-- 0046 made for `ai_recurring`.
--   ai_importance  essential | discretionary | optional  (the canon's three levels, §6)
--   ai_business    probability 0..1 that this is work money, as the judge returned it — kept as a
--                  probability so the screen's threshold can move without asking again
ALTER TABLE transactions ADD COLUMN ai_importance TEXT;
ALTER TABLE transactions ADD COLUMN ai_business REAL;
