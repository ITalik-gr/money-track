-- §P2.1 — історія внесків у ціль.
--
-- Було: `savings_goals.current_amount` — одне плоске число, яке доводилось перезаписувати
-- цілком. З нього не видно НІЧОГО, крім поточної суми: ні коли відкладав, ні скільки за
-- останній місяць, ні чи взагалі рухається. Тобто «ціль» була пам'яткою, а не інструментом.
--
-- Тепер `current_amount` = SUM(amount) по цій таблиці. Знак значущий: додатний = внесок,
-- від'ємний = зняття (без окремої таблиці й окремої гілки в UI — зняття це той самий рух,
-- просто в інший бік).
--
-- ⚠️ `current_amount` на `savings_goals` НЕ видаляємо: це денормалізований підсумок, який
-- читають старі шляхи, і саме він тримає ціль, привʼязану до банки (там джерело правди —
-- баланс рахунку, а не внески). Єдиний писар — ендпоінти внесків.
CREATE TABLE IF NOT EXISTS goal_contributions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id  INTEGER NOT NULL,
  -- ₴-копійки, як усі гроші в проєкті. + внесок, − зняття.
  amount   INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  note     TEXT,
  -- 'manual' | 'auto' — задел під авто-поповнення; зараз пишеться лише 'manual'.
  source   TEXT NOT NULL DEFAULT 'manual',
  FOREIGN KEY (goal_id) REFERENCES savings_goals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_contrib ON goal_contributions (goal_id, at);

-- Бекфіл: наявний `current_amount` стає ПЕРШИМ внеском, інакше історія почалась би з нуля
-- і прогрес усіх наявних цілей обнулився б на очах у користувача.
INSERT INTO goal_contributions (goal_id, amount, at, note, source)
SELECT id, current_amount, created_at, NULL, 'manual'
FROM savings_goals
WHERE current_amount <> 0;
