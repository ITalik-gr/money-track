# ROADMAP — жива черга задач і фіч

> **Це постійний файл. Тут — ЛИШЕ те, що ще треба зробити.** Зроблене звідси **видаляється**;
> якщо результат важливий довгостроково — стислий підсумок їде в `CLAUDE.md`, наратив — у
> `HISTORY.md`. Довідник/інваріанти → `CLAUDE.md`. Дизайн → `DESIGN.md`. Шари й лінти →
> `ARCHITECTURE.md`.
>
> Останнє прибирання: **2026-08-07** — винесено закриті фази ARCH 0–5 (журнал у `HISTORY.md`,
> durable-частина в `ARCHITECTURE.md`), закриту платформа-фазу й дужки-нотатки «це вже зроблено».
> Файл був 347 рядків, з них понад половина — ✅. **Правило: картка зі статусом ✅ тут не живе.**

## 🚦 Як працювати з цим файлом

1. Бери **найвищу невиконану задачу** з «Черги». Не перестрибуй без причини.
2. Задача = картка: **Ціль · Файли · Кроки · Готово-коли**. Спочатку прочитай згадані файли.
3. **Green-бар перед «готово»:** `npm run check` (tsc + лінти C1–C7 + тести) + `npm run build`.
   Гроші/статистика — лише через `worker/lib/finance/stats.ts`, не дублюй SQL.
4. **UI/UX** — спершу `DESIGN.md`, зміну фіксуй у його «Журналі рішень». Хук impeccable ганяє
   детектор — знайдене виправляй, не глуши.
5. **Доробив → ВИДАЛИ картку звідси.** Нове/баг → у «Беклог» чи «Ідеї фіч».
6. **Live-звірку в чергу НЕ писати.** Користувач ганяє її сам і повідомляє, якщо щось не так.
7. Один PR / логічний блок = одна задача.

---

## Від юзера

- Переглянь репорти, чомусь вони стали малими, та немає репорту за попередній тиждень
- І ти знову пишеш коменти на укр і тд. ЗАПИШИ ДЕСЬ СОБІ, ЩО ВСЕ ТЕПЕР НА АНГЛІЙСЬКІЙ В КОДІ, МД ФАЙЛИ, КОМЕНТИ І ТД

## 🚧 Session log — 2026-08-12 (long batch, may be interrupted)

> **Read this first if a session ended mid-flight.** One line per unit of work, updated AS IT
> LANDS, not at the end. `DONE` means green (`npm run check` + `npm run build`) and documented.
> Nothing here is committed — the owner commits. Delete this whole section once the batch is over
> and its results are folded into the sections below.

- `DONE` §HABITS → plan in one click (`POST /planned/from-habit`, buttons in `Habits.tsx`,
  exclusion of already-answered merchants, 4 tests). §HABITS card removed from the queue.
- `DONE` §GOAL-PACE — server-computed on-track/behind + progress chart (`GoalProgress.tsx`,
  `worker/test/goals.test.ts`, 10 tests). Documented in `CLAUDE.md` and `DESIGN.md`.
- `DONE` demo tally: signed-in visitors are no longer counted (`worker/index.ts`), 6 tests in
  `worker/test/demo-tally.test.ts`, new `migratedDirectoryDb()` harness.
- `DONE` `STYLES.md` written — measured state, rejected options, 8 phases.
- `DONE` reports, step 1 — **a failed scheduled step is now announced in the feed.**
  `announceCronFailures` (`notify.ts`) + a `cron_failed` template (`shared/notif-i18n.ts`) +
  the call at the end of `UserDO.runCron`. Deduped per step per Kyiv day; not mutable by
  preferences (it reports that the PRODUCT failed, not an opinion about the data).
- `DONE` reports, step 3 — **`already_covered` capped 24 → 12**, and the prompt now separates
  novelty from length ("novelty governs WHAT you write, never HOW MUCH"). This is the suspected
  cause of "reports have gone small"; it is a hypothesis, and the NEXT weekly report is the test.
- `DONE` reports, step 2 — each report now stores `_diag` in its `data_json` (sections / advice /
  anomalies / suppressed-topic count / chars / output tokens). No migration: it is diagnostic
  metadata nothing queries. **`suppressed` high + `sections` low = §NOVELTY is the cause**, which
  is the hypothesis above made checkable.
- `DONE` `report.ts` no longer needs a C3 exception — prompt + model call extracted to
  `lib/ai/report-prompt.ts` (349 lines, under the default 400 cap; the exception line was deleted).
- `NOT A TASK` bulk actions on transactions **already exist in full** — `POST /transactions/bulk`,
  selection mode and the action bar in `Transactions.tsx` (group / category / transfer / tag /
  importance). My card proposed work that was already done; card removed.
- `PARTLY EXISTS` the category page: `/analytics/category` and a drill panel inside
  `StatsCategories.tsx` already answer most of it. What is genuinely missing is a PERMALINK page
  and entry points from the budget card and the category list — the card was rewritten to say so.
- `DONE` **§BUDGET-FORECAST** — `budgetStatus` moved to its own `lib/finance/budgets.ts` (forced
  by C3), gained `projected`/`projected_ratio`/`lumpy`; new `GET /budgets/status` + golden;
  `EnvelopeGrid` now RENDERS the canon instead of deriving its own spent-vs-limit;
  `budget_forecast` feed event (`drafts-budget.ts`, split out of `notify.ts` under C3).
  Documented in `CLAUDE.md`.
- `DONE` **STYLES phase 0** — 76 byte-identical dead CSS blocks removed (4 258 → 4 182 lines),
  proved safe by comparing every selector's ordered distinct bodies before/after (the check
  ABORTED a broader first attempt that would have changed `.wd-col`). Details and what stayed:
  `STYLES.md` §2.4.1.
- `DONE` **§RULES-UI** — `rules` (categorize step 4) is writable from the app at last: `repo/rules.ts`,
  `routes/api/rules.ts` (CRUD + preview + apply-to-uncategorised), `RulesCard` on the Categories
  page, 6 write scenarios. Documented in `CLAUDE.md`.
- **VERIFIED AGAINST THE CODE before touching anything** (the correction the owner asked for):
  · `[нове] Розстрочка як окрема сутність` — **ALREADY EXISTS** in full (`kind: "installment"`,
    `total_amount`, `occurrences`, `end_date`, progress on the Subscriptions page). Idea removed.
  · `[нове] Правила-автотеги в UI` — genuinely missing → BUILT (above).
  · `[нове] Пасткод/біометрія` — genuinely missing (no match anywhere in `src`/`worker`).
  · `[тех] Audit-лог AI-змін` — genuinely missing (no table, no endpoint).
  · `[лвл-ап] Вплив курсу окремою цифрою` — missing, but `rate_history` (migration 0024) has about
    one month of data. The idea's own note says it needs several months. Premature; left alone.
  · `[нове] Розумні цілі-виклики` — genuinely missing (no `challenge` anywhere).
- `DONE` **§TX-CHAT** (migration 0040) — the conversation about a transaction is stored instead of
  living in `useState`: `chats.kind`/`entity_id`, `appendTxTurn`/`txMessages`, per-kind pruning,
  `GET /transactions/:id/chat`, history loaded on the detail page. 3 write scenarios; the 3 existing
  chat goldens were re-recorded (diff is EXACTLY the two new columns, `advisor`/`null`).
- `DONE` **§AI-AUDIT** (migration 0041) — `ai_changes` records every field the model rewrites with
  the value it rewrote away from; `AiChangeLog` on the transaction page undoes it in one click.
  Logged only on a REAL change, marked rather than deleted on undo, best-effort so it can never
  swallow the change it describes. `GET /transactions/:id/ai-changes`, `POST /ai-changes/:id/revert`,
  4 write scenarios. `chatAboutTx` moved to `lib/ai/tx-chat.ts` (C3).
- `DONE` **FIX: rule matching — engine and preview now search the SAME text.** Found by re-reading
  what I had just shipped: the preview searched the current `merchant` (which enrichment rewrites
  to a clean name) while `categorize()` searched the raw bank description, so a rule written
  against the screen would never fire. One `textHaystack` mirrored in SQL, `comment` added to both
  (a P2P description is just a name). 2 regression scenarios.
- `DONE` **§AI-AUDIT wide view** — `GET /ai-changes` had no consumer; `AiActivityCard` in
  Settings → AI now shows what the model changed lately, each row linking to its operation.
- `DONE` **§LOCK** — local passcode (`lib/lock.ts`, `LockScreen`, `LockCard`). Honest in the UI
  about being a privacy screen and not security; never in demo; survives logout like the theme.
### Overnight batch, 2026-08-12 — **FINISHED**, green (349 tests, check + build)
> All four planned items are done. Nothing is committed: the tree carries the work, which survives
> an interruption on its own. What is left needs the owner's eye and is named at the bottom.
- `DONE` **A. §CATEGORY-PAGE** `/categories/:id` — `GET /categories/:id/overview` (canonical monthly
  level, 12-month trend, envelope, recurring/one-off), `src/pages/Category.tsx`, entry points from
  the envelope tile and the category list, 2 goldens.
  ⚠️ Fixed while building it: the endpoint defaulted to a rolling 30 days while `budgetStatus` is
  month-to-date, so its two halves described different periods. Now both are month-to-date and the
  golden proves they agree to the kopeck (287600 = 287600).
- `DONE` **B. Statistics verified.** New `worker/test/consistency.test.ts` asserts RELATIONSHIPS,
  not values — the claim "one canon, so every screen agrees" made testable. All identities already
  held: categories / accounts / importance each add up EXACTLY to the period total; the envelope,
  the Stats donut and the new category page agree to the kopeck; safe-to-spend is its own
  arithmetic; the last point of the 6-month trend IS the month preset.
  ⚠️ One apparent discrepancy investigated and found CORRECT: `byMerchant` sums higher than the
  total because it is a top-10 and a §REFUND carries a NEGATIVE spend that sorts last, so it falls
  outside. Documented in the test rather than "fixed".
  ⚠️ Checked before building: a savings-rate TREND already exists in `MonthlyHistory` — no
  duplicate built.
- `DONE` **C. STYLES — the file is split** into nine parts under `src/styles/`, `index.css` is
  imports only, and the concatenation was proved **byte-identical** to what shipped before writing
  anything to disk. New lint **C8** (`scripts/check-styles.mjs`) keeps it split. Build emits one
  CSS asset, zero `@import` left.
  ⚠️ NOT done and needing the owner's eye: phase 0.5 (8 conflicting duplicates — collapsing them
  changes rendering) and phase 4 (true domain grouping — it moves rules across cascade boundaries).
  `@layer` was deliberately skipped for the same reason.
- Nothing is committed unless asked; the tree survives an interruption on its own.
- `DONE` **D. §IMPORTANCE-TREND** — the spending MIX per month (essential / discretionary /
  optional) added to `/analytics/monthly-history` and drawn as a 100%-stacked strip under the
  savings rate. The genuinely missing statistic: the period tabs say what share of THIS month was
  optional, nothing said whether that share is climbing.
  ⚠️ A real bug caught by the tests while building it: `GROUP BY importance` is AMBIGUOUS (the
  joined `categories` rows carry their own column) and SQLite refused the statement — a 500 the
  golden alone would not have explained. Grouped by the expression instead.
  ⚠️ Checked first: a savings-rate trend already existed, so none was rebuilt.
- `TODO` smart goal challenges; STYLES phase 0.5 + 4 (both need the owner's eye — see STYLES.md).
- ⚠️ **`worker/lib/ai/report.ts` is at its C3 ceiling (450).** Adding anything to it now requires
  an extraction first — the obvious seam is the system prompt + `generateFinancialReport` into
  their own module, leaving context assembly and storage behind.

## 🔥 Черга (роби згори вниз)

### 1. Scheduled work that fails must SAY SO (reports)

**Reported by the owner:** "reports have gone small, and there is no report for last week."

**What the code actually shows** (read 2026-08-12; production logs were not available, so this is
what can be established from the source alone):

- **The missing report is a VISIBILITY bug, and it is certain.** In `UserDO.runCron`, every step
  goes through `step(name, fn)`, which catches and pushes into `failed`. The Worker then does
  `console.error(...)` — and that is the entire consequence. A weekly report that throws (model
  error, rate limit, expired key, a 502 from the API) leaves **no trace the owner can see**: no
  feed entry, no row, nothing on the Reports page. "There is no report for last week" and "the
  generation failed last Monday" are the same observation, and the app currently cannot tell them
  apart. The whole branch is also gated on `if (env.ANTHROPIC_API_KEY)`, which skips silently.
- **"Reports have gone small" — prime suspect is §NOVELTY, not the token limit.** `max_tokens` is
  8000 and `callHaikuJson` retries a truncated answer; the validator already demands
  `sections >= 2`, `advice >= 3` and `predictions`, so a structurally thin report would be caught.
  What is NOT bounded is `already_covered`: up to **24** headlines / anomaly labels / advice titles
  from the last three reports, with the prompt forbidding them as news. After several similar
  weeks that list covers most of what is true about the spending, and the model complies by saying
  less. Unverified — see the step below.

**Steps:**
1. A failed scheduled step becomes a feed event (`notify.ts`, kind `todo` or a new `job_failed`),
   with the step name and the error. ⚠️ Must be deduped per day, or a persistently broken key
   turns into a daily alarm.
2. `generateAndStoreReport` records WHY a report is thin: store `stop`, `capped`, and the section /
   advice counts alongside the report, so "small" is diagnosable instead of arguable.
3. Only then decide about `already_covered`: probably cap it to the last ONE report rather than
   three, and never let it suppress the deterministic sections we compute ourselves.

**Done when:** a scheduled report that fails is visible in the app the same day, and a thin report
carries the evidence of why it is thin.

### 2. A category page with a permalink (`/categories/:id`)

⚠️ **Scope corrected 2026-08-12 after reading the code.** Most of this already exists: the endpoint
`GET /analytics/category` returns sub-categories, merchants and transactions, and
`StatsCategories.tsx` renders a drill panel from it. So this is NOT "build a category view".

**What is actually missing:**
- a **permalink** — the drill lives inside a Stats tab and cannot be linked, bookmarked or reached
  from anywhere else;
- **entry points**: the envelope card (`EnvelopeGrid` → this category) and the category list;
- the blocks the drill panel does not carry: the monthly level and its trend
  (`categoryMonthlyLevels`), budget state (`budgetStatus` — now available as `GET /budgets/status`),
  one-off vs recurring (`recurringOneoffSplit`).

**Files:** `src/pages/Category.tsx` (new) + route, reusing `useGetCategoryDrillQuery`.
**Done when:** a category is linkable, and the envelope and the category list link to it.

### 3. Splitting the stylesheet — phases 0-3 (`STYLES.md`)

**Goal:** remove the duplicates, introduce `@layer`, extract `tokens`/`base`/`layout`/`ui` as
separate files.
**The problem and the full plan are in `STYLES.md`.** Measured: 4 237 lines; `.cat-` rules spread
across 3 230 lines; 94 `@media` blocks throughout the file; **76 byte-identical duplicated blocks**
(`.hb-row` exists five times, `.wd-col` six) and **8 selectors that quietly conflict** — what
renders is their MERGE, which nobody wrote. That is exactly why editing an upper copy changes
nothing on screen.
Tailwind / Sass / CSS Modules were considered and rejected — reasons are in the same document.
**Done when:** phases 0-3 are closed, with NO visual change, and `npm run check` + `npm run build`
are green. ⚠️ Phase 0.5 (the 8 conflicts) and phase 4 (the domains) need LIVE verification by the
owner — they cannot be done blind.

*(Closed 2026-08-12: the "two writers of `facts`" debt — `addFact` is the only writer and the
differing defaults became its `source`/`confirm` arguments; held by 6 scenarios in
`writes.test.ts`. And §HABITS became actionable — a found recurring charge turns into a plan in one
click, or is dismissed; §GOAL-PACE gave goals a server-computed on-track/behind status and a
progress chart.)*

*(Безпека: прохід по периметру ✅ 2026-08-07 — `CLAUDE.md §Безпека`. `gitleaks` по всій історії
власник прогнав, чисто. Квота на чеки ✅ `lib/platform/quota.ts`. Рішення власника закриті
2026-08-03: історію git не переписуємо, `database_id` лишається в `wrangler.jsonc`.)*

---

## 📌 Беклог (з відомим корінням, без дати)

### Фічі, відкладені свідомо

**Банки — стан на 2026-08-13 (деталі в `BANKS.md`)**
- ✅ Кроки 1–7 із `BANKS.md §5` закриті: один писар транзакцій, спільна нормалізація (+ виправлено
  §APP_TZ на імпорті), цикл вибірки й пейсинг від провайдера, `bank_connections` із читачем,
  резолвер креденшелів, полінг у alarm, і сам провайдер ПриватБанку.
- ⬜ **Приват НЕ перевірений на живому API** — немає ФОП-рахунку й немає пісочниці. Перевірено лише
  мапінг (17 сценаріїв). Перший живий прогін, найімовірніше, потребує одного раунду правок:
  параметр `ID` (груповий режим) і точні назви полів балансу.
- ⬜ **Рішення ДО першого синку Привату:** ФОП-рахунок — це оборот, а не твої гроші, а
  `accounts.role` знає лише `liquid|investment`. Без третього значення перший синк зрушить
  подушку, runway і burn (`BANKS.md §2.2`).
- ⬜ **Відкликання операції.** Рядок, збережений як `p` (в обробці), який потім став сторнованим,
  лишається збереженим: у канону немає стану «скасовано». Робити з живим рахунком, не наосліп.
- ⬜ **Райффайзен: провайдера писати НЕ треба** (`BANKS.md §5.2`). Персональні рахунки —
  тільки експорт із MyRaif (PDF/CSV/XLS), тобто наявний CSV-імпорт. Лишилось одне:
  **прогнати реальний експорт MyRaif через превʼю** й дописати підказки колонок у `HINTS`
  (`providers/csv.ts`), якщо гадалка їх не вгадає. Потрібен файл, не рішення.

**P2.1 — Goals level-up, what is left** *(contribution history, auto-top-up, goal kinds, the pace
status and the progress chart are done; §GOAL-PACE in `CLAUDE.md`)*
- ⬜ The two P2.3 tails: linking an event to a goal, and an AI close-out over the plan's numbers
  (a one-line extension of `/events/:id/ai`, `context += planned_total`).
- ⬜ **A chart for a JAR-backed goal.** Today the chart is drawn only for a manual goal, because it
  grows out of `goal_contributions` — and a jar has none by definition (its progress IS the account
  balance). A source exists (`account_balance_history`), but that is a DIFFERENT storage of the same
  idea, so before drawing anything we have to decide whether to fold them into one series on the
  server or keep two paths.
- *(Round-up лишився поза межами: він потребує гачка на КОЖНІЙ транзакції, а не місячного проходу —
  це інша механіка, не варіант того самого поля.)*

**TG-бот — вхідні команди для НЕ-власника**
Вихідні пуші вже персональні (§D1). Лишились вхідні команди (`/balance`, `/last`, запис витрати
текстом/фото): щоб роутити їх за чатом, потрібен індекс `chat_id → user_id` у спільній directory —
інакше воркер не знає, чий обʼєкт будити на команду з довільного чату. Вихідним пушам індекс не
потрібен: обʼєкт знає свій `chat_id` сам.

**Мультипровайдерний AI** *(відкладено 2026-07-26, «колись потім»)*
Дати юзеру вибір Anthropic / OpenAI / Grok. **Не «на ізі»:** розходяться tool-use
(`runToolConversation` написаний під блоки Anthropic), prompt-кеш (`cache_control ttl:1h` — на
ньому тримається економіка корпусу §A5), серверний `web_search` і таблиці цін `priceFor`.
**Дешевий шлях:** адаптер лише для одноходових викликів (enrich/OCR/parse/insight), агентний чат
лишити на Anthropic; Grok і DeepSeek дають OpenAI-сумісний ендпоінт — один адаптер відкриває кількох.
Шов уже прорізано: `worker/lib/ai/json.ts`, усе вище нього провайдер-агностичне.
⚠️ Зачепить `demoClamp` — він знає лише моделі Anthropic; чужий провайдер у демо має бути або так
само затиснутий, або заборонений.
**Готово-коли:** ключ будь-якого підтримуваного провайдера дає робочу категоризацію, а UI чесно
каже, які фічі доступні для цього провайдера.

**Хвости AI 4.0** *(фаза закрита, ТЗ — `HISTORY.md`)*
- Юзер-аплоад власних PDF/MD у корпус знань (R2 + D1). Зараз лише .md/.txt через читання на клієнті.
- Нативний PDF `document`-блок (100 стор Haiku / 600 Sonnet) + `citations`.
- `output_config.format` (structured outputs) замість хака `repairTruncatedJson`.

### Архітектурне / потребує рішення
- **Масові прогони в чергу задач.** §A6 (`ai_jobs` + alarm-планувальник) покрив одиничні задачі;
  ре-світ і батч-enrich не заводили — у них інша природа, прогрес у %, а не «готово».
- **Lazy-enrich** (варіант B) — за узгодженням.
- **Мульти-валютні групи/подорожі** — лишився TG-бот (аналітика й групи вже зведені в ₴).
- **Prompt-кеш verify** на проді (`cache_read` у логах) — потребує деплою.
- **Тексти помилок віддають сиру причину** (свідоме рішення §Обробка помилок). Якщо зʼявляться
  сторонні юзери поза колом друзів — сховати `detail` за owner-прапорцем.

---

## 🎨 Дизайн — майбутнє
> Як працювати — `DESIGN.md §10` (skills: `impeccable` основний, `review-animations` для руху).
> Кожну зміну фіксувати в «Журналі рішень» DESIGN.md.
- **Статистика** — редизайн вкладок **Огляд + Категорії/Тренди**. Потрібен live-скрін вкладок.
- **Сторінки ще не переглянуті вживу:** Порадник, Підписки, Бюджети, Рахунки, Категорії.
  Чек-лист: локальний хардкод-колір / тінь / `transition:all` / тіснота.
- **Розмітка для >1920px** — як стоять блоки на широких моніторах.
- **Справжній скрін продукту в hero лендінгу:** `.lp-flow` — свідомо зроблений слот під реальний
  знімок, зараз там мальована схема. Знімки вже є в `docs/screenshots/`.

---

## 💡 Ідеї фіч — брейнсторм для тріажу
> Сирий список для пріоритезації. **[нове]** / **[лвл-ап]** / **[тех]**; розмір S/M/L — груба оцінка.
> Реалізоване звідси видаляється (не викреслюється).

### A. ФОП / податки (на паузі — рішення користувача)
- **[нове] Податковий конверт-автовідкладання (S/M).** З кожного доходу відкладати % (ЄП 5% + ЄСВ + ВЗ)
  у віртуальний конверт → видно, скільки з балансу насправді «не твоє».
- **[нове] Податковий календар ФОП (M).** Дедлайни ЄП/ЄСВ/ВЗ із сумами, відлік, нагадування;
  «сплачено» → списання з конверта.
- **[нове] Трекер річного ліміту доходу ФОП (S).** Прогрес-бар до ліміту групи + прогноз перевищення.
- **[нове] Розрахунок ЄП за квартал (S).** Дохід × ставка; валютний дохід — за курсом НБУ на дату.
- **[нове] Валютний дохід ФОП — курс НБУ на дату (M).** Для USD/EUR-інвойсів фіксувати офіційний
  курс дня зарахування.
- **[лвл-ап] Позначка «робочі витрати» (S).** Тег бізнес/особисте → окремий підсумок.

### C. Порадник / AI / автоматизація
- **[нове] Розумні цілі-виклики (S).** AI пропонує реалістичний виклик («−15% на доставку =
  +1200 ₴») і трекає.

### E. Транзакції / введення / категоризація

### F. Сповіщення / проактивність
- **[лвл-ап] Достроїти TG-бота (M).** Див. картку в беклозі — потрібен індекс `chat_id → user_id`.

### G. Валюти / інвестиції / нетворт
- **[лвл-ап] Вплив курсу окремою цифрою (S).** Базу зроблено (`rate_history` 0024, нетворт рахує
  кожну точку курсом своєї дати). Лишилось розділити зміну нетворту на «рух грошей» і «рух курсу».
  Має сенс, коли історія накопичиться за кілька місяців.

### H. UX / продуктивність / пошук
- **[лвл-ап] Плавність дашборду (S).** Дотягнути наявні анімації, прибрати ривки.

### I. Дані / надійність / приватність
