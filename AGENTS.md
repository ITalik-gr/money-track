<!-- Свідомо лишено (рішення 2026-07-21): цей файл — конвенція для агентів, що читають AGENTS.md
     (Codex/Cursor тощо). Claude Code отримує ті самі правила через SessionStart-хук, тож для
     НЬОГО це дубль — але для інших інструментів це єдине джерело. -->

# Де що лежить (для будь-якого агента)

- **`CLAUDE.md`** — точка входу: мапа документів, робочий процес, стек, мапа коду, тверді
  інваріанти та **індекс усіх §-правил**. Прочитай його першим.
- **`docs/*.md`** — деталі по домену: `CANON.md` (гроші й статистика — перед будь-яким числом),
  `INGEST.md`, `AI.md`, `PERIMETER.md`, `I18N.md`, `UI.md`, `OPS.md`.
- **`ROADMAP.md`** — жива черга. Нову задачу/баг пиши сюди; доробив — видали картку.
- **`DESIGN.md`** — читай ПЕРШИМ перед будь-якою роботою над UI/UX.
- **`HISTORY.md`** — архів, ⛔ не читати за замовчуванням (він величезний).

Green-бар перед «готово»: `npm run check` + `npm run build`. Гроші — тільки через
`worker/lib/finance/stats.ts`. SQL — тільки в `worker/repo/`.

# Стиль відповіді

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
