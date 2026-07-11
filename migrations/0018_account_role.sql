-- §R3: рахунки «на некст лвл» — роль рахунку для логіки подушки + опис для AI.
-- role: 'liquid' (дефолт, NULL=liquid) — входить у ліквідну подушку/runway;
--       'investment' — інвест-резерв (крипта, брокер): НЕ подушка за замовчуванням,
--       але остання лінія, якщо все закінчиться (AI має це розуміти).
-- ai_note: вільний опис рахунку, який AI враховує у пораднику/репортах.
ALTER TABLE accounts ADD COLUMN role TEXT;
ALTER TABLE accounts ADD COLUMN ai_note TEXT;
-- Крипту за замовчуванням трактуємо як інвестиційний рахунок.
UPDATE accounts SET role = 'investment' WHERE type = 'crypto' AND role IS NULL;
