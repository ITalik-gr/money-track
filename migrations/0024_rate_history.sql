-- Історія курсів валют. До неї нетворт (`/analytics/networth`) перераховував ВСІ минулі
-- валютні залишки ПОТОЧНИМ курсом — тобто рух курсу виглядав як рух грошей, і це чесно
-- писалось у `caveats` під графіком. Тепер фіксуємо курс щодоби (крон) і беремо на дату точки.
--
-- rate — скільки ГРИВЕНЬ за одну одиницю валюти (як у `app_state.rates`), тож формат сумісний
-- і конверсія в обох місцях працює однаково.
-- Ретроспективно НЕ заповнюється: минулих курсів у нас нема, тож для дат до першого запису
-- фолбек лишається поточним курсом (і caveat про це лишається, поки історія не набереться).
CREATE TABLE IF NOT EXISTS rate_history (
  day  TEXT    NOT NULL,          -- 'YYYY-MM-DD' (UTC)
  code INTEGER NOT NULL,          -- ISO 4217 валюти (840 USD, 978 EUR…)
  rate REAL    NOT NULL,          -- ₴ за 1 одиницю
  ts   INTEGER NOT NULL,
  PRIMARY KEY (day, code)
);
CREATE INDEX IF NOT EXISTS idx_rate_history_code_day ON rate_history(code, day);
