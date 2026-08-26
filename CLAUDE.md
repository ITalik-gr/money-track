# CLAUDE.md — Money Track (головний довідник проєкту)

> **Цей файл = єдина точка входу.** Claude Code вантажить його автоматично щосесії.
> Тут — усе глобальне, що треба знати ЗАВЖДИ: стек, інваріанти, як працює статистика,
> категоризація, AI-модель, ops. Історія «раунд-за-раундом» тут НЕ живе (вона в git/пам'яті).
> Оновлено 2026-08-22. Стан: **у проді**, платформа-фаза закрита, **структурний рефактор
> (ARCH, фази 0–5) закритий**, стилі розділені на шістнадцять файлів (лінти C8/C9),
> **реєстрація ВІДКРИТА** і тільки через Google; Telegram — ДРУГИЙ ключ до наявного акаунта
> (§TG-MINIAPP), не спосіб його створити.
> Міграції: `finance` до **0045**, `directory` до **0010**. Тестів — **748**.
> Черга — `ROADMAP.md`, архів — `HISTORY.md`.

## 📁 Система документів (як усе влаштовано)
- **`CLAUDE.md`** (цей файл) — durable-довідник. Глобальні налаштування, інваріанти, «як усе працює зараз». Сюди **виписуй важливе, коли доробив фічу** (див. робочий процес).
- **`DESIGN.md`** — дизайн-система (живий документ). **Читай ПЕРШИМ перед будь-якою роботою над UI/UX.** Токени, патерни, референси, «Журнал рішень». Код токенів — `src/styles/tokens.css`.
- **`STYLES.md`** — the client's style architecture. The single 4 237-line `src/index.css` is GONE:
  it is thirteen files under `src/styles/`, `index.css` is imports only, and lint **C8** keeps it that
  way. What the document still carries is why Tailwind / Sass / CSS Modules were rejected, and the
  two phases left (0.5 — eight quietly conflicting selectors; 4 — true domain grouping), both of
  which change rendering and need a live eye. Read it before any structural CSS work. **How things
  should LOOK is not here — that is `DESIGN.md`.**
- **`BANKS.md`** — the bank edge: what PrivatBank actually offers (no personal-card API since 2023;
  AutoClient reaches the ФОП account; open banking needs an NBU licence), what its data shape breaks
  in our canon, and which parts of `BankProvider` are still declarations with no caller. **Read it
  before writing any bank integration** — including the third one.
- **`ROADMAP.md`** — жива черга задач/фіч. **Тільки невиконане**; доробив — видаляй картку.
- **`ARCHITECTURE.md`** — шари (`routes → services → lib → repo`), лінти C1–C10 і те, що свідомо
  НЕ робимо. Читай перед структурною зміною або перед новим лінтом.
- **`SECURITY.md`** / **`CONTRIBUTING.md`** — публічні (англійською): канал репорту + свідомо
  прийняті межі; green-бар і 5 непорушних правил із ціною кожного.
- **`README.md`** — публічне обличчя проєкту (англійською, для рекрутера).
- **`HISTORY.md`** — **архів, НЕ читати за замовчуванням** (у `.gitignore`, ніколи не публікувався).
  Журнал зробленого, ТЗ закритих фаз (AI 4.0, платформа-фаза, ARCH) і колишні окремі файли.
  Відкривати лише коли треба з'ясувати «чому саме так», і цього файлу не вистачило.
- **`AGENTS.md`** — конвенція для НЕ-Claude агентів (Codex/Cursor); для Claude Code це дубль хука.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).


### 🔁 Робочий процес (тримати завжди)
1. **UI/UX** → спершу `DESIGN.md`, потім код. Кожну дизайн-зміну фіксуй у «Журналі рішень» DESIGN.md.
2. **Нова задача/ідея/баг** → одразу в `ROADMAP.md` (щоб не загубити).
2а. **Новий файл** → у наявну доменну папку (§Мапа коду). Плоских списків більше немає;
   якщо файл «нікуди не лягає» — це сигнал, що домен не продуманий, а не привід класти в корінь.
   **Новий ресурс, спільний для всіх юзерів** (секрет, чат, бакет) → одразу гейт `env.IS_OWNER`
   (§Безпека — на цьому вже двічі спіймались).
3. **Доробив задачу** → (а) видали пункт з `ROADMAP.md`; (б) якщо це змінює «як усе працює» (новий інваріант, нове канонічне визначення, новий ops-крок) — онови відповідний розділ `CLAUDE.md`.
4. **Гроші/статистика** → будь-яка нова аналітика рахується ТІЛЬКИ через `worker/lib/finance/stats.ts` (єдине джерело). Не дублюй SQL-фільтри в ендпоінтах.
5. **Green-бар перед «готово»:** `npm run check` (tsc app+worker **+ SQL-лінт + тести канону**) + `npm run build`. Канонічний SQL — валідуй на D1.
   `npm run check` = `tsc -b` + `scripts/check-stats-sql.mjs` + `scripts/check-i18n.mjs` + `scripts/check-repo-layer.mjs` (C1: `.prepare()` лише в `repo/` — з 2026-08-08 ПОВНА заборона, бюджет порожній) + `scripts/check-route-size.mjs` (C3: ≤400 рядків на файл у `routes/`+`services/`) + `scripts/check-route-order.mjs` (C7: літерал не нижче параметризованого роута, що його перекриває; один префікс — один файл) + `scripts/check-api-contract.mjs` (C2/C4: форма відповіді оголошена ОДИН раз, у `shared/api/`) + `scripts/check-styles.mjs` (C8: `src/index.css` — лише `@import`, кожна частина імпортована, стеля рядків на частину) + `scripts/check-styles-used.mjs` (C9: кожен `className` має правило, кожне правило має `className`) + `scripts/check-currency.mjs` (C10: `getStoredRates` лише у `money.ts`; жодного літерала `₴` у воркері — виняток для Telegram ЗНЯТО 2026-08-21 — §BASE-CUR) + `scripts/gen-migrations.mjs --check` + `npm test`.
   Остання (2026-07-24, платформа-фаза) падає, якщо `migrations/*.sql` змінились, а ембед для
   Durable Object (`worker/do/migrations.generated.ts`) не перегенеровано — інакше нова міграція
   мовчки не доїхала б у БД юзера. Перегенерувати: `node scripts/gen-migrations.mjs`.
   ⚠️ **Локально перевіряти лише через `npm run dev` (Vite).** `wrangler dev` бере застарілий
   redirected-конфіг зі `dist/money_track/wrangler.json` і не бачить нових біндів — виглядає
   як «роут не зареєструвався» (SPA-фолбек замість JSON).
   ⚠️ **`assets.run_worker_first` — новий роут воркера поза `/api/*` МУСИТЬ бути в цьому списку**
   (`wrangler.jsonc`). При `not_found_handling: "single-page-application"` роутер статики Cloudflare
   відповідає на **навігаційні** GET (браузерні, `Accept: text/html`) сам і воркер не будить —
   тому `<a href="/demo">` і `<a href="/auth/google/start">` мовчки віддавали `index.html`, а
   React Router малював свій «404 Not Found». **Симптом оманливий:** `fetch`-виклики (`POST
   /api/login`) працюють, тож це читається як «зламався Google», а не «статика перекрила воркер».
   Перевірка — `curl -H 'Accept: text/html' <url>/роут`: має бути 302/JSON, а не HTML.
   `scripts/check-stats-sql.mjs`: запит, що згадує канонічний хелпер
   (`amountSum`/`SPEND_WHERE`/`EFF_*`…), МУСИТЬ мати `STATS_JOINS` — інакше падає в рантаймі
   (`no such column: sp.amount`), а `tsc` цього не бачить (SQL = рядок). Див. §Обробка помилок.
6. **Деплой/жива перевірка — рутина КОРИСТУВАЧА** (див. §Ops). Секрети й реальний API-ключ — не в мене.
7. **Код читатиме сторонній інженер** (проєкт стає публічним портфоліо — `HISTORY.md`).
   Звідси конвенції, що діють ВІДРАЗУ (повністю — `HISTORY.md`):
   - 🔴 **ENGLISH IS THE WRITING LANGUAGE OF THIS REPOSITORY** (2026-08-04, restated 2026-08-07).
     Everything newly written goes in English: code comments, **and every `.md` addition — a new
     section, a new ROADMAP card, a new DESIGN journal row — even inside a document that is
     otherwise Ukrainian.** The rule is about what you WRITE, not about what the file already
     contains; the earlier reading ("this file is Ukrainian, so I write Ukrainian in it") was
     wrong and is the exact thing this line now forbids.
     Existing Ukrainian prose is NOT translated en masse (there are thousands of lines and they
     carry the "why it is like this") — it migrates when that text is rewritten for another
     reason, so these documents stay mixed for a while. That is the accepted transitional state.
     **Never translated** (data, not prose): UI strings — they go through `t()` · matching keys
     (`.includes("фоп")`, `/переказ|зняття/i`) · seeded category names · merchant examples inside
     prompts.
     ⚠️ **Model prompts moved OFF this list on 2026-08-08 — they are now English** (§LANG-ARCH).
     They were exempt on the grounds that maintaining two copies is not worth it; writing them once
     in English is still one copy, and it is what actually stopped the answers coming back in the
     wrong language.
     ⚠️ Chat replies to the owner stay Ukrainian — this rule covers artifacts committed to the
     repo, never the conversation.
   - Коментувати **«чому саме так»**, а не «що робить рядок»: яку альтернативу відкинуто, який баг
     це закриває, який інваріант тримається. Обовʼязково — біля канону (`stats.ts`, `EFF_AMOUNT`,
     `SPEND_WHERE`), біля обходів чужих вад (кирилиця в `LIKE`, специфічність `.modal`) і біля
     кожної перевірки, що існує через невдачу (`numbersAreGrounded`, SQL-лінт).
   - **Шари:** `routes/*` — транспорт і валідація; `services/*` — сценарії (послідовності);
     `lib/*` — логіка й канон; `repo/*` — ЄДИНЕ місце, де є SQL. Жодного SQL у компонентах.
   - **Перевірка > інструкція.** Якщо коректність тримається на памʼяті розробника або моделі —
     зробити детерміновану перевірку. Це правило вже двічі окупилось: SQL-лінт (регресія §SPLIT)
     і `numbersAreGrounded` (вигадані суми в AI-сповіщеннях).

## Стек
PWA на одному **Cloudflare Worker (Hono) + D1 + R2**. Monobank (webhook + бекфіл). React 19 + Redux Toolkit + React Router 7 + Recharts, Vite + vite-plugin-pwa, `@cloudflare/vite-plugin`. AI = гібрид **Haiku 4.5** (масово: enrich/OCR/parse/insight/batch) / **Sonnet 5** (розумний user-facing: порадник, репорти, txChat, бюджет-план, рев'ю). **Виняток (2026-07-14):** enrich бере Sonnet, коли користувач САМ описав операцію нотаткою (`user_note` непорожній) — розпізнання поважає пояснення (не плутає «вивів зарплату» з «Подарунком»); авто-enrich без нотатки лишається на Haiku. Telegram-бот (каркас). Мова UI — українська. Шрифти: Geist Sans (герой-суми) / Geist Mono (колонки, `tabular-nums`).

### Скрипти
`npm run dev` · `npm run build` (types + tsc -b + vite build) · `npm run check` (types + tsc + лінти + тести) · `npm run deploy` (build + wrangler deploy) · `npm run db:migrate:local` / `:remote` · `npm run db:seed:local`.

⚠️ **`worker-configuration.d.ts` ГЕНЕРУЄТЬСЯ, і генерація стоїть ПЕРШИМ кроком `build`/`check`**
(2026-08-07). Файл у `.gitignore`, тож на CI (Cloudflare Build) його просто немає — збірка падала
`TS2688: Cannot find type definition file`, хоч локально все зелене. Коміт файлу теж вирішив би
проблему, але 549 КБ згенерованого, що мовчки старіє відносно `wrangler.jsonc`, — гірший розмін:
локальна копія була від 24 липня й НЕ знала про `vars.SIGNUP`, доданий 31-го.
⚠️ **`wrangler types` виводить ЛІТЕРАЛ поточного значення vars** (`SIGNUP: "open"`), бо описує те,
що задеплоєно. Тому `env.ts` виключає `SIGNUP` з успадкованого типу (`Omit<Cloudflare.Env, "DB" |
"SIGNUP">`) і оголошує ширше — інакше кіл-світч `open|invite` неможливо було б перемкнути без
помилки компіляції. **Нова змінна у `vars` + її оголошення в `env.ts` = той самий конфлікт**;
рішення — Omit із коментарем ЧОМУ, а не `--strict-vars=false` (той прибирає літерали в усіх vars).

### Мапа коду (структура за доменами, 2026-07-26)
> Було: `worker/lib/` (29 файлів) і `src/components/` (59) плоскими списками — знайти щось можна
> було лише пошуком, а межі відповідальності не читались із дерева. Тепер папка = домен.
> **Правило: новий файл кладеться в наявну доменну папку; нова папка — лише під новий домен.**

**Воркер**
- `worker/index.ts` — Hono: авторизація, заголовки безпеки, роутинг у Durable Object, крон.
- `worker/user-app.ts` — застосунок ВСЕРЕДИНІ DO; `worker/do/*` — сам `UserDO`, міграції, імпорт.
- `worker/routes/*` — транспорт і валідація: `setup`, `credentials`, `admin`, `auth`,
  `webhook`, `telegram`, `ingest`, `import`, `account`.
  **`worker/routes/api/`** (2026-08-07) — 18 доменних файлів, ФАЙЛ = ПЕРШИЙ СЕГМЕНТ ШЛЯХУ
  (`transactions.ts` тримає весь `/transactions/*`, зокрема `POST /transactions/:id/enrich`, хоч
  за змістом це enrich). Один файл володіє цілим префіксом → правило «літерал вище
  параметризованого» видно в одному файлі, а не в порядку монтування. `index.ts` — лише мідлвар
  локалі + `api.route("/", …)`; **власних роутів не оголошує ніколи** (файл, який приймає ще один
  обробник, набере й наступний — так і виріс `api.ts` до 3331 рядка). Ліміт — 400 рядків на файл
  (лінт C3).
- `worker/services/*` — СЦЕНАРІЇ: обробники, що є послідовністю кроків над кількома таблицями
  (`transactions.editTransaction`, `reimbursements.setReimbursement`, `categories.deleteCategory`).
  Сервіс бере вже розпарсений вхід і повертає РЕЗУЛЬТАТ: не читає запит, не обирає код статусу,
  не будує рядок для людини — помилку він НАЗИВАЄ (`errReimbCurrency`), а словами її оформлює
  роут через `st(locale)`. Простий CRUD сюди не їде: сервіс на кожну таблицю — це церемонія.
- `worker/repo/*` — ЄДИНИЙ шар, що пише SQL (лінт C1; `services/` теж під забороною, без бюджету).
- `worker/lib/finance/` — **гроші й канон**: `stats.ts` (ЄДИНЕ джерело розрахунків),
  **`time.ts`** (§APP_TZ — увесь календар; `stats.ts` ре-експортує), `finance`
  (+ `savingsRatePct`), `cadence` (§CADENCE — чи дельта осмислена + злиття двох періодів),
  `fx` (§FX-COST), `forecast`, `price-drift`,
  **`money.ts`** (§BASE-CUR: rates, conversion, and WHICH currency the answer is in — the only
  module allowed to read the raw rate table), `subscriptions`, `transfers`, `categorize`,
  `categories-i18n`, `repo`, `merchants`.
- `worker/lib/ai/` — усе модельне, ШАРАМИ (2026-08-07, було 1335 рядків в одному `ai.ts`):
  `ai.ts` — ЛИШЕ транспорт (єдиний файл, що POST-ить в Anthropic) · `models.ts` — яка модель на
  яку задачу · `cost.ts` — скільки коштував виклик і лічильник · **`json.ts` — ШОВ ПРОВАЙДЕРА**
  (усе вище нього провайдер-агностичне) · `prompt.ts` — стабільний префікс + мовна директива ·
  `tasks.ts` — розмовні виклики без власного фіча-файлу · `advisor`, `enrich`, `insight`,
  `report`, `receipt` — фіча-логіка ЖИВЕ ТУТ, а не в транспорті · **`generate.ts`** — одноразові
  генерації (порада, план бюджетів, спостереження стрічки, вердикт групи): payload → структурований
  JSON, ніхто не читає наживо, тому вивід перевіряється кодом · **`chat-tools.ts`** — інструменти,
  якими модель сама читає базу (схема + виконавець поруч, щоб розбіжність було видно) ·
  `facts.ts` — §A1 CRUD фактів і ЄДИНИЙ писар таблиці `facts` (§A1-WRITE)
  (винесено з `advisor.ts` 2026-08-07: чистий CRUD без логіки поради, і без цього виносу
  `chat-tools`↔`advisor` замкнули б цикл імпортів) · `knowledge/` (корпус).
  ⚠️ **Новий AI-виклик кладеться у ФІЧА-файл, а не в `ai.ts`.** Саме так `generateFinancialReport`
  опинився в транспорті, хоч поруч лежав 330-рядковий `report.ts`: правила не було — і фіча
  розмазалась по двох файлах, а наступний дописував у той, який був відкритий.
- `worker/lib/platform/` — мультиюзерність: `auth`, `directory`, `secrets`, `demo`, `forward`,
  `cron`, `db-shim`, `quota` (добові стелі на РЕАЛЬНОГО юзера; `demo.ts` — стелі на незнайомців),
  `feedback` (відгуки + щоденний лічильник демо — обидва в СПІЛЬНІЙ directory, тому не в `repo/`).
- `worker/lib/bank/` — `mono`, `backfill`, `providers/` (реєстр банків).
- `worker/lib/messaging/` — вихідні сигнали: `notify` (центр сповіщень), `telegram`, `alert`,
  `proactive`.

**Клієнт**
- `src/pages/*` — по сторінці на роут (плоско: файл = роут, групувати нема за чим).
  ⚠️ **`Stats.tsx` — ОБОЛОНКА** (2026-08-08, було 1 379 рядків): період, валюта, режим і ОДИН
  запит `/analytics/overview`, який читають усі вкладки. Самі блоки — у `components/stats/`
  (`StatsOverview`/`StatsCategories`/`StatsTrends`/`StatsMerchants`/`StatsCompare` + `shared.tsx`).
  Розріз — ПО ВКЛАДКАХ: це межа, яку користувач і так бачить, і будь-яка інша дала б файли, назви
  яких довелось би вигадувати. **Спільний запит лишається в оболонці й передається вниз** — інакше
  чотири вкладки перезапитували б той самий період при кожному перемиканні, а дві з них могли б
  розійтись у числах про одні й ті самі гроші, поки одна застаріла.
- `src/components/ui/` — примітиви без доменних знань (`Icon`, `Select`, `Money`, `Skeleton`,
  `ErrorNote`, `EmptyCard`, `Gauge`, `Sparkline`…). **Тут не має бути жодного `useGet*Query`.**
- `src/components/layout/` — оболонка (`Layout`, `CommandPalette`).
- `src/components/dashboard/` · `stats/` · `transactions/` · `advisor/` · `planning/` ·
  `accounts/` · `settings/` — доменні блоки відповідних екранів.
- `src/store/` (RTK Query), `src/lib/` (`errors`, `format`, `brands`, `markdown`, `toast`),
  `src/i18n/`.
- `migrations/*` (0001→0045) · `wrangler.jsonc` · `.dev.vars` (локальні секрети, у .gitignore).
- `src/styles/*` — пʼятнадцять доменних файлів; `src/index.css` — ЛИШЕ імпорти (лінт C8). Токени —
  `styles/tokens.css`. `analytics.css` — шов від 2026-08-21: `domains-a.css` уперлась у стелю, а
  виняток рости не може, тож нові блоки Статистики їдуть туди. **`landing.css` (2026-08-26) —
  ЄДИНИЙ файл, де дозволена маркетингова ритміка** (full-bleed смуга, велетенський заголовок,
  інвертована панель): це єдиний екран, який людина бачить ДО продукту. Жив у `topbar.css`, який
  володіє хромом ЗАЛОГІНЕНОГО застосунку й до лендінгу стосунку не має.
- **`shared/api/*`** (2026-08-07) — ЄДИНЕ оголошення форми КОЖНОЇ відповіді API; файли дзеркалять
  `worker/routes/api/*`. Клієнт (`src/store/api.ts`) їх імпортує й ре-експортує і **власних типів
  відповідей не оголошує**; воркер анотує ними свої ПОВЕРНЕННЯ (`satisfies`, а `repo/` повертає
  прямо їх). Доти клієнт руками описував 86 форм «як він вважає, що сервер віддає», воркер —
  свої inline (26 із них як `Record<string, unknown>`, тобто без обіцянок узагалі), і `tsc` не міг
  зіставити дві правди: розходження вилазило в проді по одному полю. Тримається лінтом C2/C4.
  ⚠️ **Новий ендпоінт → його форма їде у `shared/api/`, а не в компонент і не в хендлер.**
- **`shared/currency.ts`** — the ONE symbol/code table (39 currencies, BOTH directions:
  `CURRENCY_BY_CODE` is derived by reversing it) and the list of currencies the app can roll up
  INTO (§BASE-CUR). The worker prints signs too, so a second table would disagree with the client
  exactly where nobody looks.
  ⚠️ **Це вже ставалось (2026-08-21): копій було ТРИ** — тут (7 валют), `lib/bank/normalize.ts`
  (39) і приватна шістка в `export.ts`. Чеська покупка експортувалась як «203», а §BANK-PARSE на
  реімпорті відмовляв невідомій валюті — round-trip губив рядок. Тепер решта ВИВОДИТЬСЯ звідси;
  нова валюта — один рядок в одному файлі.
- `shared/types.ts` — форми ТАБЛИЦЬ (`Account`, `Transaction`, `Category`…), `notif-i18n`.

## 🔒 Інваріанти (тримати ЗАВЖДИ)
- Гроші — **INTEGER-копійки** скрізь; ділимо на 100 лише в показі.
- Агрегація по `COALESCE(parent_id, id)` (рол-ап підкатегорій у батька).
- Кредитний ліміт НІКОЛИ не зливати з власними: власні = `balance − credit_limit`, борг окремо.
- **§BASE-CUR (2026-08-18): WHICH CURRENCY THE APP ANSWERS IN is the reader's question, not a
  constant.** The canon always rolled a multi-currency ledger up into ONE unit (`baseMult` in SQL,
  `toBaseMinor` in JS) and that unit was nailed to the hryvnia (`WHEN 980 THEN 1.0`) — so "roll up
  into one unit" and "roll up into ₴" had become the same sentence. They are not: the English UI
  exists for readers who hold no hryvnia, and "146 000 ₴" tells them nothing about the size of
  anything. It is a setting now.
  Single source — `worker/lib/finance/money.ts`: `resolveBaseCurrency(env)` (header
  `x-mt-currency` → `app_state.display_currency` → the LANGUAGE, the same order and the same
  reasoning as `resolveLocale`), `ratesInBase`, `getRates(env)`.
  ⚠️ **`getRates` kept its name and its type but returns rates IN THE READER'S BASE** (with its own
  row for 980). That is why none of its forty consumers had to be audited for the one that forgot
  to convert. The raw table is `getStoredRates`, reachable by two modules — held by lint **C10**.
  ⚠️ **A base with no rate is REFUSED** (falls back to ₴, and `/rates` returns the EFFECTIVE base):
  a client printing "$" over hryvnia figures is a worse failure than one printing "₴".
  ⚠️ **Amounts the USER TYPED are stored in HRYVNIA** (`budgets.amount`, `savings_goals`,
  `event_groups.budget`, `event_planned`, `facts.delta_minor` — none has a currency column). Reads
  convert (`uahToBase`), writes convert back (`baseToUah`). Named cost: a limit typed as $200 reads
  as $198 next month. That is the honest consequence of a hryvnia-denominated plan read in another
  currency, and it is smaller than the alternative — a limit compared against spending measured in
  a different unit, which is not a rounding error but a wrong answer.
  ⚠️ **A CLOSED month (`budget_months`) is written in HRYVNIA** (`hryvniaMult`): an archive whose
  unit depends on who happened to wake the cron that day is not a history.
  ⚠️ **The unit travels WITH the event:** `insertDrafts` stamps `cur` into `notif_params`. The feed
  renders numbers computed months ago; re-labelling them with today's currency puts the sign of one
  currency in front of the amount of another — a lie that renders perfectly.
  ⚠️ **API fields still end in `*_uah`** — the suffix is historical and means "minor units of the
  display base". Renaming is not free: those keys sit inside EVERY stored report
  (`reports.data_json`), so the repair would silently blank part of a user's own history. Instead
  the model gets `moneyUnitDirective` (`lib/ai/prompt.ts`) — left alone it reads a key name as a
  fact and writes "₴" over dollars (§LANG-ARCH, the money half).
  ⚠️ **Валюта СЛІДУЄ за мовою, а не зчитує її один раз** (2026-08-22, скарга: український
  інтерфейс, суми в доларах). `lib/currency.ts` праймиться з `getLocale()` НА ІМПОРТІ, а мова на
  той момент може бути ще не відома: у вебвʼю Telegram власне сховище, тож `mt-locale` порожній,
  локаль стартує з `en` → валюта 840. Далі `LocaleProvider` забирає мову акаунта, перемальовує
  всі рядки українською — і валюта лишається доларовою назавжди. Це та сама вада, від якої §i18n
  застерігає для `Intl`-форматерів, тільки застигле значення тут — гроші. Тепер `locale.ts` має
  `onLocaleChange`, а `currency.ts` ПІДПИСУЄТЬСЯ (імпорт лишається односпрямованим). Явний вибір
  не перебивається — тим він і явний.
  ⚠️ **`x-mt-currency` шлеться ЛИШЕ як явний вибір** (`currencyHeader()`). `resolveBaseCurrency`
  читає хедер ПЕРШИМ — попереду збереженої валюти й попереду мови, — що правильно для рішення й
  хибно для здогаду. Клієнт заявляв спраймлене значення завжди, тож пристрій, що спраймився в
  долари, казав серверу «долари», отримував долари на `/rates` і сам себе підтверджував: петля,
  з якої не було виходу, крім Налаштувань. Не сказати нічого — це дати серверу відповісти з того,
  що він знає.
  ⚠️ **Гілка, що ПЕРЕЙМАЄ серверну мову, мусить інвалідувати кеші так само, як гілка, що її
  штовхає.** Її не було: екран ставав українським, а назви категорій у вже завантажених
  відповідях лишались англійськими, і суми — в старій валюті (`/rates` несе тег `Summary`).
  ⚠️ **Client: `baseSign()` (`src/lib/currency.ts`), never a literal.** Dictionaries use `{cur}`,
  which `translate()` fills into EVERY string by itself — 28 entries said "₴" beside an
  already-converted number, and a parameter you have to remember would have been forgotten on the
  29th. Held by `check-i18n` + **C10** + `worker/test/currency.test.ts` (11 scenarios).
- Мультивалюта: `transactions.currency_code` = валюта РАХУНКУ (mono `amount` у ній); `original_amount`/`original_currency` = валюта операції. Зведення в ₴ — лише через `toUAHMinor`/курси (`app_state.rates`).
- **Пара-переказ = ЄДИНО `transfer_pair_id`** (ставить лише крок 1 `detectTransfers`). `is_transfer=1` НЕ згортає пару в один рядок — його ставлять 5 шляхів (вставка `repo.ts` через `descriptionIsTransfer`, AI-enrich, alias, ручне, одностороннє), і жоден з них pair_id не дає. Список ховає «+» сторону тільки по `transfer_pair_id` (`api.ts` `/transactions`). **Holds парують** (2026-07-15): моно лишає внутрішній рух («Округлення балансу», «Поповнення «На квартиру»») холдом надовго, а вхідну сторону на банці постить одразу `hold=0` — старий фільтр `hold=0` у детекті різав мінусову сторону, тож пара не збиралась і обидва рядки висіли окремо. Зміна суми на сеттлменті розпарює ОБИДВІ сторони (`repo.upsertMonoTx`) → наступний detect збирає заново.
- **Подія інжесту НЕ втрачається через невідомий рахунок (§STUB-ACC, 2026-08-07).** `upsertMonoTx`
  сам створює рядок-ЗАГЛУШКУ (`id` + валюта + баланс, `type`/`title` = NULL), якщо рахунку ще
  нема. Раніше `transactions.account_id NOT NULL REFERENCES accounts(id)` + увімкнені FK у DO
  давали 500, і операція зникала до наступного ретраю mono — тобто чи прийдуть гроші в застосунок,
  вирішувала ЧУЖА політика ретраїв. Реальний випадок: відкрив картку/банку → mono шле першу
  подію ДО того, як застосунок синкнув рахунки.
  ⚠️ **Заглушка мусить ЛІКУВАТИСЬ, інакше це власний баг.** Наступний `syncAccounts` дописує
  `type`/`title`/валюту. Для БАНКИ це окремий випадок: її upsert свідомо НЕ перетирає `title`
  (ручне перейменування має пережити синк), тож заповнення йде через
  `COALESCE(accounts.title, excluded.title)` — заповнити порожнє, не чіпати справжнє. Без цього
  банка, вперше побачена через вебхук, лишилась би безіменною назавжди.
  ⚠️ Валюта заглушки — `item.currencyCode` (валюта ОПЕРАЦІЇ): це той самий фолбек, який і так
  бере сама транзакція, тож рядок і його рахунок не можуть розійтись. Синк виправить.
  Тримається `worker/test/ingest.test.ts` (3 сценарії; без вставки заглушки падає 4).
- Секрети лише у Worker secrets, ніколи в git/на клієнті. Вебхуки — секретний сегмент шляху.
- `Select` замість native `<select>`. Тема світла/темна рівноправні. Дизайн свідомо НЕ «аішний» (див. DESIGN.md).
- **Ручна назва операції авторитетна:** `transactions.name_locked=1` (ставиться при ручній зміні мерчанта в TxDetail) → enrich/ре-світ НЕ перезаписує `merchant` (`merchant = CASE WHEN name_locked=1 THEN merchant ELSE ? END`); категорію/ai_note ще уточнює. Знімається кнопкою «дозволити AI оновлювати». Міграція 0019.
- **§INGEST-WRITE (2026-08-13): an incoming bank transaction is written by `upsertCanonicalTx`
  (`repo/ingest.ts`) ALONE.** There were two writers — `repo.upsertMonoTx` for the webhook and
  `csv.importTransactions` for a file — and a third was about to be written for PrivatBank. They
  differed in four places, none of them chosen: whether the comment took part in categorisation,
  whether an internal description set `is_transfer`, which columns were written at all, and what
  happens when the id already exists. Same shape as §CUR-PLAN and §A1-WRITE.
  The two differences that were REAL became arguments:
  ⚠️ **`onConflict`** — a FEED re-sends the same operation as its state changes and must overwrite
  in place (that is what keeps a hold and its settlement one row); a FILE re-import is a duplicate
  of something already stored and possibly hand-edited since, so it is left alone. This is a
  property of the delivery channel, **not of the bank**.
  ⚠️ **`accountCurrencyForIngest`** — only a feed may mint a §STUB-ACC row: a file's account came
  from a dropdown, so an unknown id there is a bug, and minting one would bury it.
  Mono keeps only its NORMALISATION (§R2-CUR1 original_*), which is the rule
  `providers/provider.ts` already stated. Held by `ingest.test.ts` (10) + `integrations.test.ts`
  (the two unified behaviours have their own scenario).
- **§BANK-PARSE (2026-08-13): bank strings are read in `lib/bank/normalize.ts`, once.**
  `parseAmountMinor` (minor units, ONE rounding), `parseStatementDate`, `currencyNumeric`
  (letters → the numeric code we store; unknown → `null`, **never** a fallback to 980 — that would
  silently multiply a balance by the exchange rate).
  ⚠️ **A zone-less wall clock is KYIV time, not UTC.** The CSV parser handed `dd.mm.yyyy hh:mm` to
  `Date.UTC`, so every imported evening operation was stored ~3 h late and filed under the NEXT
  day — §APP_TZ on the import path, and the totals still added up. Now resolved through
  `localWallTime` (`stats.ts`, generalised from `localMidnight`), so DST handles itself; an
  explicit offset (`Z`, `+03:00`) is honoured as written. Held by `normalize.test.ts` (15).
- **§BANK-FETCH (2026-08-13): how a bank is ASKED for history belongs to the PROVIDER.**
  `BankProvider.statement` = `{ pacing: {maxWindowSec, minGapMs}, fetch(), isRateLimit() }` — all
  three or none. `backfill.ts` was "monobank's backfill" wearing a general name: a 31-day window,
  a 60 s gap and a `MonoRateLimit` catch written into the loop, so a second bank would have had to
  fork it or silently break its own limits (which does not fail loudly — the sync just stalls).
  ⚠️ **The pacers ask, they do not assume:** `nextStepGapMs()` is read by BOTH the DO alarm and
  the client interval (`next_in_ms` on the backfill responses). A constant in the client is a
  second opinion about someone else's rate limit.
  ⚠️ **`fetch` receives the account currency** instead of reading the database: normalisation is
  the provider's one job, but a provider that queries stops being an adapter over an HTTP API.
  ⚠️ **A job that cannot run is skipped, never retried** (credential removed mid-run, provider
  lost its fetch): the alarm re-arms while the cursor has work, so a job that can neither run nor
  advance is an alarm that never stops — and a paid one.
  Held by `worker/test/backfill.test.ts` (8 scenarios, against a FAKE bank whose window and gap
  are deliberately NOT monobank's — with mono the same test would pass against the old code).
- **§BANK-CRED (2026-08-13): «which credential feeds this provider» is answered by
  `bankCredential(env, id)` (`lib/bank/credentials.ts`) ALONE.** `env.MONO_TOKEN` was read by name
  in four places. Resolution itself stays in `UserDO.appEnv`, which builds `env.BANK_CREDENTIALS`
  (provider id → resolved value) — that is where the owner gate already lives.
  ⚠️ **A deployment-wide secret is the OWNER'S, never everyone's fallback** (§Безпека — shipped
  twice, gave one user another user's statement). **A new provider gets NO deployment fallback at
  all, owner included:** there is no single-user history to stay compatible with.
- **§SET-FLOW (2026-08-14): картки Налаштувань розкладає БАГАТОКОЛОНКОВИЙ потік, не grid.**
  `columns: 2` + `break-inside: avoid`; `set-full` → `column-span: all`. Grid ставить сусіда за
  індексом, а не за висотою, тож будь-яка пара «коротка + висока» лишає діру, і впорядкуванням це
  не лікується — висоти залежать від даних акаунта. ⚠️ Порядок читання стає «згори вниз по
  колонці», а не «зліва направо»: додаючи картку, дивись, у яку колонку вона впаде.
  Шел сторінки живе в `styles/settings-shell.css` (виділено, бо `settings.css` уперлась у стелю
  C8, а виняток рости не може).
- **§WHY-CATEGORY (2026-08-14): AI-блок нарешті каже ЧОМУ.** `GET /transactions/:id/why` →
  `services/tx-insight.ts` `explainCategory`, який ПРОГАНЯЄ `categorize()`, а не відтворює те,
  що вона сказала б: одна реалізація вирішує і та сама пояснює, тож пояснення не може розійтись із
  поведінкою. `CategorizeResult` тепер несе `source`/`detail` — який саме крок відповів.
  ⚠️ **Це стан ПРАВИЛ ЗАРАЗ, а не історія.** Що вирішило категорію в момент інжесту, не зберігає
  ніхто; UI каже це прямо, бо пояснення, яке тихо видає себе за історію, гірше за відсутнє — йому
  повірять.
  ⚠️ **Розбіжність показуємо, але не «лагодимо»:** збережена категорія може бути свідомою правкою
  людини, і мовчазний «ремонт» скасував би її роботу — а інакше про розходження ніяк не дізнатись.
  ⚠️ Пояснюємо СИРИЙ банківський опис, а не почищений `merchant` (enrich його переписує) — інакше
  впевнено пояснювали б рішення текстом, якого рушій не бачив. Тримається `similar.test.ts` (4).
- **§SIMILAR (2026-08-13): «познач схожі так само» — `GET /transactions/:id/similar` + наявний
  bulk.** Схожість — це `coreToken` (`lib/finance/merchants.ts`), ЄДИНЕ визначення «той самий
  мерчант, приблизно». ⚠️ Воно існувало ДВІЧІ (там і в `ai/enrich.ts`), байт-у-байт, із коментарем
  на кожній копії, що вони збігаються: консенсус категорій, злиття транслітерацій і ця фіча
  вирішують одне питання, і розбіжність двох із них читалась би як застосунок, що групує операції
  одним способом, а розкладає іншим.
  ⚠️ **Показуємо лише те, що ЗМІНИТЬСЯ:** рядки, вже оформлені так само, у список не потрапляють —
  інакше треба вичитати пʼятнадцять рядків, щоб знайти три потрібні.
  ⚠️ **`suggested` вирішує СЕРВЕР:** без категорії — це прогалина (галочка стоїть), з ІНШОЮ
  категорією — це чиєсь рішення (пропонуємо, але не позначаємо). Те саме правило, що в
  §RULES-UI apply: застосунок не сперечається мовчки з уже зробленою роботою.
  ⚠️ Кнопки «застосувати до всіх схожих» немає навмисно: масова правда наосліп чіпає рівно ті
  рядки, на які ніхто не дивиться. Тримається `similar.test.ts` (6 сценаріїв).
- **§SHARE-CSV (2026-08-13): виписку можна ПОДІЛИТИСЬ у застосунок.** Один share-target на застосунок
  (маніфест другого не підтримує — просто ігнорує), тож обидва види файлу приїжджають на ту саму
  дію `/share-receipt`, а service worker дивиться, яке поле прийшло: `photo` → `/add`, `statement`
  → `/setup?shared=statement`. Шлях у CsvImportCard той САМИЙ, що в файл-пікера — інакше поділений
  файл поводився б інакше за обраний.
  ⚠️ Список `accept` навмисно широкий (`text/plain`, `application/vnd.ms-excel`): Android
  повідомляє MIME по-різному залежно від застосунку-експортера, а превʼю все одно показує, що
  зрозуміло, до запису.
  ⚠️ Імʼя файлу їде окремим заголовком у Cache API: виписка впізнається саме за імʼям (який
  рахунок, який період), і «shared.csv» це стирає.
- **§STALE-IMPORT (2026-08-13): рахунок, який годується ЛИШЕ файлом, нагадує про себе сам.**
  `drafts-import.ts`: якщо найновішій імпортованій операції >35 днів — подія у стрічці, ≤3 рахунки,
  один раз на рахунок на КИЇВСЬКИЙ місяць. Ознака «годується файлом» — `provider NOT IN
  ('mono','privat')` плюс наявність рядків `source='import'`.
  ⚠️ **Kind — `todo`, а не власний:** це та сама турбота, що «10 операцій без категорії» — застосунок
  просить людину дороби?ти те, що може лише вона, — тож один перемикач мусить глушити обидва.
  ⚠️ Веде на `/setup?import=1` (картка сама прокручується до себе), а не на `/accounts`: список
  рахунків цієї проблеми не розвʼязує.
  ⚠️ Вирішує НАЙНОВІША імпортована операція, а не найстаріша: виписка покриває місяці, тож
  дворічний рядок у рахунку — це норма, і читання найстарішої нагадувало б усім і завжди.
  Тримається `drafts-import.test.ts` (6 сценаріїв).
- **§CSV-PREAMBLE (2026-08-13): шапка виписки — не заголовок таблиці.** `findHeaderRow`
  (`providers/csv.ts`) шукає рядок, з якого мапиться найбільше колонок, серед перших 40; усе вище
  — преамбула (реквізити банку, ПІБ/ІПН/адреса власника, період, підсумки). Реальний експорт
  Raiffeisen має 23 такі рядки, і застосунок називав звичайний файл нечитабельним.
  ⚠️ **Кількість пропущених рядків ПОКАЗУЄТЬСЯ** в превʼю: рядок, що зник без причини, — це саме
  те, чого шлях імпорту не робить ніколи, навіть коли викинути його правильно.
  ⚠️ Підказки колонок мусять містити ТОЧНЕ написання, а не лише збіжне: «Amount in card currency»
  має бити «Amount in transaction currency» за правилом, а не тому, що трапилось першим.
- **§BANK-POLL (2026-08-13): банк, який не пушить, треба ПИТАТИ** — `lib/bank/poll.ts`, четвертий
  претендент на єдиний alarm обʼєкта (§A6). monobank сюди не потрапляє ніколи: вирішує
  `provider.mode === "poll"`, а не наявність `statement`, — моно вміє віддати виписку (так працює
  бекфіл), але полінг зʼїв би його запит-на-хвилину заради даних, які вже прийшли вебхуком.
  ⚠️ **Вікно ПЕРЕКРИВАЄ попереднє** (6 год): банк постить операцію через хвилини-години після
  того, як вона сталась, тож запит «від останнього полінгу» мовчки втрачає все, що приїхало із
  запізненням, — і результат при цьому виглядає нормально.
  ⚠️ **Один рахунок за прохід** + власний таймстамп останнього ЗАПИТУ (не останнього успіху):
  спати між запитами всередині alarm — це палити оплачений час, а пейсинг, що рахує лише успіхи,
  перестає бути пейсингом у циклі відмов.
  ⚠️ **Жорсткий збій ПОЗНАЧАЄ рахунок опитаним**, ліміт — ні. Інакше зламаний назавжди креденшел
  вічно лишається «найпростроченішим» і зʼїдає кожен прохід; сам збій видно на картці підключень.
  Тримається `backfill.test.ts` (7 сценаріїв полінгу).
- **§BANK-CONN (2026-08-13): `bank_connections` нарешті мають читача.** Рядок на креденшел
  (`repo/connections.ts`), пишеться на КОЖНУ спробу — синк рахунків, крок бекфілу, прохід полінгу;
  `accounts.connection_id` проставляється на успіху. Картка «Підключені банки» в Налаштуваннях.
  ⚠️ **Збій НЕ стирає `last_sync_at`:** «працювало о 09:00, відтоді падає» і «не працювало
  ніколи» — різні факти, що потребують різної реакції від читача. Успіх, навпаки, чистить
  `last_error`: свіжий таймстамп поруч зі старою помилкою жене лагодити те, що вже саме одужало.
- **Роль рахунку (§R3):** `accounts.role` = `liquid` (дефолт/NULL) або `investment`. Ліквідна ПОДУШКА/runway рахуються лише з `liquid`; `investment` (крипта/брокер) — окремий інвест-резерв, НЕ подушка за замовчуванням. `accounts.ai_note` — опис рахунку для AI. Єдине джерело коштів — `fundsBreakdown()` (advisor.ts): `{cushion, debt, investment, net, accounts[]}`. Міграція 0018.
- **Сума плану в ₴ — лише `plannedUAH()`/`sumPlannedUAH()`** (subscriptions.ts, §CUR-PLAN 2026-07-20).
  `planned_payments.period_amount` — у ВАЛЮТІ ПЛАНУ (`currency_code`), як і в транзакціях. Пʼять місць
  сумували його напряму, тож підписка $5 важила 5 ₴: «Скоро спишеться», Cashflow-календар, прогноз місяця,
  safe-to-spend і **AI-контекст порадника** (там поле навіть звалось `amount_uah`, а конверсії не було).
  У SQL-агрегатах зводь через `uahMult(rates, "currency_code")`. **Ніколи не сумуй `period_amount` сирим.**
  UI: суму показуй у валюті плану, ₴-еквівалент — окремим підписом; підсумки/проєкції — завжди в ₴.
- **МІСЯЧНИЙ тягар плану — лише `monthlyPlannedUAH()`/`sumMonthlyPlannedUAH()`; розклад
  списань — лише `chargesBetween()`** (subscriptions.ts, §SUB-MONTH 2026-08-01).
  `plannedUAH` зводить валюту (§CUR-PLAN), але НЕ приводить період: «підписок на місяць»
  рахувалось як `SUM(period_amount)` по активних планах, тобто сума СВОГО періоду в кожного —
  квартальний план важив повну суму щомісяця, тижневий рахувався один раз замість ~4.3.
  Формула описана ще в міграції 0011, але жоден із сумувальників її не застосовував; сторінка
  Підписок ділила правильно, тож користувач бачив ДВІ різні цифри про свої підписки (його ж
  скарга).
  ⚠️ **Той фікс накрив пʼять СЕРВЕРНИХ сум і лишив сторінку рахувати самій** (закрито 2026-08-21).
  Множник збігався — і поруч стояв коментар, що збігається, — а «чи план завершено» розійшлось:
  локальний `isFinished` перевіряв `kind === "installment"`, канон завершує будь-що після
  `end_date`. Скасована підписка з датою кінця важила повну суму там і нуль скрізь. Тепер
  `/planned` несе `monthly_base` з канону. **Не множ `period_amount` у компоненті.**
  ⚠️ Тримається `worker/test/subscriptions.test.ts` — файлом, який до 2026-08-21 **не існував**,
  хоч цей рядок посилався на нього три тижні. Задокументований запобіжник, якого немає, гірший за
  відсутній: його читають як покриття.
  ⚠️ **Розділяй два різні питання:** «скільки підписки зʼїдають на місяць» — усереднення
  (`monthlyPlannedUAH`); «що спишеться до кінця місяця» — РОЗКЛАД (`chargesBetween`), бо
  квартальний платіж або є в цьому місяці, або його нема. Safe-to-spend, прогноз місяця,
  cashflow-календар і провал ліквідності стоять на розкладі; AI-контекст — на усередненні.
  ⚠️ **Підписка ≠ категорія «Підписки».** Інтернет лежить у «Комуналці», хмара — в «Софті».
  Тому в AI-контекст їде СПИСОК планів із категоріями (`subscriptions`) + `subscriptions_note`,
  а не лише сума: без нього модель називала підписками вміст однойменної категорії.
- **AI-повернуті id категорій валідуй перед записом (§FK-GUARD 2026-07-20).** Категорій 45, але id
  доходять до 54 — у діапазоні дірки від видалених, і «правдоподібний» id від моделі влучає в неіснуючий
  рядок → `D1_ERROR: FOREIGN KEY constraint failed` на enrich. Хелпер `existingCategoryIds()` (enrich.ts)
  фільтрує `category_id` + `tag_ids` одним запитом; alias пише лише перевірений id.
- **§SUB-FIND / §SUB-ALIAS (2026-08-27): підписку впізнають за ВСІМА її назвами, і шукають по
  всьому, що застосунок про операцію знає.** Дві скарги, одна причина — і мерчант, і пошук читали
  тільки `transactions.merchant`:
  ⚠️ «твітер» не знаходив нічого, бо списання лежить як «X Corp.» — при тому що власник САМЕ на тій
  операції пояснив AI, що це його підписка на твітер, і модель це записала в `ai_note`. Відповідь
  була в базі, а запит у неї не дивився. Тепер `searchHaystack` (`repo/planning.ts`) і
  `txHaystack` (`lib/finance/subscriptions.ts`) = мерчант + СИРИЙ опис банку + коментар + `ai_note`.
  **Новий матч по тексту операції бере цей хейстек, а не `merchant`.** Те саме правило, що §RULES-UI.
  ⚠️ «X підписка» повертав OnTa**x**i, E**x**pres і PADDLE.NET — `LIKE '%X%'`. Модель тепер віддає
  СПИСОК назв бренда (`X Corp`, `Twitter`, `твітер`), а термін коротший за `MIN_TERM = 3` не
  шукається взагалі — навіть якщо його дала модель.
  ⚠️ `LIKE` і `LOWER()` у SQLite складають регістр ЛИШЕ для ASCII, тож «Твітер» не збігався з
  «твітер». `likeVariants` шле обидва написання — повний Unicode-фолд потребує колації, якої в D1
  немає.
  ⚠️ **`planNeedles` (§SUB-ALIAS): план знають і за його `note`** — слова ≥4 літер, мінус ті, що є
  в кожній нотатці («підписка», «оплата», «monthly»). Без цього план «Twitter» не чіпляв жодного
  списання «X Corp.»: `planned_id` лишався порожнім, категорію вгадував AI, а `plannedActuals`
  показував нуль — тобто стрічка оголошувала «списань не видно» про підписку, яку платять щомісяця.
  Це безпечно саме тому, що назва — лише ОДИН із гейтів: валюта й сума (±10%) мусять збігтись.
  Тримається `subscriptions.test.ts` + `planning-consistency.test.ts`.
- **§SUB-DATE (2026-08-27): місячний план тримає СВОЄ число, хоч би скільки днів було в місяці.**
  `nextChargeUnix` крокував `Date.setMonth(+1)`, а JS розвʼязує 31 лютого ПЕРЕПОВНЕННЯМ: план від
  31-го йшов 31 січ → 3 бер → 3 кві — лютий пропущено, і далі назавжди 3-тє число. Дата, що тихо
  відходить від дня, коли людина реально платить, потрапляє в інший бюджетний місяць, а зникле
  списання — саме те, якого ніхто не шукає. Тепер кожне списання рахується ВІД СТАРТУ, день
  затискається до останнього дня місяця, а якорем є КИЇВСЬКИЙ день (§APP_TZ) через `localWallTime`.
- **§SUB-PAGE (2026-08-27): у підписку можна провалитись** — `/subs/:id`, дані з
  `GET /planned/:id/overview` (`lib/finance/subscription-overview.ts`). План був рядком у списку:
  назва, сума, наступна дата — жодне з питань, які людина справді має про підписку. Сторінка
  відповідає на пʼять: скільки вже сплачено (сума ВСІХ привʼязаних списань), чи подорожчала
  (останнє списання проти оголошеного — **в тій валюті, якою списали**: рух курсу це не
  подорожчання), чи списують так часто, як каже план (**реальна каденція між списаннями** проти
  оголошеної — «місячний» план, що списується кожні 14 днів, доти не було видно нічим), скільки це
  на рік, і яку частку займає — від підписок, від своєї категорії, від місячних витрат.
  ⚠️ Усі числа — з канону (`monthlyPlannedUAH`, `categoryMonthlyLevels`, `sumLevels`,
  `nextChargeUnix`). Сторінка нічого не перераховує: інакше вона й Порадник могли б розійтись про
  ту саму підписку.
  ⚠️ Завершений план НЕ показує наступного списання: надрукувати дату, на яку воно б випало, —
  це застосунок, що сперечається з уже прийнятим рішенням.
  ⚠️ Без `STATS_JOINS` навмисно: списання підписки — ЦІЛА транзакція, яку банк або зробив, або ні.
  Спліт каже, куди пішли гроші, а не скільки взяв білер. Тримається `subscription-page.test.ts` (11).
- **§CAT-SUBS (2026-08-27, ROADMAP §0.1): на сторінці категорії — блок «з них підписки».**
  Підписка ≠ категорія «Підписки» (інтернет у Комуналці, хмара в Софті), тож підсумок категорії
  відповідає «скільки», але ховає «скільки з цього зафіксовано, поки щось не скасуєш». Частка —
  від канонічного місячного РІВНЯ, і `null` там, де рівня не існує (підкатегорія, дохід), а не
  відсоток від іншого періоду. Батько рахує й плани своїх ДІТЕЙ — бо його сума витрат теж їх рахує.
- **Наступне списання плану — лише `nextChargeUnix(startDate, period, count, now)`** (subscriptions.ts, ЄДИНЕ джерело; враховує `period_count` — «кожні N періодів»). Не дублювати логіку в ендпоінтах.
- **§INCOME-PLAN (2026-08-14, міграція 0044): дохід теж отримав РОЗКЛАД.**
  `planned_payments.kind` знав лише `subscription|installment` — обидва це відтік. Тому і
  `/analytics/safe-to-spend`, і `/analytics/forecast` рахували `дохід − витрати`, де витрати були
  РОЗКЛАДОМ уперед (`chargesBetween`, `projectSpend`), а дохід — ІСТОРІЄЮ з 1-го числа. Одне
  віднімання, дві різні природи: 3-го числа застосунок віднімав місяць підписок від кількох днів
  доходу й повідомляв, що вільного майже немає. Найпесимістичніший саме тоді, коли на нього
  найбільше дивляться, і назавжди хибний для нерівномірного (ФОП) доходу.
  ⚠️ **Очікуваний дохід НІКОЛИ не додається до канонічного `income`** (`INCOME_WHERE`,
  `incomeSum`) і **не входить у `safe`**. Це число, проти якого витрачають; неоплачений інвойс,
  порахований як гроші на руках, — саме той різновид помилки, через який фінансовий застосунок
  стає шкідливим. Асиметрія лікується у ПРОГНОЗІ, де прогноз і доречний (`projectedIncome`).
  ⚠️ **Запізнення ВИВОДИТЬСЯ, а не зберігається:** `overdue = заплановано-дотепер − отримано`,
  порівняння ПІДСУМКІВ. Матчер «цей інвойс ↔ ця транзакція», який промахнувся, позначає реальні
  гроші як зниклі; підсумок — ні. І це переживає справжнє обмеження, яке назвав власник: дохід
  ані однакового розміру, ані вчасно, тож інша сума або незапланований платіж просто закривають
  розрив — що й сталося в житті.
  ⚠️ **`OUTFLOW_ONLY` стоїть на КОЖНОМУ селекторі `repo/planning.ts`.** `chargesBetween`
  розгортає що дадуть, тож план доходу, який дійшов би до будь-якого з них, рахувався б як гроші,
  ЩО ЙДУТЬ — роздуваючи «скоро спишеться», календар, провал ліквідності, прогноз і тягар підписок
  у контексті порадника, і все це виглядало б цілком правдоподібно. Фільтр у репо, а не на
  викликах: інакше памʼятати мусили б пʼять місць. `notify.draftLiquidity` мав ВЛАСНУ inline-копію
  того самого SELECT — прибрано, бо саме вона й була пʼятим місцем.
  ⚠️ **Календар і провал ліквідності більше не аутфлоу-only.** Надходження йдуть ВІДʼЄМНОЮ сумою
  в тому самому ряду, тож денний нет — це просто сума, а баланс — одне віднімання. Доти проєкція
  вміла лише падати: будь-хто, чия зарплата приходить пізніше за оренду, отримував «провал
  ліквідності» гарантовано — діру, яку закривали гроші, про які календар не знав.
  ⚠️ `amount_varies` — не діапазон, а позначка «це ОЦІНКА»: діапазон запрошує застосунок цитувати
  його оптимістичний край. Тримається `income-plan.test.ts` (10 сценаріїв).
- **§GOAL-CHART (2026-08-14): графік для цілі-БАНКИ, і одна серія на обидва види.**
  Ручна ціль росте з `goal_contributions`, у банки їх немає за визначенням — її прогрес ЦЕ баланс
  рахунку (`account_balance_history`). Два сховища однієї ідеї, і саме тому картка в ROADMAP
  відмовлялась щось малювати, поки це не вирішено. Вирішено на СЕРВЕРІ: `goalProgressSeries`
  зводить обидва в один ряд `{at, amount}`, `GET /goals/:id/progress`, клієнт малює одне й не знає
  про різницю. Два клієнтські шляхи були б §CUR-PLAN із графіком.
  ⚠️ **Ручна ціль — НАКОПИЧЕННЯ, банка — РІВЕНЬ.** Внески це дельти, які треба підсумувати; баланс
  уже є прогресом. Підсумувати баланси означало б помножити гроші банки на кількість днів, коли її
  записували, — крива до 10× цілі під карткою, яка каже 40%.
- **§EVENT-GOAL (2026-08-14, міграція 0045): подія називає ціль, на яку відкладалось.**
  Дві половини одного плану лежали в різних таблицях без звʼязку: ціль «Японія» наповнювалась
  грошима, подія «Японія» — витратами, і застосунок не міг сказати, що це одна затія. Тепер
  `event_groups.goal_id`, блок на сторінці події й `goal` у payload AI-вердикту.
  ⚠️ **`ON DELETE SET NULL`, не CASCADE:** видалення цілі не сміє стерти історію витрат — подорож
  усе одно відбулась, і її операції це запис про неї.
  ⚠️ Вердикт формулюється СЛОВАМИ («вистачило, лишилось 9 000»), бо «відклав 70 000, витратив
  61 000» усе ще просить читача відняти; числа лишаються під ним, бо вердикт без чисел не
  перевірити.
- **§GOAL-PACE (2026-08-12): "will this goal make it" — `goalPace()` ALONE** (`lib/finance/goals.ts`,
  a pure function with no database access). One question, answered in TWO places: the card computed
  the monthly rate in the CLIENT (`left ÷ months`, month = 30.44 days), `draftGoalRisk` had its own
  (`need ÷ (days / 30)`), and only the second knew anything about falling behind — which the card
  never showed at all. So the feed could announce a goal is behind and name a figure written down
  nowhere on the goal itself. The pace is computed on the SERVER now and returned as `pace` on
  `/goals`; the notification drafter calls the same function.
  **Do not compute "how much to save per month" in a component.**
  ⚠️ Thresholds: behind = a gap between "time elapsed" and "money saved" of **≥15 points** (any
  contribution arriving a week late produces a smaller one, and a badge that is always lit stops
  being read); the final week is `at_risk` regardless of percentage, because the question there is
  no longer "are you catching up" but "will you make it".
  ⚠️ **There is NO monthly rate under a month to the deadline** (`per_month === null`): "save
  120 000/mo" with 20 days left is arithmetically true and practically nonsense. Both the card and
  the notification fall back on `left`. Decision of 2026-07-14, DESIGN §8 P5.
  ⚠️ The start is the goal's `created_at`, not its first contribution: a goal opened six months ago
  and still empty is behind precisely because nothing happened for six months.
  Held by `worker/test/goals.test.ts` (10 scenarios).
- **Фінансовий контекст для AI — лише `collectFinanceSnapshot(env)`** (advisor.ts, ЄДИНЕ джерело, 2026-07-14). І Порадник (`buildAdvice`), і Чат (`chatReply`) беруть ТОЙ САМИЙ знімок: розбивка коштів (`fundsBreakdown`), канонічний burn (`sumLevels`)/runway, підписки, бюджети, вагомість, тренд 6 міс, разові/регулярні, найближчі списання (`upcoming_charges`). → цифри чату = цифри Порадника. НЕ будувати збіднений контекст для чату вручну (це давало баг «домисленої подушки» — модель називала суму, якої не було в жодному запиті, + розсинхрон runway).

- **§AI-AUDIT (2026-08-12, міграція 0041): що змінив AI — записано, і це МОЖНА відкотити.**
  Застосунок дозволяє моделі переписати `category_id`, `is_transfer` і `ai_note` операції з трьох
  шляхів (enrich, ре-світ, розмова на сторінці операції), і жоден із них не лишав сліду: категорія
  могла не збігатися з тим, що поставив банк або людина, а хто це вирішив і яким було попереднє
  значення — не знав ніхто. Таблиця `ai_changes` (`tx_id`, `field`, `old_value`, `new_value`,
  `source`, `reverted_at`), журнал на сторінці операції з кнопкою «Повернути».
  ⚠️ **`old_value` — це те, що робить журнал ВІДКОТОМ, а не просто логом.** `NULL` у ньому —
  справжнє попереднє значення («категорії не було»), а не «невідомо»; тому всі три поля
  зберігаються текстом — один nullable-рядок несе три різні типи без окремої форми на кожне.
  ⚠️ **Пишемо, лише коли значення СПРАВДІ змінилось** (`logChange` порівнює рядкові форми):
  enrich, що підтвердив наявну категорію, — найчастіший випадок, і його запис поховав би десяток
  реальних змін під тисячами «AI погодився з тобою».
  ⚠️ **Відкот МАРКУЄ рядок, а не видаляє його**, і повторний відкот — no-op: журнал фіксує те, що
  БУЛО, тож друга спроба записала б застаріле значення поверх того, що людина вже обрала.
  ⚠️ **Те саме стосується БУДЬ-ЯКОЇ пізнішої зміни** (2026-08-21): відкот звіряє поточне значення
  з `new_value` і відмовляється (409) з поясненням, якщо поле змінилось після AI. Доти людина, яка
  сама виправила категорію, натиснувши «Повернути», стирала власну правку значенням, що передувало
  обом. Той самий принцип, що §RULES-UI apply і §SIMILAR: не сперечатись мовчки з уже зробленою
  роботою.
  ⚠️ Логування best-effort: журнал, здатний завалити зміну, яку він описує, робить застосунок
  гіршим у тому, про що його попросили.
  Тримається `writes.test.ts` (4 сценарії: відкот категорії, повторний відкот, відкот у «без
  категорії», 404 на невідомий запис).
- **§TX-CHAT (2026-08-12, міграція 0040): розмова ПРО ОПЕРАЦІЮ теж зберігається.** Жила в
  `useState` компонента `TxAiChat` — існувала до переходу на інший екран і зникала. Це гірше за
  стан, який лікував §CHAT-SYNC: людина пояснює «це було за курс, а не розваги», модель це
  враховує, а через годину сліду пояснення немає ніде. Тепер це рядок у ТИХ САМИХ `chats` із
  `kind='tx'` + `entity_id = transactions.id`; id виводиться (`tx-<txId>`), тож сторінка знаходить
  розмову, знаючи лише операцію, і другого ключа зберігати не треба.
  ⚠️ **Рейка порадника фільтрує `kind='advisor'`** — інакше розмова про одну каву лежала б у
  списку фінансових бесід і ховала б ті чотири, до яких справді повертаються.
  ⚠️ **Стеля 60 розмов — ПОКИ НА ВИД.** Зі спільною людина, що розпитала про шістдесят операцій,
  мовчки витерла б собі всі розмови з порадником. Це різні речі з різним часом життя.
  ⚠️ Обидва ходи пише СЕРВЕР у `POST /transactions/:id/chat`, поруч із генерацією відповіді (те
  саме правило, що §CHAT-SYNC): клієнт, який записує свою половину сам, лишає обірваний обмін
  щоразу, коли генерація впала. Запис best-effort — нездатність зберегти розмову не має зʼїдати
  відповідь, на яку людина чекає.
  Тримається `writes.test.ts` (3 сценарії, зокрема «не потрапляє в рейку порадника»).
- **Розмови з порадником живуть НА СЕРВЕРІ (§CHAT-SYNC, міграція 0038).** Таблиці `chats` +
  `chat_messages` у власному DO юзера; єдиний писар — `repo/chats.ts`, транспорт — `routes/api/chats.ts`.
  Доти вони лежали в `localStorage` (`mt-chats:<user_id>`), тобто розмова існувала лише на тому
  пристрої, де її набрали: питання з телефона не було на ноутбуці, а копія листування про зарплату
  лишалась на диску кожного пристрою, з якого юзер колись заходив.
  ⚠️ **Хід асистента пише СЕРВЕР** — у `/advisor/chat/stream`, ПЕРЕД тим як сказати клієнту «готово»
  (`chat_id` у тілі). Саме тому відповідь переживає закриту вкладку, обрив і перехід на телефон
  посеред тридцятисекундної генерації. Клієнт постить лише СВІЙ хід; ендпоінт `role` від нього не
  приймає взагалі — інакше в уста порадника можна було б вкласти слова, які модель потім прочитає
  як власні міркування.
  ⚠️ **Id генерує клієнт** (`c<base36>`, валідація `^[A-Za-z0-9_-]{1,40}$`): стрічка мусить показати
  нову розмову в мить кліку. Це ж робить разовий імпорт зі старого `localStorage` ідемпотентним —
  другий пристрій дозаллє своє й не подвоїть спільне (`INSERT OR IGNORE`).
  ⚠️ **Порожня розмова на сервер НЕ їде** — «нова розмова» лишається чернеткою в клієнті, поки в неї
  не написали: рядок без жодного повідомлення поїхав би на всі пристрої й пережив би того, хто
  передумав питати. Стелі — 60 розмов / 200 ходів, збиваються на ЗАПИСІ (не нічним прибиранням).
  Тримається `worker/test/writes.test.ts` (4 сценарії).
- **Компенсація витрати (§COMPENSATION, міграції 0029 + **0030 v2**):** одне надходження
  РОЗПОДІЛЯЄТЬСЯ між кількома витратами. Джерело правди — `tx_reimbursements(expense_id,
  source_tx_id, amount)`; на `transactions` дві денормалізовані суми, які й читає канон:
  `reimbursed` (скільки компенсовано ЦІЙ витраті) і `reimburses_total` (скільки з ЦЬОГО
  надходження вже роздано). **Єдиний писар обох — ендпоінт `/reimbursement`** (`rbRecalc`).
  Канон: `EFF_AMOUNT` додає `+ COALESCE(t.reimbursed,0)`; `EFF_INCOME = t.amount −
  COALESCE(t.reimburses_total,0)`; `SPEND_WHERE` має `AND COALESCE(t.reimburses_total,0) = 0`;
  `INCOME_WHERE` має `AND EFF_INCOME > 0`, а `incomeSum` сумує `EFF_INCOME`, НЕ `t.amount`.
  **Правило:** компенсацією є лише РОЗПОДІЛЕНА частина надходження; нерозподілений залишок —
  справжній дохід. **Спліт і компенсація взаємовиключні** (перевірка з обох боків).
  Сума розподілів ≤ суми витрати; сума з одного джерела ≤ його суми.
  ⚠️ **Чому v2 (баг, знайдений на реальних даних):** надходження, БІЛЬШЕ за витрату, яку воно
  компенсує. Модель 0029 дозволяла привʼязати надходження рівно до ОДНІЄЇ витрати й обрізала суму
  стелею витрати, а `INCOME_WHERE` виключав УСЕ надходження → різниця не потрапляла ні у витрати,
  ні в дохід. Гроші просто зникали зі статистики. Схема v2: надходження = сума розподілів по
  кількох витратах + нерозподілений залишок, і залишок лишається справжнім доходом.
- **Спліт транзакції (§SPLIT, міграція 0021):** одна витрата ділиться на кілька категорій (`tx_splits`). ЄДИНА точка інтеграції — `STATS_JOINS` (LEFT JOIN `tx_splits sp` + `sc`/`scp` для рол-апу категорії частини) + `EFF_AMOUNT = COALESCE(sp.amount, t.amount)` + `EFF_CAT_*`/`EFF_IMPORTANCE` (частина спліту має пріоритет). Спліт-tx розмножується на рядки-частини → сума/категорія беруться з частини, тож спліт іде в УСЮ категорійну аналітику узгоджено. **Правило:** у будь-якому STATS_JOINS-запиті сума витрати = `-EFF_AMOUNT` (НЕ `-t.amount`), інакше спліт-tx переоблічується. Дохід (`INCOME_WHERE`) і balance-реконструкція (capital-trend — з `accounts.balance`) спліт НЕ чіпають. Лише витрати. Валідувати на D1.
  **⚠️ Дзеркальне правило (регресія 2026-07-20):** зворотне теж обовʼязкове — запит, що вживає
  канонічний хелпер, МУСИТЬ мати `STATS_JOINS`. `amountSum/spendSum/incomeSum` і `EFF_*` посилаються
  на аліаси `sp`/`sc`/`scp`, які дає лише він; без джоїнів D1 кидає `no such column: sp.amount`.
  Ловиться `npm run check` (SQL-лінт), бо `tsc` цього не бачить.
  **Рахунок операцій у спліт-запитах — `COUNT(DISTINCT t.id)`**, не `COUNT(*)`: джоїн розмножує рядок
  на частини, тож `COUNT(*)` завищує кількість (і занижує середній чек).

## 🚨 Обробка помилок (ЄДИНІ правила, 2026-07-20)
Введено після регресії, де вся Статистика мовчки порожніла, а AI-чат казав лише `[object Object]`.
Три шари, кожен — обовʼязковий:
- **Сервер:** `app.onError` (`worker/index.ts`) віддає для `/api`+`/ingest` JSON `{error, detail}` і логує стек.
  Без нього неспійманий throw давав порожній 500 `text/plain` — клієнту не було що показати.
  Ендпоінти й далі можуть повертати свій `{error}` — форма та сама.
- **Числовий параметр із URL — лише `numParam()`** (`routes/api/_shared.ts`, 2026-08-21).
  `Number(x ?? d)` НЕ рятує від `NaN`: `??` ловить лише null/undefined, а `Number("abc")` — це
  значення, тож фолбек не спрацьовує і NaN їде в дату (виняток) або в `.bind()` (мовчазний нуль).
  Пʼять ендпоінтів на цьому ламались: два віддавали 500, три — `{from: null, spend: 0}`, що на
  екрані читається як «нічого не витрачено». Затискає, а не відхиляє: застаріле посилання має
  показати дефолт, а не помилку. Тримається `bad-input.test.ts` (пінить КЛАС, не список).
- **Клієнт, текст помилки — ЛИШЕ `errText(e)`** (`src/lib/errors.ts`). **Ніколи `String(e)`**: RTK Query
  відхиляє проміс простим обʼєктом `{status, data}`, тож `String(e)` = `"[object Object]"` — рівно нуль
  інформації. `errText` розгортає тіло `{error}` → статус → `Error.message`. Є ще `errStatus(e)` для гілок за кодом.
- **Клієнт, видимість:** (а) `apiErrorMiddleware` (`src/store/errorMiddleware.ts`) — toast на БУДЬ-якому
  впалому запиті (дедуп 8с на ендпоінт, 401 мовчить бо є редірект на вхід); (б) `<ErrorNote error={…}
  what="…" onRetry={refetch} />` — інлайн там, де сторінка інакше показала б порожнечу.
  **Правило:** сторінка з `data?.x ?? []` МУСИТЬ мати гілку помилки — порожнеча й збій виглядають по-різному.
- **AI-гілки не глушити:** `catch` навколо AI-виклику показує `errText(e)`, а не «Спробуй ще раз» —
  інакше ліміт/ключ/збій моделі не діагностуються.

## 🧮 Канонічне визначення статистики — `worker/lib/finance/stats.ts` (ЄДИНЕ джерело)
Використовується УСІМА `/analytics`-ендпоінтами + AI-контекстом (порадник, інсайт, репорти) → **цифри UI = цифри AI**.
- **§REFUND (2026-07-21): повернення коштів — це НЕ дохід, а ВІД'ЄМНА ВИТРАТА своєї категорії.**
  `IS_REFUND` (stats.ts) = надходження, поза бакетом 13, і (ефективна категорія ІСНУЄ та `is_income=0`
  АБО опис від банку «Скасування…»). Рефанд проходить `SPEND_WHERE` (тож `amountSum` віднімає його,
  бо рахує `-EFF_AMOUNT`) і НЕ проходить `INCOME_WHERE`. `SPEND_COUNT` рефанди НЕ рахує — інакше
  середній чек ділився б на більшу кількість.
  **Чому:** `INCOME_WHERE` був просто `amount > 0` — скасування покупки («Скасування. <мерчант>»)
  їхало в ДОХІД, а сама покупка лишалась повною витратою своєї категорії. Тобто одна скасована
  операція завищувала ОБИДВІ сторони звіту. На реальних даних завищення доходу було відчутним —
  саме воно й змусило перевірити цю гілку.
  ⚠️ Категорія мусить ІСНУВАТИ: `COALESCE(..., 0)` зробив би рефандом звичайний вхідний P2P-переказ
  від людини.
  ⚠️ `INCOME_WHERE` тепер виключає й бакет 13 (симетрично до `SPEND_WHERE`): надходження-перекази
  з `is_transfer=0` (виплата з банки, переказ між власними картками) рахувались доходом, хоча їхня
  вихідна сторона вже виключалась — саме ця асиметрія давала більшу частину завищення.
  ⚠️ `categoryMonthlyLevels` має підлогу 0: місяць може вийти від'ємним, якщо повернення перевищило витрати.
- **Витрата:** `amount<0` (або рефанд, див. §REFUND), `transfer_pair_id IS NULL`, НЕ (`is_transfer=1 AND real_category_id IS NULL`), ефективна категорія `IS NOT 13` («Перекази і зняття»). **Holds рахуються** (mono надсилає лише виконані; коли hold закривається — той самий `id` перезаписується, тож без подвійного рахунку). Прапорець `hold` лишається на рядку для UI-бейджа «в обробці». *(Раніше `hold=0` різав свіжий тиждень у репорті — виправлено 2026-07-10.)*
- **Ефективна категорія** = рол-ап `real_category_id` (готівка/зняття за реальною суттю), інакше рол-ап `category_id`. Хелпери: `EFF_CAT_*`, `SPEND_WHERE`, `INCOME_WHERE`, `STATS_JOINS`, `spendSum/incomeSum/amountSum`, `uahMult` (₴-зведення inline-CASE з курсів), `valueMode` (₴ або «чиста» валюта), `periodBounds/currentPeriodToDate/lastCompletePeriod`.
- **Вагомість (§6):** `EFF_IMPORTANCE` = `COALESCE(t.importance, рол-ап importance ефективної категорії, 'discretionary')`. Рівні `essential|discretionary|optional`. Задається на категорії (дефолт) + override на транзакції. Міграція 0016.
- **Разові vs регулярні (§E1):** `isRecurringExpr` — операція регулярна, якщо прив'язана до плану (`planned_id IS NOT NULL`, напр. квартальна підписка) АБО її мерчант має витрати у ≥3 різних місяцях трейлінг-вікна. `recurringOneoffSplit()` дає {recurring, oneoff, oneoff_items}.
- **Місячний рівень категорії — `categoryMonthlyLevels()` (ЄДИНЕ джерело, 2026-07-12).** Один «скільки на місяць» на категорію, узгоджений скрізь (Патерни `usual`, Порадник/Бюджети `avg_month_uah`): fixed-кости (рента/підписка — останні 2-3 повні міс стабільні, CV≤0.12) → рівень = середнє останніх платежів (ловить стрибок ціни, коли орендодавець підняв ставку: 6-місячне середнє тягнуло б рівень до старої ціни ще півроку); змінні категорії → середнє за вікно (не хапає випадковий пік). Рахує лише по ПОВНИХ місяцях. Замінив розсинхрон «6-міс середнє / 90д÷3 / останній платіж». НЕ рахувати місячну суму категорії деінде вручну — брати звідси. **§A1 (2026-07-19):** наприкінці функції — `applyFactAdjustments()`: ПІДТВЕРДЖЕНІ факти (`facts.confirmed_at IS NOT NULL`, активні на `now`) коригують рівень (multiplier ×/ delta_minor +). Це ЄДИНЕ місце, де факт рухає число (не в ендпоінті) — тож burn/runway/Патерни/чат лишаються узгодженими.
  **§A1-WRITE (2026-08-12): a fact is created by `addFact` (`lib/ai/facts.ts`) ALONE.** There were
  two writers — that function and a private `INSERT` inside the `remember_fact` tool
  (`chat-tools.ts`) — with the same column list and different defaults: exactly the shape §CUR-PLAN
  and §REFUND grew out of (one concept, two implementations, drifting where nobody looks). The
  difference is now ARGUMENTS: `source: "user" | "ai_proposed"` and `confirm`. ⚠️ `confirm` is not
  a preference but the GATE itself: `confirm: true` means a human typed the number, so a
  model-authored fact ALWAYS passes `confirm: false` — otherwise a guess would silently move burn
  and runway. Held by `writes.test.ts` (6 scenarios: both writers, the confirmation gate, a global
  fact carrying no adjustment, and an unknown category or empty text writing nothing).
- **Бюджети-конверти (ліміт ↔ витрачено ↔ прогноз) — `budgetStatus(env, mult, now)`**
  (`lib/finance/budgets.ts`, ЄДИНЕ джерело; 2026-07-31, переїхало зі `stats.ts` 2026-08-12).
  Витрата — канон (`STATS_JOINS` + `SPEND_WHERE` + `amountSum`), рол-ап у батька, місяць від його
  першого дня. **Не рахувати «скільки з бюджету зʼїдено» деінде вручну.**
  Читають: стрічка (`drafts-budget.ts`), тижневий TG-пуш (`proactive.overBudget`),
  пер-транзакційний алерт (`alert.budgetBreach`) і `GET /budgets/status` → `EnvelopeGrid`. Кожен
  колись мав власну версію цього числа.
  ⚠️ **ТРЕТЮ копію знайдено аж 2026-08-21** — `alert.ts`, у тій самій папці, що й виправлена
  2026-07-31, з тими самими вадами слово в слово (`t.currency_code = 980`, без сплітів, без
  компенсацій, без перенесення). Спільна папка не означає, що прохід її накрив.
  ⚠️ **Клієнт більше НЕ виводить його сам** (2026-08-12): `EnvelopeGrid` склеював `/budgets` з
  `/analytics/by-category` — третє визначення того, чим уже володіє сервер. Тепер компонент лише
  малює.
  - **§BUDGET-MEMORY (2026-08-14, міграція 0043): конверт ПАМʼЯТАЄ минулий місяць.**
    `budgets` — один рядок на категорію, без місяця й без історії, тож конверт умів сказати лише
    «зараз 70%»: ні «ти закрив липень із запасом», ні — головне — «стало краще». Нова таблиця
    `budget_months(ym, category_id, limit_minor, carry_in_minor, spent_minor)`: рядок на закритий
    місяць, `closeBudgetMonths` у ДОБОВОМУ проході, `INSERT OR IGNORE`.
    ⚠️ **`budgets.rollover` існував із міграції 0017 і НІЧОГО не робив** — `budgetStatus` його не
    читав, а сторінка Плану виводила перенесення в КЛІЄНТІ з `/analytics/by-category` минулого
    місяця. Тобто План показував один ефективний ліміт, а сітка конвертів, стрічка й пуш у Telegram
    — інший, для того самого конверта (§CUR-PLAN у чистому вигляді). Тепер перенесення живе в
    `budgetStatus`: `amount` = ЕФЕКТИВНИЙ ліміт (`base_amount + carried`), тож усі читачі
    отримують його, не знаючи правила. **Не рахувати перенесення в компоненті.**
    ⚠️ **Перевитрата переноситься так само, як залишок** (`carried` буває ВІДʼЄМНИМ). Клієнтська
    версія робила `max(0, …)`: зекономлене переносилось, перевитрачене — ні, і конверт ставав грою,
    у якій не можна програти.
    ⚠️ **Стеля ±базовий ліміт, симетрична.** Без верхньої шість ощадливих місяців роздувають конверт
    до суми, яка вже нічого не обмежує; без нижньої один зрив ховає конверт на пів року, і в нього
    просто перестають дивитись.
    ⚠️ **Немає закритого місяця — немає перенесення, і воно НЕ виводиться з транзакцій.** Ліміт
    минулого місяця ніде не зберігався, тож «перенесено 800 ₴» означало б «за СЬОГОДНІШНІМ лімітом»,
    і кожна правка ліміту мовчки переписувала б історію. З тієї ж причини старіші місяці не
    добираються заднім числом: смуга історії наростає з моменту ввімкнення.
    ⚠️ **Закриття — у ДОБОВОМУ крон-проході, не в місячному.** Місячний ходить рівно раз, 1-го: якщо
    саме той прогін упав, місяць не закрився б ніколи, а ланцюг обірвався б назавжди — при тому що
    обидва конверти виглядали б нормально. Стоїть ПЕРЕД `notifications`: події бюджету читають
    `budgetStatus`, і 1-го числа інакше оголошували б конверт до того, як він отримав перенесення.
    ⚠️ **Закритий місяць — ЗАПИС, а не живий запит:** повторне закриття не переписує `spent_minor`,
    бо стара операція, перекатегоризована через місяці, зрушила б ланцюг перенесень заднім числом.
    ⚠️ **Автобюджет тепер знає, чи ліміт КОЛИСЬ тримався** (`repo/budgets.ts` `trackRecord`,
    вікно 6 закритих місяців). Провалено в половині — `trim` знімається (`basis: "missed"`), бо
    «витрачай на 10% менше» тому, хто рівно цю ціль не виконав чотири місяці поспіль, — це
    застосунок, що повторює вже спростоване число. Провал НЕ піднімає ліміт до факту (це був би
    план, що погоджується з будь-якими витратами) — він лише прибирає урізання. Мінімум 2 закритих
    місяці: один — це анекдот. `basis`/`months_closed`/`months_over` їдуть у відповідь, бо рядок,
    що мовчки перестав урізатись, читається як баг.
    ⚠️ **`setMonthlyBatch` більше НЕ скидає `rollover`** — писав літеральний `0`, тож прийняття
    автобюджету тихо вимикало §BUDGET-MEMORY на кожному зачепленому конверті. Зміна ліміту не є
    дозволом скинути налаштування, яке рядок ніс.
    ⚠️ **«Чи я взагалі тримаю план» — `budgetHistory(env)`** (2026-08-21, `GET /budgets/history`,
    картка на `/plan`). Таблиця мала двох читачів, і кожен викидав більшу частину: `trackRecord`
    зводить конверт до співвідношення, сторінка категорії малює ОДИН конверт. Місяць судиться по
    ПЛАНУ ЦІЛКОМ (сума проти суми — конверт, перевитрачений на 200 ₴, поруч із заощадженими 900 ₴
    це місяць, який утримався); `kept_envelopes` їде поруч для тоншого читання. Серія рахується
    НАЗАД від останнього закриття, бо питання — «чи тримаю ЗАРАЗ».
    ⚠️ **Закритий місяць у ₴ треба КОНВЕРТУВАТИ на читанні** — `budget_history` на
    `/categories/:id/overview` віддавав `limit_minor` сирим, тобто смуга історії й конверт над нею
    на одній картці були в різних валютах. Sweep цього не бачив: у фікстурі не було закритих
    місяців, а відсутнє поле не тече. Тепер є.
    Тримається `budget-memory.test.ts` (21 сценарій).
  - **§BUDGET-ZERO (2026-08-14): ліміт 0 — це ПЛАН, а не відсутність конверта.**
    «Конверта тут немає» і «сюди я свідомо не витрачаю» — різні твердження про гроші, а API вміло
    лише перше: `amount <= 0` видаляло рядок, тож друге було невимовним і на кожному екрані
    виглядало однаково. Тепер **наявність рядка = конверт**, а `amount = 0` — справжній ліміт.
    ⚠️ **Прибирання конверта стало ОКРЕМИМ дієсловом** — `DELETE /budgets/:categoryId`. Доти
    «прибрати» писалось введенням нуля, тобто рівно тим реченням, яке фіча дозволяє сказати.
    ⚠️ **Відʼємний ліміт ВІДХИЛЯЄТЬСЯ (400), а не затискається в 0**: затиснути означало б сховати
    баг того, хто рахував, за конвертом, що виглядає свідомим.
    ⚠️ **У нульового конверта немає відсотків.** `ratio` бінарний: 0 або 1 — «80% від нуля» це не
    величина. Смуга-доріжка не малюється зовсім (повна червона смуга поруч із «витрачено 40 ₴»
    читалась би як досягнутий ліміт 40 ₴, а не як зламаний ліміт 0), а `projected_ratio` дорівнює
    `ratio`: прогноз на категорію, у якій людина вирішила не витрачати, — це відсоток від рішення.
    ⚠️ **Порожнє поле ≠ нуль** (клієнт): нуль треба НАБРАТИ. Інакше той, хто відкрив редактор і
    нічого не ввів, отримав би обіцянку, якої не давав.
    ⚠️ Rollover на нульовому конверті не показуємо: перенесення затиснуте в ±базовий ліміт, тобто
    ±0 — це знову був би контрол, що нічого не робить (та сама вада, що `budgets.rollover` до
    §BUDGET-MEMORY). Тримається `budget-memory.test.ts` + 3 сценаріями в `writes.test.ts`.
  - **§BUDGET-FORECAST (2026-08-12): конверт каже, де місяць ЗАКРИЄТЬСЯ.** `projected` рахує той
    самий `projectSpend`, що «Радар темпу», тож конверт і радар не можуть розійтись; лумп-правило
    теж спільне (`n ≤ 1 OR biggest ≥ 55%`, або несплачений fixed-кост). Доти бюджет був дзеркалом
    заднього виду: «перевищено» приходило тоді, коли вдіяти вже нічого не можна.
    ⚠️ **`lumpy` віддається назовні, а не ховається:** `projected === spent` означає дві різні
    речі, і UI, який їх не розрізняє, показав би «все гаразд» на оренді, яка просто ще не пішла.
    ⚠️ Сповіщення `budget_forecast` — **не раніше 10-го числа** (рано в місяці прогноз це майже
    сама історія), **не коли гроші вже витрачені** (`ratio ≥ 0.9` — там говорить `draftBudgets`,
    і дві події про один конверт за день це застосунок, що сперечається сам із собою), не для
    лумпа, і лише від **110% прогнозу + 200 ₴** перевищення. Один рядок на конверт на МІСЯЦЬ.
- **Норма заощаджень — `savingsRatePct(income, spend)` (`lib/finance/finance.ts`, 2026-08-21).**
  Мала ТРИ написання: AI-звіт (`savings_rate_pct`, який бачила лише модель), смуга на «Трендах»
  (рахувалась у клієнті) і жодного місця, де б їх щось зіставило. `null` при нульовому доході, а
  не 0: «0% заощаджено» — це вердикт про місяць, а місяць без доходу не підлягає оцінюванню.
  Живе у `finance.ts`, а не в `stats.ts`: той — SQL-канон і стоїть на стелі C3, а двохаргументне
  відношення це не SQL.
- **Місячний BURN (знаменник runway) — `sumLevels(levels)` = сума рівнів категорій (ЄДИНЕ джерело, P1 2026-07-14).** Замінив «витрати_90д ÷ 3» у Пораднику (`buildAdvice`), AI-бюджет-плані (`proposeBudgets`) і бюджет-чаті (`budgetChatReply`). Тепер «Витрати/міс» = сумі `usual` Патернів → одна цифра всюди; не роздувається разовими лумпами (податок/лікар — рівень їх усереднює/виключає), ловить стрибок fixed-косту одразу. `runway = ліквідна_подушка ÷ burn`. **Виняток:** `/analytics/forecast.projectedSpend` — це ІНША цифра (проєкція саме поточного місяця, з його разовими), її свідомо НЕ чіпали.
- **Прогноз темпу (`/analytics/patterns`) — `projectSpend()` (stats.ts):** прогноз кінця місяця = «вже витрачено + історичний залишок» (НЕ наївний `spent/elapsedFrac`, що роздував рано в місяці / лумпи). Лумпи (1-2 великі операції: податок/оренда/заправка — детект `n≤1 OR biggest≥55%`, або fixed-кост ще не сплачений) НЕ екстраполюємо; кеп 3× звичного. `usual` — з `categoryMonthlyLevels`. `mostly_oneoff`/lumpy — поза «Радаром аномалій». Агрегат `/analytics/forecast` — бленд поточного темпу з історією 3 міс. Стара логіка (elapsedFrac × регулярна частина) замінена.
- **§IMPORTANCE-TREND (2026-08-12): структура витрат ПО МІСЯЦЯХ** —
  `lib/finance/history.ts` `collectMonthlyHistory` + `repo/analytics.ts` `importanceByMonth`,
  віддається полями `essential`/`discretionary`/`optional` у `/analytics/monthly-history`.
  Періодні вкладки казали, яка частка ЦЬОГО місяця необовʼязкова; тренд відповідає на важливіше —
  чи вона РОСТЕ. Сама сума про це не каже: подорожчала оренда й розрослася доставка виглядають у
  ній однаково, а переглянути можна лише одне з двох.
  ⚠️ Три частки вичерпні за побудовою (`EFF_IMPORTANCE` має фолбек `discretionary`), тож у сумі
  дають `spend` — саме це дозволяє читати смугу як частку місяця. Тримається
  `consistency.test.ts`.
  ⚠️ `GROUP BY` — по ВИРАЗУ, а не по аліасу: у приєднаних `categories` є власна колонка
  `importance`, і голе імʼя робить запит неоднозначним (SQLite відмовляє). Спіймано тестом.
- **§CAT-PAGE (2026-08-14): сторінка категорії показувала ПОРОЖНЄ на реальних даних — три
  незалежні причини, і всі три мовчазні** (порожня сторінка виглядає точно як невживана категорія).
  ⚠️ **1. ПІДКАТЕГОРІЯ не збігалась ніколи.** `EFF_CAT_ID` навмисно віддає перевагу БАТЬКУ
  (`scp/rp/p` попереду) — на цьому стоїть уся агрегація. Тому `EFF_CAT_ID = <id підкатегорії>` не
  матчить нічого: рядки «Таксі» звітують як «Транспорт». Сторінка кожної підкатегорії була
  порожня — і батьківська сторінка ВЕДЕ на неї посиланням. Введено `EFF_CAT_LEAF_ID`
  (`COALESCE(sc.id, rc.id, c.id)`) — ефективна категорія БЕЗ рол-апу. **Це не другий канон: він
  відповідає лише на «в який лист упав цей рядок» і НЕ використовується для агрегації**, інакше
  спліт під підкатегорією перестав би котитись у батька.
  ⚠️ **2. ДОХІДНА категорія не мала що показати:** уся сторінка збудована на `SPEND_WHERE`, а в
  доходу витрат немає за визначенням — «Зарплата» показувала нулі над категорією, у якій лежить
  кожна зароблена гривня.
  ⚠️ **3. Вікно було лише «цей місяць»** — категорія, тиха в цьому місяці, виглядала як тиха
  назавжди.
  Рішення: `CatScope {id, isParent, isIncome}` резолвиться ОДИН раз і їде в кожен запит
  (`catWhere`/`catSum` у `repo/categories.ts`). Плюс `lifetimeStats`/`lifetimeMerchants` — вони
  НЕ залежать від вікна, тож порожній період більше не може виглядати як порожня категорія;
  перемикач періоду (місяць/3/рік/весь час); тренд 12 → 24 місяці (річний ритм — страховка,
  навчання — у 12-місячному вікні зʼявляється один раз і читається як разовий).
  ⚠️ **`per_active_month` ділить на місяці З АКТИВНІСТЮ, не на календарний проміжок:** категорія,
  якою користуються двічі на рік, інакше дістала б місячну цифру, якої в ній ніколи не було.
  ⚠️ **Канонічний рівень і конверт лишаються тільки там, де вони визначені** — верхньорівнева
  ВИТРАТНА категорія й вікно = поточний місяць. Інакше це було б число про ІНШУ категорію або два
  різні періоди в одній відповіді (та сама вада, яку §CATEGORY-PAGE уже виправляла).
  ⚠️ Той самий scope застосовано до drill (`lib/finance/category-drill.ts`): він припускав те, що
  завжди передає пончик Статистики, і під порожньою сторінкою малював порожній список — дві
  порожні секції з однієї причини. Дефолт зберігає стару поведінку, і тест це пінує.
  Тримається `category-page.test.ts` (9 сценаріїв).
- **§I18N-DYNKEY (2026-08-21): ключ перекладу, зібраний у рантаймі, невидимий для лінта
  парності — тож він мусить ОГОЛОСИТИ свої значення.** `t(`imp.${importance}`)` друкував сирий
  `imp.optional` на екрані: `imp.*` — це пара з двох записів, що належить `SafeToSpend`, третього
  не було в ОБОХ словниках, тож парність мовчала, а `tsc` бачить лише каст до члена юніону.
  `check-i18n` тепер тримає таблицю `DYNAMIC_KEYS` (префікс + повний набір значень + дата +
  причина) і перевіряє кожне значення як звичайний ключ; **неоголошений динамічний префікс —
  падіння**. Набір значень звіряй із КОДОМ (`GOAL_KINDS`, `GoalStatus`), а не з памʼяттю: перший
  список, написаний по памʼяті, промахнувся двічі.
  ⚠️ Кращий варіант, коли він є, — резолвити через мапу (`IMPORTANCE_META`), а не через конкатенацію.
- **§CAT-PARTS (2026-08-21): сторінка батьківської категорії каже, З ЧОГО вона складається.**
  Один запит: рядки вибираються рол-ап-матчем (`EFF_CAT_ID` — та сама популяція, що й усі інші
  числа сторінки), а групуються по ЛИСТУ (`EFF_CAT_LEAF_ID`). ⚠️ **Власні рядки батька — така сама
  частка (`self`), а не залишок:** «74% цієї категорії лежить напряму, без підкатегорії» — це факт
  про те, як ведеться облік, і в списку самих дітей його не існує. Частки — від суми частин, тож
  вони СХОДЯТЬСЯ в підсумок сторінки (тримається `category-page.test.ts`).
  ⚠️ Діти без витрат у вікні лишаються чіпами: до підкатегорії, тихої цього місяця, треба вміти
  дійти — інакше це §CAT-PAGE у меншому масштабі.
  ⚠️ **Тренд починається з ПЕРШОЇ операції категорії, а не за 24 місяці.** Нуль до неї — це «акаунта
  ще не було», а не «нічого не витрачено»; zero-fill ВСЕРЕДИНІ історії лишається (тихий місяць між
  двома активними — справжня точка).
- **§CATEGORY-PAGE (2026-08-12): у категорію тепер можна провалитись** — `/categories/:id`,
  дані з `GET /categories/:id/overview` (канонічний місячний рівень, тренд 12 міс, конверт,
  разові/регулярні). Входи — з плитки конверта й зі списку категорій.
  ⚠️ Вікно за замовчуванням — МІСЯЦЬ, а не ковзні 30 днів: `budgetStatus` місячний за визначенням,
  тож при 30 днях дві половини ОДНІЄЇ відповіді описували б різні періоди.
- **§CADENCE (2026-08-01, на екран 2026-08-21): «дельта — це зміна чи календар» вирішує
  `lib/finance/cadence.ts`, ЄДИНЕ джерело.** Період, коротший за `SHORT_PERIOD_DAYS` (28), не може
  чесно порівняти категорію, яку списують раз на місяць: платіж потрапляє в одне вікно й не
  потрапляє в сусіднє, і «підписки −92%» — це 1-ше число по інший бік межі. Осмислено лише коли
  з ОБОХ боків ≥2 списання (`deltaMeaningful`); лічильник — `SPEND_TX_COUNT`, ніколи `SPEND_COUNT`
  (той множить спліт).
  ⚠️ **Правило жило ІНЛАЙНОМ у `report.ts`, тобто діяло лише для моделі.** Той самий `−92%`
  спокійно малювався людині на вкладках Порівняння й Категорії — у кольорі, бо дельту рахував
  клієнт (`r.a - r.b`) двома копіями. Тепер `/analytics/compare` віддає ЗЛИТІ рядки (`rows`) і
  `movers`, а компоненти лише сортують і ріжуть.
  ⚠️ **Поріг шуму — сума, тож він у ₴ і конвертується** (`MOVERS_FLOOR_UAH_MINOR` + `uahToBaseMinor`).
  В обох копіях стояв голий `5000`: 50 ₴ для власника і $50 для того, хто читає в доларах.
  ⚠️ **Неосмислена дельта ПОКАЗУЄТЬСЯ, але без кольору** (`.cmp-delta.timing`): ховати рядок
  означало б сховати справжні гроші, а зелений «−92%» — це застосунок, який вітає з календарем.
  Тримається `cadence.test.ts` (8 сценаріїв).
- **§FX-COST (2026-08-21): скільки коштувала КОНВЕРТАЦІЯ — `lib/finance/fx.ts`.**
  Обидві половини закордонної покупки лежать у базі з липня (`original_amount` у валюті магазину,
  `amount` у валюті рахунку), офіційний курс — у `rate_history` (0024). Їх ніхто не порівнював, а
  різниця — це комісія, зашита в ціну кожної покупки, і єдина в застосунку, якої немає окремим
  рядком ніде.
  ⚠️ **Кожна сторона оцінюється курсом СВОГО дня**, і порівняння робиться в ₴, а в базу читача
  конвертується ОДИН раз наприкінці. Інакше рух курсу між покупкою й сьогодні поїхав би у
  відповідь як банківська націнка — рівно та помилка, заради якої фіча й читає історію курсів.
  ⚠️ **День без збереженого курсу ПРОПУСКАЄТЬСЯ і рахується** (`unpriced`), ніколи не добивається
  поточним курсом: вигадана комісія читається точно так само, як справжня.
  ⚠️ Без `STATS_JOINS` навмисно: конвертація сталась із ЦІЛОЮ транзакцією один раз, тож питати про
  половинки спліту — це питати те, на що банк не відповідав. Тримається `fx-cost.test.ts` (8).
- **§SHAPE (2026-08-27): три питання про ФОРМУ періоду, а не про його розмір** —
  `lib/finance/spending-shape.ts` + `GET /analytics/spending-shape`, блок на вкладці «Тренди».
  Усе інше на Статистиці відповідає «скільки й куди»; два місяці з однаковим підсумком і
  однаковими категоріями можуть бути зовсім різними місяцями, і різниця — саме те, з чим можна
  щось зробити:
  • **розмір чека** — кілька великих платежів чи сотня дрібних? Ліки протилежні, підсумки
    однакові, а середній чек і максимум — рівно ті дві цифри, що це ховають;
  • **поза конвертами** — `/plan` показує конверти, які Є; ніде не було сказано, яка частка грошей
    не проходить через жоден. Усі конверти зелені, а більшість витрат — повз них;
  • **без категорії** — у ГРОШАХ. Стрічка рахує операції, але десять дрібних і десять великих —
    різна міра сумніву, а це та частка, якої не покриває жодне інше число на сторінці.
  ⚠️ **Одиниця бакета — ЦІЛА транзакція, а не частка спліту** (`-t.amount`, дедуп `GROUP BY t.id`).
  Платіж 3 000 ₴, розкладений на три категорії, — це один чек на касі; бакетувати його частини
  означало б показати три дрібні покупки, яких ніхто не робив. Тому це єдиний канонічний запит,
  що НЕ сумує `EFF_AMOUNT`; `STATS_JOINS` лишається тільки щоб популяція `SPEND_WHERE` збігалась
  із рештою сторінки.
  ⚠️ **Рефанд — не чек відʼємного розміру** (`t.amount < 0`): він навмисно проходить `SPEND_WHERE`
  (§REFUND — має ВІДНІМАТИСЬ від підсумку), але розміру в нього немає.
  ⚠️ **Межі бакетів — у ₴ і конвертуються** (`CHEQUE_STEPS_UAH_MINOR` + `uahToBaseMinor`), як
  `MOVERS_FLOOR_UAH_MINOR` у §CADENCE. Вони НАВМИСНО круглі, а не виведені з даних: межа, що
  рухається з місяцем, робить два місяці незрівнянними — а саме заради порівняння блок і існує.
  ⚠️ **Нульовий ліміт — це конверт** (§BUDGET-ZERO): рахувати таку категорію як «без плану»
  означало б назвати прийняте рішення його відсутністю.
  ⚠️ **`NULL NOT IN (…)` — це NULL, а не true.** Операція БЕЗ категорії поза конвертами за
  визначенням, але тризначна логіка тихо викидала її з числа, яке саме це й міряє. Результат
  виглядав цілком правдоподібно: менше число, що при цьому рухалось разом із даними.
  Тримається `spending-shape.test.ts` (9 сценаріїв).
- **§WEEKDAY — витрати за днями тижня (2026-08-07): `lib/finance/weekday.ts`, ЄДИНЕ джерело.**
  Дві речі, без яких графік бреше, і обидві живуть у домені, а не в роуті:
  (а) **день тижня береться в `APP_TZ`** (`localDowSql`, не голий `strftime('%w')`) — у UTC кожна
  покупка після 21:00 їде в НАСТУПНИЙ день тижня, а вечір пʼятниці і є найгустішим часом витрат,
  тож помилка виглядала б не як помилка, а як «субота дорога»;
  (б) **ділимо на кількість таких днів у вікні** (`weekdayCounts`) — у місяці пʼятниць 5, а субот
  4, тож сирі суми порівнювати не можна. `typical = spent / days` рахує сервер, щоб екран і
  AI-контекст не отримали двох різних чисел про одне й те саме.
  ⚠️ **`busiest` рахується лише серед НЕ-лумпових днів** (той самий поріг 55%, що в
  `projectSpend`): оренда, що впала на неділю, не робить неділі дорогими — вона робить неділю
  днем, коли списується оренда.
  ⚠️ **Порадник бачить ТІ САМІ дані** (`collectFinanceSnapshot.weekday`, той самий
  `spendByWeekday`) — інакше екран і AI назвали б різні «найдорожчі дні», і це читалося б як
  помилка в одному з них, а насправді було б двома визначеннями одного числа.
  ⚠️ **Той самий канон по ЧИСЛУ МІСЯЦЯ** (2026-08-21): `localDomSql`, `domCounts`,
  `buildDomAnalytics` → `GET /analytics/day-of-month`. Обидва блоки на вкладці «Тренди» рахувались
  У КЛІЄНТІ з денних бакетів `strftime('%Y-%m-%d')`, тобто в UTC і сирими сумами — кожна покупка
  після 21:00 їхала в наступний день, а 31-ше виглядало дешевим, бо у 90-денному вікні їх менше.
  Канонічна відповідь при цьому вже була на екрані поруч (`WeekdaySpend`) і в контексті порадника.
  `first_five_share_pct` називає, скільки місяця витрачено ще до того, як про це щось вирішили.
  Тримається `calendar-shape.test.ts` (6 сценаріїв — доти §WEEKDAY не мав жодного).
- **§HABITS — що зʼявилось у регулярних витратах і що замовкло (2026-08-07):
  `lib/finance/habits.ts`, ЄДИНЕ джерело.** Дивиться на те, що банк РЕАЛЬНО списував, а не на
  `planned_payments` — тобто ловить саме те, чого користувач ніде не заводив, а це і є регулярний
  платіж, якого ніхто не відстежує.
  Пороги (кожен має причину, тримається `worker/test/habits.test.ts`, 8 випадків):
  • **нове** = списувалось у ≥2 з 3 останніх ПОВНИХ місяців і в 0 із 3 попередніх. Два, а не
    один: одне списання — це покупка, і список, що зве кожну покупку новою підпискою, — шум;
  • **замовкло** = було у ≥3 із 6 попередніх місяців і в 0 за 2 останні повні. Два місяці тиші
    довші за будь-який місячний цикл, тож це скасування або платіж, що не пройшов, а не «списали
    2-го замість 30-го».
  ⚠️ **Поточний місяць виключено скрізь**: півмісяця даних виглядає точнісінько як «мерчант зник».
  ⚠️ `monthly` — середнє за ті місяці, коли РЕАЛЬНО списувалось, а не за вікно: інакше мерчант,
  що почався два місяці тому, виглядав би втричі дешевшим (та сама логіка, що `typical` у §WEEKDAY).
- **Реконструкція нетворту — `lib/finance/networth.ts`** (винесено з роуту 2026-08-07): рахунки
  йдуть НАЗАД поокремо (знак вирішує, чи рахунок у подушці, чи в боргу, тож зводити до
  реконструкції не можна), а cushion/debt/investment складаються ТИМ САМИМ правилом, що
  `fundsBreakdown` (§R3) — інакше «зараз» на графіку не збіглося б із Порадником.
- **Період:** `app_state.period_mode` (`calendar`|`rolling`), перемикач у Статистиці; Головна й Статистика рахують ОДИН період.

## 🧠 Категоризація (детермін.-first, AI-last)
Порядок у `categorize()`/`enrich()`: 1) навчений `merchant_alias` (точний опис) → 2) активна підписка (мерчант+сума+валюта, `subscriptions.ts`) → 3) консенсус мерчанта (корінь назви ≥3× ≥80% в одну кат.) → 4) `mcc`/`text` rules → 5) AI-enrich (Haiku, з `known_subscriptions`-нюджем).
- **Alias source (0014):** колонка `source` (`manual`|`ai`). `learn`→manual; enrich→`writeAiAlias` НІКОЛИ не перетирає manual; авто-ре-світ пропускає manual; консенсус важить ручні ×3.
- **§RULES-UI (2026-08-12): крок 4 (`rules`) нарешті редагується з застосунку.** Таблиця існує з
  міграції 0001, але писати в неї могли лише сід і каскад видалення категорії — правило додавалось
  ВИКЛЮЧНО руками в БД. Тепер `/rules/*` (CRUD + `POST /rules/preview` + `POST /rules/:id/apply`),
  картка на сторінці Категорій.
  ⚠️ **Превʼю — це не зручність, а запобіжник:** правило — це стояча інструкція про гроші, яких ще
  немає, тож єдиний чесний спосіб його оцінити — прогнати по минулому. Кнопка «Зберегти» замкнена,
  поки не натиснуто «Перевірити».
  ⚠️ **`apply` чіпає ЛИШЕ операції без категорії.** Правило — це здогад про текст, а збережена
  категорія це рішення (MCC банку, навчений alias, AI-enrich або сама людина); перезаписати їх
  підрядком означало б, що застосунок мовчки сперечається з уже зробленою роботою.
  ⚠️ **Текст, по якому матчить `text`-правило, — ОДИН для рушія й для превʼю:** сира банківська
  `description` + `comment`. Рушій будує його в JS (`categorize`), превʼю — тим самим виразом у SQL
  (`textHaystack`, `repo/rules.ts`, через `json_extract(raw_json,'$.description')` з фолбеком на
  `merchant` для ручних/CSV). **Розійшлись у день релізу фічі:** превʼю шукало по ПОТОЧНОМУ
  `merchant`, який AI-enrich переписує на чисту назву («Silpo»), а рушій — по сирому опису
  («SILPO 1234 KYIV». Людина писала правило по тому, що бачить на екрані, бачила збіг, зберігала —
  і воно не спрацьовувало ніколи. Заразом `comment` додано в матчинг: у P2P-переказу опис — це
  просто чиєсь імʼя, а сенс лежить у коментарі.
  ⚠️ Порядок лишився `categorize()`: `mcc` → `text`, обидва за спаданням `priority`. Щоб побити
  заводське MCC-правило, юзер створює власне `mcc` із пріоритетом > 10 — саме тому міграція й
  окремий `source`-стовпчик не знадобились.
  Тримається 6 сценаріями у `writes.test.ts` (створення, три відмови валідації, apply-лише-без-
  категорії, видалення).

## 💸 AI-модель і вартість
- Ціни за MTok: **Haiku $1/$5, Sonnet $3/$15, Opus 4.8 $5/$25.** Cache read ≈0.1× input, write ≈1.25–2×.
- **Лічильник** (`app_state.ai_usage`, міграція 0010): `recordUsage` акумулює usage+вартість у `callHaiku`/`callHaikuMessages`; `GET /ai-usage`; картка «💸 Витрати на AI» в Налаштуваннях.
- **Задачі-моделі:** `report`/`advisor`/`insight`/`chat`/`budget`/`group`/**`notify`** (спостереження у стрічці сповіщень, дефолт Haiku, ≤1 виклик/добу).
- Реалістично ~$1–2/міс на Sonnet-гібриді; user-facing на Opus ≈ $1.5–3/міс. Модель-за-задачею через `MODEL_SMART` в `ai.ts`.
- **The requested SHAPE of an answer must match the output budget it will be given (2026-08-08).**
  The demo asked for a four-part structured answer («висновок → числа → 2-4 кроки») while
  `demoClamp` pinned output at 900 tokens with continuation disabled — a contradiction that
  guaranteed a reply stopping mid-sentence, which reads as the app breaking rather than as a
  sandbox limit. The demo prompt now asks for ≤120 words, no charts, no unfinishable lists, and the
  chat screen says so (`chat.demoShort`). ⚠️ The override lives in the DYNAMIC block, not in
  `stableRules`: that block is byte-identical across calls and users so the 1h prompt cache holds,
  and a demo branch inside it would split the cache in two for one paragraph.
- **Стеля виводу чату — 4000 токенів + ОДНА до-генерація** (`CHAT_MAX_OUTPUT` у `tasks.ts`,
  `stop === "max_tokens"` у `runToolConversation`). Було 1500 — і структурована відповідь
  («висновок → числа → 2-4 кроки») українською регулярно обривалась на півслові. Доти це виглядало
  як «коротка відповідь», а зі стрімом читач бачить обрив наживо й читає його як падіння застосунку.
  `max_tokens` — це СТЕЛЯ, а не рахунок: підняття не коштує нічого на відповідях, що й так
  вкладались. ⚠️ До-генерації НЕМА в демо: `demoClamp` тисне до 900, тож продовження впреться в ту
  саму стіну й купить другий рахунок за ту саму обрізану відповідь (те саме правило, що для `capped`).
- **§PUSH (2026-08-08): браузерні сповіщення, і пуш НЕ НЕСЕ ДАНИХ.** Порожній wake-up, а текст
  сервіс-воркер забирає сам (`GET /api/notifications`) уже по сесії користувача. Тобто жодне
  речення про чиїсь гроші не проходить через інфраструктуру Google/Apple, а `p256dh`/`auth`
  підписки СВІДОМО не зберігаються — вони існують лише щоб шифрувати payload, якого нема, і
  таблиця без них не варта крадіжки. Побічно: SW показує АКТУАЛЬНИЙ стан, тож прочитане на
  ноутбуці не дзвонить на телефоні через десять хвилин. Ціна названа: wake-up марний офлайн, і SW
  МУСИТЬ показати щось навіть коли fetch впав (інакше браузер сам напише «сайт оновився у фоні»).
  ⚠️ Два канали — **дві окремі позначки** (`pushed_tg_at` / `pushed_web_at`). Зі спільним прапорцем
  який канал спрацював першим, той і «зʼїв» подію, а другий не знайшов би чого слати.
  ⚠️ Доставка живе в `lib/messaging/deliver.ts`, а не в `notify.ts`: перший ВИРІШУЄ, що варто
  сказати, другий — як воно долетить. Розділення форсив лінт C3 (файл переріс виняток), і це саме
  той випадок, заради якого лінт існує.
  VAPID: `scripts/gen-vapid.mjs` → два Worker-секрети. **Ротація ключів мовчки відписує всіх** —
  підписка браузера привʼязана до публічного ключа, і після зміни push-сервіс і далі відповідає
  201, а браузер ігнорує. Тримається `worker/test/webpush.test.ts` (5 сценаріїв; підпис
  перевіряється справжнім верифікатором — Web Crypto підписує raw r||s, і саме тут це ламається
  при портуванні).
- **§STREAM (2026-08-07): відповідь чату ТЕЧЕ до читача.** Стрімінг живе в ТРАНСПОРТІ й вмикається
  наявністю колбека `onText` — `callHaikuMessages`/`callMessagesRaw` шлють `stream: true`, а
  `readStream` збирає SSE назад у ТУ САМУ форму `{content, usage, stop}`. Тобто ані цикл
  tool-use, ані `demoClamp`, ані лічильник вартості не знають, що байти прийшли частинами, і
  другого кодового шляху не існує.
  ⚠️ **Стрімляться ВСІ ходи tool-циклу, не лише останній:** який хід фінальний, стає відомо лише
  після того, як він відповів, тож чекати на це означало б повернути ту саму паузу.
  ⚠️ **Формат до клієнта — NDJSON, не SSE** (`POST /api/advisor/chat/stream`): тут не потрібні ні
  типи подій, ні реконект, ні last-event-id, а `EventSource` взагалі не вміє POST з тілом. Помилка
  ПІСЛЯ першого байта не може змінити статус (він уже 200) — тому вона їде рядком `{error}` і
  показується читачеві реченням, а не мовчазним обривом.
  ⚠️ Наприкінці сервер шле `{done, reply}` з ПОВНИМ текстом, і клієнт замінює ним накопичене:
  півречення, яке виглядає як закінчене, гірше за помилку.
  Парсер покритий `worker/test/ai-stream.test.ts` — межі чанків рубляться по БАЙТАХ (кирилиця =
  2 байти, тож розрив усередині літери — норма, а не край).
  ⚠️ **Smooth reading is a steady RATE, not a bounded interval (2026-08-08).** Batching deltas per
  animation frame was not enough: a frame drew everything that had arrived since the last one, so
  the model's jitter just moved from the delta to the frame — one frame a character, the next a
  paragraph. `Chat.tsx` now reveals a SHARE of the backlog per frame (`REVEAL_SHARE`, floor
  `MIN_REVEAL`), draining bursts exponentially; arrival rate sets how full the buffer is, not how
  the text lands. New markdown blocks additionally fade in (`.chat-msg.live > *`) — pacing smooths
  text growing inside a paragraph, but a new paragraph is a whole shape arriving at once.

## ✅ Зроблено — у `HISTORY.md`

Повний журнал «що зроблено в якому раунді» живе в `HISTORY.md` (він вантажився в контекст
щосесії й займав більше половини цього файлу). Durable-правила з нього — нижче.

## 📐 Правила, здобуті з реальних багів

> Кожне куплене падінням у проді. Порушити котресь = відтворити той самий баг.

**Числа й графіки**
- **Календар рахується в `APP_TZ` (Europe/Kyiv), НЕ в UTC (§APP_TZ, 2026-08-01; повний прохід
  2026-08-21).** Рантайм воркера живе в UTC, тож `new Date(x).getMonth()/getDate()/getDay()`
  віддають частини дати в UTC: о 02:46 1 серпня Статистика чесно показувала ЛИПЕНЬ при будь-якому
  типі періоду, бо в UTC це ще 31 липня. Щоночі з 00:00 до 03:00 застосунок був на добу позаду.
  **Правило: жодних `new Date(...).getMonth()` для меж періоду — лише
  `localMonthStart`/`localWeekStart`/`localDayStart`/`localYm`/`localParts`.** Живуть у
  **`lib/finance/time.ts`** (винесено 2026-08-21 під стелю C3) і ре-експортуються зі `stats.ts`,
  тож наявні імпорти незмінні. Зсув резолвиться на кожен момент окремо, тож літній/зимовий час
  обробляється сам.
- **`strftime` у SQL — теж локальний: `localFmtSql(now, fmt, col)`, а `localYmSql` — виклик у
  нього.** Це критично там, де ключі місяців будує JS, а групує SQL (`categoryMonthlyLevels`,
  спарклайни, тренди): промах по ключу читається як НУЛЬОВИЙ місяць і мовчки занижує рівень
  категорії. ⚠️ Свідома межа: береться зсув на момент запиту й застосовується до всього вікна,
  тож рядок з іншого боку переходу на літній час може потрапити не в свій місяць, якщо його час —
  у годинній смузі біля межі. Раніше розбіжність була повним зсувом зони (2-3 год) ЗАВЖДИ.
  ⚠️ **Прохід 2026-08-21 знайшов девʼять місць, куди правило так і не доїхало** — усі мовчазні,
  бо кожне малює правдоподібне число:
  • **бакети графіка** (`series`) були UTC усередині київського вікна: покупка після 21:00
    малювалась наступним днем, а перший стовпчик «календарного місяця» тримав три години
    попереднього;
  • **дрили** (`weekday`/`day`/`dom`) були UTC, тоді як графіки над ними — локальні: стовпчик
    казав одне число, а список за ним містив інший набір рядків. **Дрил МУСИТЬ брати той самий
    вираз і той самий момент, що графік** — інакше це виглядає як загублена операція;
  • **`isRecurringExpr`** і **`detectCandidates`** рахували місяці в UTC, а в обох поріг у місяцях
    (`≥3`, `≥2`) вирішує регулярність — тобто чи потрапить витрата в burn і чи запропонується
    підписка;
  • **усе, що модель знає про час**: `chatAdvice` називав їй дату в UTC, `parseToolDate` будував
    межі через `Date.UTC` (тобто «серпень» починався о 03:00), `query_spend` групував місяці сирим
    `strftime`. **Гола дата від моделі — це КИЇВСЬКИЙ настінний час** (`localWallTime`), те саме
    правило, що §BANK-PARSE ставить для виписки;
  • **лічильники**: `ai_usage` ключувався по UTC-добі поруч із `quota.ts`, який давно по
    київській; лічильник демо — по UTC, тоді як `demo_daily` про ТУ САМУ подію — по київській.
  Тримається `worker/test/app-tz.test.ts` (8 сценаріїв, зокрема наскрізний: покупка о 21:30 UTC
  лягає на 13-те, її дрилі знаходять саме її, а сусідній день тижня — ні).
- **Місяць графіка бери з явного `ym`, а не з timestamp.** Будь-який кінець періоду в UTC
  ламається на форматуванні в місцевому поясі: кінець червня о 23:59:59 UTC підписувався «лип.»
  у Києві — вісь дублювала категорію, крива з'їжджала, тултіп показував не той місяць.
- **Ширину осі Y не задавати числом** — лише `width="auto"` через `src/lib/chart.ts` `Y_AXIS`.
  Підігнана під поточні суми константа зрізає підпис, щойно число виросте на розряд, а **зрізану
  вісь неможливо відрізнити від справжнього числа**.

**AI**
- **§TIME-CTX (2026-08-27): the app never states a date it was not given.** The feed shipped «Rent
  due in 11 days, cushion covers only 0.8 months total» — for a rent the user pays on the 20th.
  Rent is not a `planned_payment`, so it was in no `upcoming_charges` row and had no date anywhere
  in the payload; the snapshot did not even carry TODAY. The model filled both gaps out of the
  user's own prose in `situation` («12500 кожного 20 числа»), which is background, not a schedule.
  ⚠️ **Every figure in that sentence was under 100** — below the floor of `numbersAreGrounded`, and
  therefore invisible to the guard that exists precisely for invented numbers. **A wrong day is
  worse than a wrong sum:** a sum is re-read against the screen beside it, a deadline is acted on.
  Single source — `worker/lib/ai/time-context.ts`: `buildTimeContext` produces BOTH the calendar
  handed over (`today`, `day_of_month`, `days_left_in_month`, `runway_days`, `time_note`) and the
  ANCHORS an answer is checked against, because those are one fact seen twice. `buildUpcomingCharges`
  moved there too — a charge now travels with its `date`/`on_day`, not only with a distance.
  ⚠️ **`timeClaimsAreGrounded` (`lib/ai/grounding.ts`) is the check** — day counts, days of the
  month and month NAMES, matched exactly (20 and 21 are different days). An EMPTY anchor set
  rejects every time claim: that is the honest reading of "we told it no schedule".
  ⚠️ `\b` is ASCII-only even under `/u`, so it never fires after «днів» — the Ukrainian half of the
  pattern matched nothing at all until a test caught it. Letter lookaheads, not `\b`.
  ⚠️ English "may" is deliberately NOT a month stem: a guard that discards every sentence with
  "may cost" is a guard someone deletes.
- **§AI-UNIT (2026-08-27): одиниця, про яку сказано моделі, мусить бути тією, яку їй дали.**
  `moneyUnitDirective` казав «мінорні одиниці», а КОЖЕН payload, який він супроводжує, — у ЦІЛИХ:
  `collectFinanceSnapshot.context` ділить усе на 100, і так само чинять інструменти чату
  (`Math.round(r.amt / 100)`). Модель, що має загальну інструкцію й конкретне поле, вірить полю —
  саме з цієї логіки директиву й написано, — тож хибною тут була САМА інструкція: слухняна модель
  занижувала все в 100 разів (12 500 ₴ оренди читались як ₴125). Пережило дванадцять аудитів, бо
  обидва прочитання — правдоподібні речення про гроші, і модель часто «дотягує» порядок назад:
  переміжно, а не завжди.
  ⚠️ **Одиницю й валюту називає РІВНО одне місце — `moneyUnitDirective`.** Десять промтів поруч
  писали «amounts in UAH» / «whole hryvnia», тобто називали валюту, якою payload може й не бути
  (§BASE-CUR), — і директива тут же наказувала моделі це ігнорувати. Прибрано звідусіль.
  ⚠️ Приклад у реченні («12500 означає 12 500, а не 125») — не окраса: «whole units» модель
  прочитує повз, число — ні.
  Тримається `worker/test/ai-units.test.ts` — твердження звіряється з РЕАЛЬНИМ знімком, а не з
  іншим реченням (інакше тест запінив би саму одруківку), плюс сканує `lib/ai/*` на повернення
  назви валюти в промти.
- **§AI-FEED (2026-08-27): the AI branch of the feed lives in `lib/messaging/drafts-ai.ts`** (lint
  C3, third time it named the right seam), and it now carries three checks the prompt alone had
  been asked to enforce — the same rule as §Правила «перевірка > інструкція»:
  ⚠️ **Language** — `scriptMatchesLocale`: the feed carried English HEADLINES over Ukrainian
  bodies, because the prompt's own STYLE example is an English headline and an illustration in a
  language outvotes a directive about language. Script ratio, not a word list — a Ukrainian
  sentence naming «Claude» and «Spotify» is correct.
  ⚠️ **Repetition in time** — `repeatsRecentTopic`: ONE shared content word (≥5 letters, minus a
  stoplist of words that name no topic). «Cushion lasts 24 days» and «Rent due in 11 days, cushion
  covers only 0.8 months» share exactly one word, and a threshold of two would pass the very pair
  the guard was written for. The stoplist is the load-bearing part; a word naming a category, an
  account or a merchant never belongs in it.
  ⚠️ **Repetition in the same RUN** — `already_announced_today`: the AI branch runs LAST and is
  handed the rendered titles of every deterministic event just drafted, so «Utilities bill jumped
  53% above budget» no longer lands beside the budget event saying exactly that. It had no way to
  know: the prompt forbade the duplication and never named what had fired.
- **Інструкція моделі — не гарантія. Якщо число з AI потрапляє в UI, поруч має стояти
  детермінована перевірка** (`numbersAreGrounded`, `lib/ai/grounding.ts`). Промт уже забороняв
  вигадувати суми — модель однаково видала дві різні цифри про одне й те саме в одному сповіщенні.
  ⚠️ **Правило стосується КОЖНОЇ поверхні, не тієї, де баг знайшли** (2026-08-21): запобіжник три
  тижні жив у `notify.ts` і не покривав `structured.facts[].amount`, який іде на картку Порадника
  й у TG-дайджест. Тому він тепер у `lib/ai/`, без «домашньої» поверхні.
- **Якщо коректність виводу залежить від слухняності моделі — підтримай і той формат, до якого
  вона тягнеться.** Промт просив `[table]…[/table]`, модель писала GFM (вона так навчена), і
  користувач бачив сирі `|------|`. Тепер рендеряться обидва.
- **Обмеження для демо став біля `fetch`, не біля виклику** — виклик-сайт про нього забуде.
  `getTaskModel` форсив Haiku, але три місця передавали модель константою й проходили повз;
  чок-поінт `demoClamp()` стоїть там, де реально йде запит.
- **Ліміти в штуках не обмежують рахунок.** Стеля має бути в тій самій одиниці, що інвойс
  (`DEMO_GLOBAL_DAILY_USD_CAP`), інакше «300 викликів» це від $0.30 до $4.

- **Порівняння періодів має знати РИТМ списань (§CADENCE, 2026-08-01).** Тижневий звіт оголошував
  обвал підписок на −92%: місячний платіж потрапив в одне вікно й не потрапив у сусіднє, а модель
  прочитала календар як поведінку. Тепер `report.ts` дає на КОЖНУ категорію
  `charges_n`/`prev_charges_n` (канонічний `SPEND_TX_COUNT` — `COUNT(DISTINCT t.id)`, бо
  `SPEND_COUNT` рахує рядки після `STATS_JOINS` і множить спліт), `monthly_usual_uah`
  (`categoryMonthlyLevels` — точка опори замість сусіднього тижня), `billing`
  (`monthly_fixed`|`variable`) і `delta_meaningful`. Той самий прапорець є на доході
  (`income_delta_meaningful`). **Правило: період, коротший за 28 днів, не порівнює категорію з
  ≤1 списанням з будь-якого боку — дельта там означає таймінг, а не тренд.**
- **Модель не знає, що вона вже казала (§NOVELTY, 2026-08-01).** Передавати три попередні
  `summary` було замало: звіт щотижня «відкривав» те саме («квартира забрала багато» — найбільша
  категорія найбільша завжди). Тепер у payload іде `already_covered` — заголовки, мітки аномалій
  і назви порад останніх 3 звітів, витягнуті з їхнього `data_json`; промт забороняє подавати їх
  як новину вдруге. **Правило: повторюваність лікується ЯВНИМ списком уже сказаного, а не
  проханням «пиши цікаво».**

**Сповіщення**
- **Ключ доби/місяця в `dedup_key` — теж `APP_TZ`** (`localYmd`/`localYm`, 2026-08-01).
  `toISOString().slice(0,10)` до 03:00 за Києвом віддає ВЧОРАШНЮ дату, а межі місяця в тому ж
  файлі рахує `localMonthStart` — тобто подія, згенерована вночі, підписувалась учорашнім днем
  і зливалась дедупом із учорашньою. Дві різні доби в одному файлі — це і є те, як подія тихо
  зникає. Те саме стосується `health_history.day` (його порівнює `draftHealthDrop`).
- **Сповіщення без переходу — тупик.** Клік мусить вести на екран події (сутність → `entity_type`,
  а без сутності — сам вид події) і знімати непрочитаність. Подія, що каже «бюджет вичерпано»
  й лишає шукати екран руками, змушує читача робити роботу, яку мала зробити стрічка.
- **Що поставив КРОН, а не людина, мусить сказати про себе, ЧОМУ воно тут.** Місячне
  оновлення поради (1-го числа о 12:00) приходило тим самим рядком «Порада готова», що й
  ручний запуск, — і читалось як збій, а не як фіча. `ai_jobs.params.auto` → інший текст +
  той самий перемикач типів, що вимикає AI-спостереження (ручний запуск не глушиться ніколи:
  сховати результат щойно замовленої дії — це не тиша, а зникнення роботи).

**Клієнт і розкладка**
- **Стилі контрола живуть на його КЛАСІ, а не на класі контейнера.** `.pill-toggle` був
  описаний як `.page-head-actions .pill-toggle`, і перемикач періоду, переїхавши в топбар,
  приїхав туди голим — браузерна кнопка без падінгів і без проміжку між іконкою й підписом.
- **Половини `.dash-pair` мусять мати ОДНАКОВУ анатомію.** Якщо в однієї заголовок над
  карткою, а в другої всередині — при `align-items: start` верхні краї карток розходяться
  рівно на висоту заголовка, і ряд читається як зʼїхала верстка.
- **Будь-який per-user ключ у `localStorage` — зі скоупом** (`mt-chats:<user_id>`). Сховище
  спільне на браузер: глобальний ключ показував демо-візитеру приватні розмови власника.
- **Дитина двоколонкової сітки не зникає: або контент, або `EmptyCard`.** `return null` лишає
  порожню половину екрана. Порожнеча ≠ помилка — `ErrorNote` це окремий стан.
  **Доповнення (2026-08-01, третій випадок):** якщо половина ВСЕ Ж уміє не рендеритись, сітка
  МУСИТЬ мати `> :only-child { grid-column: 1 / -1 }`. Інакше та, що лишилась, сідає в чужу
  колонку: розподіл категорій потрапив у 300px, розраховані на донат (донат ховається, коли
  категорія одна), і виглядав як зламана верстка. Є в `.dash-pair`, `.stats-2col`, `.cat-with-donut`.
- **Блок не ховається через порожній ПОТОЧНИЙ період, якщо його зміст — історія.** Аналітика
  доходу зникала зі сторінки цілком при `total === 0`, хоча стабільність рахується за 6 повних
  місяців: 1-го числа фіча виглядала видаленою. Ховати можна лише коли показувати справді
  нічого (історії немає зовсім); порожній період — це рядок «надходжень ще не було».
- **Ширина колонки без `flex-shrink: 0` — це побажання.** `.cb-val` мав `width: 92px`, стискався
  у вузькому контейнері, і сума ламалась на два рядки. Переламане число читається як інше
  число — те саме правило, що для зрізаної осі Y.
- **Медіа-запит належить ТОМУ Ж файлу, що й оголошення, яке він перебиває (2026-08-22).**
  `@media` не додає специфічності, тож умовне правило програє БЕЗумовному з файлу, імпортованого
  пізніше — мовчки. Налаштування були нечитабельні на телефоні (дві колонки по ~160px), бо
  `@media (max-width: 760px) { .settings-grid { columns: 1 } }` лишилась у `settings.css`, коли
  розкладка переїхала в `settings-shell.css`, який імпортується ПІСЛЯ. Правило було мертвим від
  дня розділення, і нічого про це не сказало. **Розділяючи стилі, дивись не лише на те, що
  переїхало, а й на те, що на нього посилалось.** Решта знайденого — в `ROADMAP.md §I`.
- **Пишеш `grid-*` — переконайся, що батько `display: grid`.** Ловилось тричі
  (`.advisor-grid.single`, `.runway-card`): декларація без контейнера, який її виконує, мовчить.

**Дані й безпека**
- **Ресурс, що виглядає глобальним (`TG_CHAT_ID`, `MONO_TOKEN`, `ANTHROPIC_API_KEY`,
  `WEBHOOK_SECRET`), насправді ВЛАСНИКІВ** — гейт `env.IS_OWNER` обов'язковий. Двічі давало
  крос-тенант (деталі — §Безпека).
- **Коли ресурс став owner-only на сервері — його елементи керування зникають і з UI**, інакше
  продукт обіцяє те, чого не робить.

**Фонові задачі (§A6, 2026-08-01)**
- **Alarm у Durable Object рівно ОДИН — тож він означає «найближчий дедлайн», а не конкретну
  роботу.** Щойно на нього зʼявився другий претендент (черга AI-задач поруч із пейсингом
  бекфілу й самознищенням демо), `alarm()` став планувальником: робить те, що НАСТАЛО, і
  переармовується на найраніше з решти. **Правило: `setAlarm` кличе лише `armAlarm`; ніхто в
  обʼєкті не армує alarm під себе.**
- **Пейсинг мусить мати ВЛАСНИЙ таймстамп, а не жити в часі alarm'а.** Бекфіл тримає 60 с між
  запитами виписки (ліміт mono). Поки alarm належав лише йому, час alarm'а і був пейсингом; з
  чужою задачею, що спрацювала на 20-й секунді, старий код зробив би крок бекфілу достроково —
  mono відповіло б лімітом, і синк тихо перестав би просуватись. Тепер є
  `app_state.backfill_next_at_ms`.
- **«Чи є робота» питай у ДАНИХ, а не в нового прапорця.** Джерело правди для бекфілу —
  сам курсор (`backfillPending`): він уже виставлений у тих, хто був посеред прогону, коли
  планувальник виїхав. Ключ із таймстампом у них порожній, і гейт лише на ньому обірвав би
  їхній бекфіл назавжди на першому alarm після деплою.
- **Задача, що падає до того, як встигне записати ЧОМУ, зациклює планувальник.** Черга
  переармовується на наявність 'queued'-рядків, тож вічно-'queued' рядок = вічний alarm (і
  платний). Закрито лічильником `attempts` (стеля 3) + мінімальною затримкою переармування.
- **Ідемпотентність постановки — за видом задачі.** Подвійний клік по «Оновити пораду» інакше
  = два виклики Sonnet і подвійний рахунок при однаковому результаті на екрані.
- **`running` is a TRACE that someone claimed the row, not a promise anyone is still on it
  (2026-08-08).** An isolate that dies mid-generation leaves the row in that state forever, and
  every selector treated it as live: `runNextJob`/`hasQueuedJobs` matched only `queued`, while the
  idempotency above handed that dead row's id back on every later click. One interrupted pass
  disabled the whole job kind for that user, and it looked like a button that does nothing. A
  `running` row older than 3 min is now claimable (`attempts` still caps the retries) — the longest
  real generation is ~1 min, so a live job is never stolen.
  ⚠️ **A demo is not a different scheduler.** Its jobs run inline in the request (`demoClamp` makes
  the wait short), but that made the request the ONLY executor: close the tab and nobody finishes
  the work. The demo alarm now drains the queue too, and the route drains it regardless of
  `created`. The sandbox must be able to name itself as a demo with no request attached
  (`app_state.demo_user_id`, written by `seedDemo` — `idFromName` is one-way): `isDemoEnv` keys the
  spend caps off the `demo:` prefix, so an alarm that could not would run uncapped on the platform
  key. Held by `worker/test/jobs.test.ts` (4 сценарії).
- **Поллінг лише поки є активна задача.** Постійний інтервал заради події, що стається раз на
  добу, — податок на кожного користувача; `pollingInterval: 0` вимикає таймер, початковий
  запит при монтуванні лишається (саме він ловить «закрив вкладку на середині»).

**Періоди й розклад**
- **`period_to` — це початок НАСТУПНОГО періоду.** Підпис мусить показувати `period_to − 1`,
  інакше тиждень 13–19 липня читається як «13 – 20 лип.» і виглядає як «рахує не той період».
- **Подія, створена в прогоні крону, оголошується в ЦЬОМУ ж прогоні.** Репорт народжувався о
  09:00, а стрічку наповнював добовий прохід о 06:00 — сповіщення відставало на добу й описувало
  період, який скінчився півтори доби тому. Вік сповіщення не має залежати від розкладу іншої задачі.
- **Одна й та сама думка з різними числами — це та сама подія.** `dedup_key` з датою (`ai:<день>`)
  робив щоденний повтор «новою» подією й слав її в TG щоранку. Ключ теми — з нормалізованого
  заголовка БЕЗ чисел, вікно 14 днів.

**AI (додатково)**
- **Обрив по `max_tokens` — це помилка, навіть якщо відповідь усе одно розпарсилась.**
  `repairTruncatedJson` дозакривав дужки, `JSON.parse` проходив — і в базу лягав огризок звіту
  (сам заголовок, без розбору, категорій і порад), а ретраю не було саме тому, що «вдалося».
  Ремонт існує для МАЛФОРМОВАНОГО виводу, не для мовчазного прийняття піввідповіді.
- **Секцію, яку ми рахуємо САМІ, не гейтити масивом від моделі.** Категорії звіту детерміновані й
  збережені, але рендерились під `if (r.category_breakdown.length)` — коли модель свого масиву не
  дала, зникали й наші надійні числа.

**Клієнт і розкладка (додатково)**
- **Кожен елемент рівномірної flex-стрічки — `min-width: 0`, а його підпис мусить вміти
  обрізатись.** Дефолтний `min-width:auto` дозволяв підпису розіпхати ФІКСОВАНИЙ таб-бар ширше
  за viewport — горизонтальний скрол на всіх сторінках одразу. Довше слово в перекладі не має
  ламати розкладку.
- **`overflow-x: hidden` ставити і на `html`, не лише на `body`** — на iOS клип лише на `body`
  не заважає відтягнути сторінку пальцем. Це сітка безпеки, а не спосіб ховати переповнення.
- **Скелет повторює КЛАСИ справжнього блоку** (`.runway-card`, `.sub-card`), а не малює
  абстрактний прямокутник: тоді сітка й падінги беруться з тієї самої CSS і перехід не смикає layout.
- **«Вантажиться» і «даних справді нема» — різні екрани.** Один текст на два стани робить
  порожній акаунт схожим на вічний спінер.
- **Літеральний роут оголошується ВИЩЕ параметризованого** (`/transactions/frequent` перед
  `/transactions/:id`): Hono матчить у порядку реєстрації, тож інакше літерал просто недосяжний.

**Дані й безпека (додатково)**
- **Бекап читає список таблиць зі СХЕМИ, а не з масиву в коді.** Дамп, що мовчки не бере таблицю
  з наступної міграції, гірший за відсутність бекапу — він виглядає як бекап. Порожня схема → 500,
  а не «успішний» файл на кілька байт.
- **Лічильник, що обмежує СТВОРЕННЯ, не можна бити на кожній спробі.** Стеля нових реєстрацій
  списується лише коли рядок реально створюється (колбек `allowSignup`), інакше жменя постійних
  юзерів вичерпує денну квоту й замикає незнайомців.
- **`null` (ще не звітував) ≠ `0`.** В адмін-списку нуль замість «невідомо» стверджує, що в юзера
  нема операцій — інший і, можливо, хибний факт.

**AI (ще)**
- **Схема в промті — це прохання, а не контракт.** Модель поверталась із headline+summary й
  порожніми `sections`/`predictions`/`advice`: валідний JSON, порожній екран. `callHaikuJson`
  приймає `validate(result)`, що каже, чого бракує, і перепитує РІВНО раз; гірша друга відповідь
  не замінює першу. Той самий принцип, що `numbersAreGrounded`.
- **Не ретраїти те, що обрізало СЕРЕДОВИЩЕ.** `demoClamp` тисне демо до 900 вихідних токенів, тож
  «обірвано → попроси більше» купувало ту саму відповідь ще двічі й палило спільний бюджет
  (спіймано на живому прогоні: один звіт = три виклики). `callHaiku` віддає `capped`, і обидва
  ретраї під ним вимкнені.
- **«Ключ є» ≠ «юзер зберіг свій ключ».** У власника ключ приходить із deployment-секретів, тож
  рядка в `user_secrets` нема — і UI, що гейтив на `set`, вимагав від власника додати ключ, поки
  AI чудово працював. `/api/credentials` віддає ще й `available`; фічі гейтити на ньому.
  ⚠️ Імена секретів у нижньому регістрі (`anthropic_api_key`) — звірка з `ANTHROPIC_API_KEY`
  не збігалась ніколи, тож банер бачили ВСІ.

**i18n**
- **Ніколи `new Intl.*` у коді — лише `dateFmt()`/`numFmt()` з `i18n/locale.ts`.** Форматер,
  створений на рівні модуля, застигає з локаллю на момент ІМПОРТУ: перемикання мови
  перемальовує всі `t()`-підписи, а дати лишаються старою мовою («next 19 серп.» на англійському
  екрані — скарга з проду, 20 файлів). Ловиться `npm run check`.

## 🔐 Безпека — ЄДИНІ правила (аудит 2026-07-26)
Повний прохід по периметру. Що вже було правильно: HMAC-сесії з timing-safe звіркою і hex-регексом
на id · OAuth зі `state`+`nonce`+`aud`+`iss`+`exp`+`email_verified` · рішення «пускати чи ні» в
ОДНОМУ місці (`loginWithGoogle` — тепер відкрита реєстрація, див. §Ops п.4; `disabled` = бан у
будь-якому режимі) · `withUserHeader` СТАВИТЬ, а не мерджить заголовок (id юзера не підробити) ·
AES-GCM з новим IV на кожен запис, ключ лише у Worker-секреті, значення назад не віддається ·
жодного `dangerouslySetInnerHTML` у клієнті · SQL — параметризований, усі інтерполяції з
whitelist-тернарників · AI-інструменти не виконують модельний SQL · TG-вебхук за secret-token +
allowlist chat_id. Знайдене й закрите:
- **🔴 Глобальні `MONO_TOKEN`/`ANTHROPIC_API_KEY` були фолбеком для ВСІХ.** Це особисті ключі
  власника, тож запрошений юзер без свого токена, натиснувши «Синхронізувати рахунки», тягнув
  **чужу (власникову) виписку у СВОЮ базу** — крос-тенант через звичайну кнопку; а його AI їхав
  на ключі власника без жодних лімітів. **Правило: фолбек на deployment-секрети — ЛИШЕ для
  власника.** Ознака власника йде окремим заголовком `x-mt-owner` (`forward.ts`), який ставить
  Worker після звірки з directory; для крону — параметр `runCron(..., isOwner)`, для alarm —
  збережений прапорець `app_state.is_owner` (пише лише автентифікований шлях).
- **🔴 `status='disabled'` нічого не робив.** Guard перевіряв лише підпис кукі, тож вимкнений
  юзер зберігав повний доступ до API на 30 днів (розлогінювався лише UI, бо `/api/me` статус
  читає). Тепер guard звіряється з directory через `userAccess()` — кеш 60с на ізоляті, щоб не
  класти D1-читання перед кожним запитом. **Стелс-обмеження: відкликання діє до 60с.**
- **Заголовків безпеки не було жодного.** Додано CSP (`script-src 'self'` БЕЗ `unsafe-inline`,
  `frame-ancestors 'none'`, `connect-src 'self'`), `nosniff`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`. **Через це inline-скрипт теми переїхав у `public/theme.js` — не повертай
  inline `<script>` в `index.html`, сторінка мовчки зламається.** CSP не шлеться на localhost:
  Vite у дев-режимі вставляє власний inline-преамбул.
- **`GET /demo` створював DO без ліміту** — неавтентифікований запит, що сіє ~350 транзакцій +
  рядок у directory. Стеля `DEMO_DAILY_NEW_SANDBOXES=300/добу` (fail-open, якщо лічильник недоступний).
- **CSV-експорт: formula injection.** Колонка «Коментар» — це текст, який пише СТОРОННЯ людина
  при P2P-переказі; Excel виконує клітинку, що починається з `= + - @`. Тепер такі значення
  префіксуються `'` (чисті числа — виняток, інакше сума перестала б сумуватись).
- **R2: ключі чеків тепер із префіксом юзера** (`receipts/<user>/…`). Роуту читання ще немає, але
  коли зʼявиться — перевірка власності має бути самим шляхом, а не окремою згадкою.
- **🔴 Другий прохід: TG-пуш злив дані інших юзерів власнику.** `TG_CHAT_ID` — ОДИН глобальний
  чат (власника), а гілка крону виконується в DO КОЖНОГО юзера. Тобто сповіщення запрошеного
  друга («ти витратив стільки-то на Продукти») прилітали в Telegram ВЛАСНИКА — його дані, чужий
  телефон. Закрито в усіх 4 точках відправки (`notify.pushPendingToTelegram`, `proactive`,
  `alert.maybeAlertTransaction`, `alert.scanAlerts`) через новий `env.IS_OWNER`; `POST
  /api/setup/register-telegram` (переналаштування глобального бота) теж став owner-only.
  **Правило, що узагальнює обидві діри: якщо ресурс виглядає глобальним (`TG_CHAT_ID`,
  `MONO_TOKEN`, `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`) — він насправді ВЛАСНИКІВ. Гейт
  `env.IS_OWNER` обовʼязковий.** `IS_OWNER` ставить `UserDO.appEnv` із заголовка `x-mt-owner`,
  який пише Worker після звірки з directory — клієнт його не контролює.
- **UI під гейтом теж прибрано (2026-07-26).** Картка Telegram у Налаштуваннях не рендерилась
  для не-власника й демо: після серверного гейта її кнопки або відповідали б 403, або — гірше —
  виглядали б так, ніби налаштовують ТВІЙ бот. **Правило: коли ресурс стає owner-only на
  сервері, його елементи керування зникають і з UI** — інакше продукт обіцяє те, чого не робить.
- **§D1 (2026-08-01): TG-адресат став ПЕРСОНАЛЬНИМ, гейт `IS_OWNER` знято з пушів.**
  ЄДИНЕ джерело адресата — `tgTarget(env)` (`messaging/tg-target.ts`): власна привʼязка
  `app_state.tg_chat_id`, і **лише для власника** фолбек на deployment-секрет `TG_CHAT_ID` —
  той самий інваріант, що для `MONO_TOKEN`/`ANTHROPIC_API_KEY`. Привʼязка — deep-link
  `t.me/<bot>?start=<підписаний токен>`, НЕ ручний ввід chat_id: свого chat_id людина не знає,
  а поле для введення дозволило б вписати ЧУЖИЙ і перенаправити собі чужі сповіщення —
  у deep-link підтвердження робить сам Telegram (у вебхук приходить чат, з якого натиснули).
  Токен компактний (`userId_expBase36_sig16`), бо `?start=` дозволяє ≤64 символів `[A-Za-z0-9_-]`.
  Вхідний allowlist бота тепер теж `tgTarget` — «кому шлемо» і «кого слухаємо» не можуть розійтись.
  ⚠️ **Наслідок, який проґавили на три тижні (закрито 2026-08-21):** §D1 зробив пуші
  ПЕРСОНАЛЬНИМИ, а і `CLAUDE.md`, і лінт C10 далі звільняли весь Telegram від перекладу й від
  заборони на літерал `₴` — з формулюванням «це owner-only». Англомовний читач у доларах діставав
  українські пуші з гривневим знаком над конвертованими сумами. Тексти тепер через `st()`, суми —
  `num()` + `currencySign(base)`, виняток із C10 **знято**. **Правило: виняток посилається на
  ФАКТ, а факт може протухнути** — це другий такий випадок після `budgets.rollover`.
  ⚠️ **§TG-MINIAPP (2026-08-21): Telegram — це ДРУГИЙ КЛЮЧ до наявного акаунта, і ніколи не
  спосіб його створити.** У міні-апці Google-вхід неможливий у принципі: Telegram відкриває
  згоду в зовнішньому браузері, state-кука назад у вебвʼю не приїжджає, і `/auth/google/callback`
  щоразу віддає `bad_state` — скарга власника читалась як «зламався Google», а насправді
  середовище не вміє OAuth. Тепер `POST /auth/miniapp`: `initData` → `verifyInitData`
  (`lib/platform/tg-auth.ts`) → `tg_links` → сесійна кука. Реєстрація лишається виключно за
  `loginWithGoogle`, тож ідентичність ОДНА.
  ⚠️ **Виняток — ВЛАСНИК на deployment-чаті (2026-08-22).** Рядок у `tg_links` пише підписаний
  `/start`, а власникові він не потрібен ніколи: воркер маршрутизує його чат по `TG_CHAT_ID`, і
  `tgTarget` пушить туди ж. Тобто акаунт може мати цілком робочий бот і порожній індекс — і
  міні-апка казала «не привʼязано» саме тому, хто нею користується. Фолбек звіряє id, який щойно
  ПІДПИСАВ Telegram, із `TG_CHAT_ID`; це не твердження клієнта. Та сама асиметрія «рядок проти
  фолбека», що й §TG-OFF, лише в інший бік.
  ⚠️ **`tg_links` лишається ЄДИНИМ авторитетом «чий це Telegram».** Другий індекс (tg-user → акаунт)
  був би другою копією одного факту — рівно те, що прибирали весь 2026-08-21. Працює це тому, що
  **привʼязка ЛИШЕ приватна**: у приватному чаті id чату = id користувача. Група тут стала б
  дірою — будь-хто з неї увійшов би як власник, — і саме тому привʼязка в групі відмовляється.
  ⚠️ **Ключ виводиться `HMAC(key="WebAppData", msg=botToken)`, і переплутаний порядок дає такий
  самий за формою hex** — тобто «ніхто не може ввійти» і «може будь-хто» відрізняються одруківкою.
  Тому фікстура в `tg-auth.test.ts` будується НЕЗАЛЕЖНОЮ реалізацією (node `crypto`) за
  специфікацією, а не викликом коду, що перевіряється. `auth_date` перевіряється (підпис сам не
  протухає), вікно — доба: `initData` не оновлюється, поки міні-апка відкрита.
  ⚠️ **`hash` — ЄДИНЕ поле, що виключається з check-string** (2026-08-22, `bad_init_data` на
  кожному запуску). `signature` (Bot API 8.0) шлють УСІ сучасні клієнти, і він підписаний разом з
  рештою; викидає його лише ОКРЕМА схема Telegram — Ed25519 для третьої сторони, — і документація
  каже це лише в тому розділі. **І незалежна фікстура тут не рятує:** вона будувала payload за тим
  самим припущенням, що й код, тобто стверджувала здогад коду йому ж у відповідь і проходила в
  обидва боки. Тепер тест підписує `signature` так, як це робить Telegram, плюс дзеркало —
  приліплений після підпису `signature` мусить відхилятись.
  ⚠️ **Клієнт НЕ вантажить `telegram-web-app.js`** (`src/lib/telegram.ts`): це скрипт із чужого
  оріджина, а `script-src 'self'` його забороняє. Параметри запуску беруться з ФРАГМЕНТА URL
  (`#tgWebAppData=…`) — звідки їх читає й сам SDK. Ціна названа: немає `ready()`/`expand()`/теми.
  ⚠️ **`x-frame-options` ЗНЯТО, `frame-ancestors` тепер `'self' https://web.telegram.org`.** У
  XFO немає форми зі списком (`ALLOW-FROM` видалили з усіх браузерів), тож `DENY` поруч блокував
  би міні-апку в Telegram Web і робив би CSP брехнею про те, що застосунок дозволяє.
  ⚠️ **§TG-OFF (2026-08-21): порожній рядок `app_state.tg_chat_id` = «я ВІДВʼЯЗАВ», і він
  перебиває deployment-фолбек.** `unlinkTgChat` пише `""`, а обидва читачі розуміли порожнє як
  «ніколи не привʼязував» — тож єдиний акаунт, у якого фолбек є (власників), відвʼязкою вмикав
  собі все назад: пуші відновлювались, а `tgTarget` — це ЩЕ Й вхідний allowlist, тож бот далі
  відповідав на `/balance` у тому самому чаті. Скарга власника дослівно: «коли відключаю тг бота
  в веб апці, то тг ботом все ще можу користуватись і брати інфу». **Відсутність рядка (`null`)
  фолбек зберігає** — саме для неї він і існує. Відвʼязка тепер ще й ПОВІДОМЛЯЄ чат, який щойно
  втратив бот (той самий принцип, що попередження про перепривʼязку): зсередини Telegram «відвʼязано»
  і «зламалось» виглядають однаково. Тримається `telegram.test.ts` (2 сценарії).
  ⚠️ **§TG-SURFACE (2026-08-21): смуга кнопок і ⌘-меню чіпляються ЛІНИВО, з будь-якого апдейту.**
  Обидва були написані й обидва були невидимі в проді з однієї причини — момент чіпляння. Меню
  реєструвалось лише всередині `POST /setup/register-telegram` (кнопка, підпис якої про меню не
  каже), смуга — лише у відповіді на `/start`/`/help`, а Telegram тримає reply-клавіатуру, поки її
  не замінить інше повідомлення: хто привʼязав бота раніше, не побачив би її ніколи. Тепер
  `lib/messaging/tg-surface.ts` тримає ВЕРСІЮ, виведену з самих підписів (djb2), і чіпляє те, чого
  цей чат ще не бачив. **Перейменував кнопку — смуга переїде сама, бампити нічого не треба.**
  ⚠️ ⌘-меню лишається owner-only: це один ресурс на весь бот (§Безпека — «ресурс, що виглядає
  глобальним, насправді власників»).
  ⚠️ **§TG-ROUTE (2026-08-21, directory 0008): вхідні команди більше НЕ owner-only.**
  `tg_links(chat_id → user_id)` — ЄДИНИЙ авторитет: воркер резолвить чат ДО того, як зможе
  звернутись до будь-якого обʼєкта (`idFromName` односторонній, тож із `app_state.tg_chat_id`
  цю відповідь не вивести). Писар обох сховищ один — `linkTgChat`. Чат без рядка не роутиться
  ВЗАГАЛІ: воркер сам відповідає йому запрошенням привʼязатись, бо раніше нерозпізнаний чат
  падав у обʼєкт ВЛАСНИКА, і безпечним це було лише поки бот відмовляв усім, крім нього.
  Забанений акаунт втрачає бот разом з усім іншим (`userAccess` перед роутингом — та сама
  §REVOKE, інші двері). Owner-only лишилась реєстрація вебхука (один глобальний ресурс).
  У демо привʼязка заборонена явно: пісочниця живе 24 год.
- **§MCP (2026-08-23, directory 0009): третій ключ до акаунта — bearer-токен для MCP-клієнта**
  (Claude Code, Claude Desktop через `mcp-remote`). `POST /mcp` у воркері, JSON-RPC над
  Streamable HTTP; сам сервер — `worker/routes/mcp.ts`, ВСЕРЕДИНІ DO, бо його інструменти
  ходять в `env.DB`.
  ⚠️ **Ізоляція — та сама, що в браузера, бо це той самий шлях.** Автентифікувавши токен, воркер
  форвардить запит через ТОЙ САМИЙ `toUserDo`/`withUserHeader`: адресат — обʼєкт, названий
  `userId` із ПІДПИСУ, а не `WHERE user_id`, який можна забути. Гвардія `/mcp` робить ті самі
  три перевірки, що й сесійна (`userAccess.ok` → §REVOKE-порівняння генерації → рейт-ліміт), і
  саме тому вона окрема функція, а не гілка всередині `guard`: другі двері з мʼякшими правилами
  — це те, на чому проєкт уже двічі віддав чужі дані.
  ⚠️ **ВЛАСНА генерація (`users.mcp_version`), не `token_version`.** Ротація токена в конфізі
  редактора не сміє розлогінювати телефон; зворотне важливіше — «Вийти на всіх пристроях»
  ОБОВʼЯЗКОВО вбиває і MCP-токен (`logout-all` кличе `revokeMcp`), інакше відповідь на «хтось має
  мої креденшели» лишала б живим річний ключ на чиємусь ноуті.
  ⚠️ **Тип токена — у ПІДПИСІ** (`mtmcp1.` проти `v3.`), тож сесійна кука не є MCP-токеном і
  навпаки. Без цього один витік був би придатний там, де приймають інший.
  ⚠️ **Демо не може мати токена ФІЗИЧНО:** `verifyMcpToken` вимагає hex-`userId`, а пісочниця
  зветься `demo:<random>`. Тобто це не перевірка, яку можна забути додати в новому місці.
  ⚠️ **Read-only за побудовою.** Список = `financeReadTools()` (`lib/ai/chat-tools.ts`), і
  `tools/call` звіряється З НИМ, а не з `runFinanceTool` — той відповідає й на `remember_fact`,
  тож диспетч лише через виконавця віддав би запис тому, хто вгадав назву.
  ⚠️ **Одна одиниця на всю поверхню — ЦІЛІ гроші**, і кожна відповідь називає `currency` даними.
  `collectFinanceSnapshot` віддає ДВІ одиниці одночасно (топ-рівень у копійках, `context` уже
  поділений на 100), тож на дріт іде лише `context`. Пор. §0a в `ROADMAP.md` — там та сама
  розбіжність ще жива в промті.
  ⚠️ `/mcp` — поза `/api/*`, тож він МУСИТЬ бути в `assets.run_worker_first` (§Ops): інакше
  клієнт отримає SPA-шелл і поскаржиться на «невалідний JSON», що читається як зламаний сервер.
  Тримається `worker/test/mcp.test.ts` (20 сценаріїв; вісім із них — про сам креденшел).
- **§MCP-OAUTH (2026-08-23, directory 0010): цей деплой САМ став authorization server —
  для власного ж `/mcp`.** Тепер конектор додається в Claude Desktop / claude.ai / телефоні
  адресою і нічим більше: `POST /mcp` віддає 401 з `WWW-Authenticate: … resource_metadata="…"`,
  клієнт читає `/.well-known/oauth-protected-resource`, звідти — `/.well-known/
  oauth-authorization-server`, реєструється сам (RFC 7591) і веде людину на сторінку згоди.
  ⚠️ **ЧОМУ не делегували Google, який тут уже є логіном.** Google відповідає «хто це», а видається
  доступ до ЦЬОГО реєстру, про який Google не знає. Прийняти Google-токен як владу над даними
  Money Track — це рівно та «token passthrough», яку специфікація забороняє: токен виданий для
  іншої аудиторії. Тому Google лишається дверима входу, а грант — наш.
  ⚠️ **`/.well-known/*` і `/oauth/*` — у `assets.run_worker_first`.** Документація Anthropic
  окремо називає «Cloudflare Worker без роуту `/.well-known/*`» типовою причиною відмови, і
  симптом бреше: «couldn't reach the MCP server» при тому, що на OAuth-ендпоінти НЕ приходить
  жодного запиту.
  ⚠️ **`scopes_supported` мусить містити `offline_access`** — Claude просить refresh-токен ЛИШЕ
  коли сервер це рекламує. Без рядка конектор працює рівно годину й тихо вмирає, і це читається
  як нестабільний сервер, а не як брак одного слова в метаданих.
  ⚠️ **Порт loopback ігнорується, і ТІЛЬКИ порт, і тільки для loopback** (RFC 8252 §7.3). Claude
  Code піднімає ефемерний порт на сесію, тож побайтове порівняння відхиляло б кожне його
  підключення — і виглядало б бездоганно в тесті, який пробував лише claude.ai.
  ⚠️ **Незареєстрований `redirect_uri` не отримує НІЧОГО — навіть помилки.** Відповідь туди і є
  той самий open redirect: адресу задає той, хто атакує. Обидві відмови (невідомий клієнт,
  невідомий redirect) зупиняються 400-ю в браузері.
  ⚠️ **Три речі тримає СХОВИЩЕ, а не підпис** (`oauth_clients`/`oauth_codes`/`oauth_grants`):
  зареєстровані redirect-адреси (бо звіряти нема з чим, якщо їх не збережено), одноразовість коду
  (це факт про минуле) і ротація refresh-токена (попередній мусить померти в ТОМУ Ж запиті).
  Access-токен лишається stateless і живе годину, тож гарячий шлях — кожен виклик MCP — і далі не
  читає базу.
  ⚠️ **Відкликання — ДВІ дії, або кнопка бреше.** Бамп `mcp_version` вбиває access-токени, але
  refresh — це рядок, і він два місяці карбував би нові. Тому `revokeMcp` завжди йде разом із
  `deleteUserGrants` (обидві — і в «Відкликати доступ», і в «Вийти на всіх пристроях»).
  ⚠️ **Аудиторія в токені (`mtoat1`) — не формальність:** без неї токен, виданий іншим деплоєм
  цього ж коду з тим самим ключем, працював би тут. Один витік ключа зробив би всі деплої
  взаємозамінними.
  ⚠️ **Блоб згоди кодується base64url ПЕРЕД підписом:** `signShortLived` ріже токен по крапках, а
  в блобі завжди є хостнейм — тобто кожне підтвердження мовчки читалось би як «прострочено».
  ⚠️ **`form-action 'self'` ЗАБЛОКУВАВ власну сторінку згоди** (знайдено на проді 2026-08-24,
  кнопка «Дозволити» просто нічого не робила). Дві причини, і повідомлення в консолі однакове для
  обох: `'self'` резолвиться відносно ОРІДЖИНА ДОКУМЕНТА, а він непрозорий у пісочниці, в якій
  десктоп-клієнт відкриває OAuth-вікно; і Chrome перевіряє `form-action` ще й на РЕДІРЕКТІ після
  сабміту, а наш POST відповідає 302 на callback клієнта. Тому сторінка згоди має ВЛАСНИЙ CSP
  (`cspForFormTarget`): свій оріджин ЯВНО, плюс оріджин уже перевіреного `redirect_uri`. Мідлвар
  заголовків тепер НЕ перетирає CSP, який поставив хендлер, — решту перетирає, як і раніше.
  ⚠️ **Симптом мовчазний за побудовою:** сторінка не рухається, помилка лише в консолі, якої у
  вікні OAuth ніхто не бачить. **Локально не відтворюється взагалі** — мідлвар знімає CSP на
  localhost, тож і `npm run dev`, і весь наскрізний прогін були зелені. Перевіряти цей клас треба
  на хості, що не є localhost (`curl --resolve app.localhost:…`).
  ⚠️ Тест на це — лише НА РІВНІ РОУТА: `worker/index.ts` тягне Durable Object, тобто
  `cloudflare:workers`, якого Node не вантажить, тож зібрати весь воркер у тесті неможливо. Те, що
  заголовок ПЕРЕЖИВАЄ мідлвар, перевірено живим сервером і в тесті прямо названо як непокрите.
  Тримається `worker/test/oauth.test.ts` (30 сценаріїв, майже всі — про відмови).
  ⚠️ **UI: «Відкликати доступ» — контрол РІВНЯ КАРТКИ, не частина шухляди з токеном** (2026-08-24).
  Він рендерився лише за наявності персонального токена, тож у тих, кого це стосується найбільше —
  хто підключив Claude через екран згоди й токена не карбував ніколи, — кнопки не було взагалі:
  живий грант і жодного способу його припинити. Показується, коли є БУДЬ-ЯКИЙ доступ
  (`connected_clients > 0 || active`), і в підписі сказано, що відключає обидва — генерація в них
  спільна, тож обіцянка відключити щось одне була б брехнею.
  ⚠️ **Рядок-анонс на Головній (`McpHint`) зникає САМ, щойно щось підключено** — умова «немає
  грантів і немає токена», а не «ще не закрив». Анонс, який триває після того, як на нього
  відреагували, привчає не дивитись і на сусідні. Запит скіпається, коли рядок і так не
  показується, щоб той, хто його закрив, не платив запит на кожному відкритті Головної.
- Перевірено й чисто: жодного ендпоінта, що пише ДОВІЛЬНИЙ ключ у `app_state` (інакше юзер міг
  би сам виставити собі `is_owner=1`) · `credentials` приймає лише whitelist-імена секретів ·
  курси приходять з mono API, не від юзера (`uahMult` не інжектується).
- **§REVOKE (2026-08-01): сесію тепер МОЖНА відкликати.** Сесія лишається stateless (жодного
  D1-читання на гарячому шляху), але в підпис вшито `users.token_version` (directory 0005):
  інкремент → усі раніше видані кукі перестають верифікуватись. Токен став `v3.<user>.<exp>.<tv>.<hmac>`.
  **Правило: перевірка підпису — лише ПОЛОВИНА.** `verifySession` доводить, що `tv` не підробили;
  чи він ще чинний, знає тільки directory, тож гвардія обовʼязково звіряє `tv` з `userAccess`.
  Бампиться автоматично при бані (`setUserStatus('disabled')` — раніше бан не чіпав кукі взагалі,
  і забанений мав робочий ключ до API ще 30 днів) і кнопкою «Вийти на всіх пристроях»
  (`POST /api/account/logout-all`). ⚠️ Чесна межа: діє ≤60с (кеш `userAccess`), не миттєво.
- **Кукі сесії — `__Host-mt_session`.** Префікс змушує браузер САМОГО тримати Secure + `Path=/`
  + відсутність `Domain`; останнє й важливе — без нього будь-що на сусідньому піддомені могло б
  підсадити сюди свою кукі. Перейменування розлогінює всіх один раз, тому їхало разом із
  `token_version` (той бамп і так знецінює старі кукі).
**Свідомо НЕ змінено:** тексти помилок і далі показують справжню причину (§Обробка помилок —
без цього не діагностується ліміт/ключ/збій моделі).

### 🔁 Прохід після структурного рефактора (2026-08-07)
Периметр переїхав разом із кодом (`api.ts` → 16 файлів, SQL → `repo/`, `ai.ts` → шари), тож усе
з аудиту 2026-07-26 перевірено ще раз на НОВІЙ структурі. **Сам переїзд не зламав нічого:**
гейти (`admin` через directory, `register-telegram` через `IS_OWNER`, `userCredentials`,
`tgTarget`), `withUserHeader` (СТАВИТЬ обидва заголовки), `rememberOwner` (пише лише з
owner-шляху), заголовки безпеки на КОЖНІЙ відповіді, демо-гейт (префікси досі збігаються з
таблицею роутів), R2-префікс юзера, `__Host-`+`token_version` — усе на місці.
- **Ін'єкції в новому шарі `repo/` немає.** Кожна інтерполяція в SQL — або перелік колонок
  ЛІТЕРАЛАМИ в коді (білдери часткового апдейту), або рядок плейсхолдерів `?`; значення завжди
  через `.bind()`. Єдиний динамічний ідентифікатор — назва таблиці в `dumpTable`, і вона приходить
  з інтроспекції схеми, не від юзера.
- **Нове: лінт C7** (`check-route-order.mjs`) — літерал не може стояти нижче параметризованого
  роута, що його перекриває, і один префікс не може обслуговуватись двома файлами. На момент
  додавання не знайшов нічого; він і потрібен не для «знайти зараз», а щоб твердження, на якому
  стоїть увесь розріз (`один файл володіє префіксом`), лишалось правдою без перечитування.
- **Скан історії git** за відомими формами ключів (`sk-ant-`, `GOCSPX-`, `AIza`, PEM, довгі
  hex/base64) — порожньо; `.dev.vars` у git не потрапляв ЖОДНОГО разу. ⚠️ Це НЕ заміна
  `gitleaks`/`trufflehog`: воно матчить лише ті форми, які я перелічив.
- **Знайдено й полагоджено:** `.dev.vars.example` не мав трьох TG-змінних узагалі, а `APP_PASSWORD`
  досі описувався як «пароль для входу», хоч парольного входу нема з липня.
- **Закрито того ж дня:** аплоад чека мав стелю на РОЗМІР (5 МБ) і рейт-ліміт, але не мав добової
  квоти на юзера — а реєстрація відкрита, тож «залогінений» більше не означає «знайомий власника».
  Тепер `lib/platform/quota.ts` `countReceiptUpload` — 60/добу, лічильник у ВЛАСНОМУ `app_state`
  юзера (DO вже прокинутий, тож це локальне читання, а не запис у спільну базу).
  ⚠️ Лічильник бʼється лише коли аплоад ПРИЙНЯТО (після перевірки розміру) — інакше потік
  завеликих файлів, які ми й так відхиляємо, зʼїдав би квоту справжнього юзера. Те саме правило,
  що в `allowSignup`. Ключ доби — київський (`localYmd`), інакше квота оновлювалась би о 03:00.

### 💾 Де і як лежать дані користувача (аудит зберігання, 2026-07-26)
- **Фінансові дані — у власному Durable Object юзера** (SQLite всередині обʼєкта). Ізоляція
  фізична, не `WHERE user_id`; шифрування на диску забезпечує Cloudflare. Ключ обʼєкта —
  `idFromName(userId)`; демо — `demo:<random>`, окремий простір імен.
- **Ключі (mono/Anthropic) — `user_secrets` у ТОМУ Ж обʼєкті, AES-GCM**, майстер-ключ лише як
  Worker-секрет, свіжий IV на кожен запис, назад не віддаються навіть замаскованими. Тобто копія
  бази (бекап, дамп, витік) без `SECRETS_MASTER_KEY` — мертва.
- **Спільна D1 `directory`** тримає ЛИШЕ ідентичність: id, email, google_sub, імʼя, URL аватара,
  статус, хто запросив, час входу. Жодних грошей. Плюс `shared_state` — курси й лічильники демо.
- **R2 `RECEIPTS`** — оригінали чеків, ключ `receipts/<user>/<дата>/<uuid>`. Роуту читання
  НЕМАЄ; коли зʼявиться — перевірка власності мусить бути самим шляхом.
- **На пристрої (`localStorage`)**: історія чатів `mt-chats:<user_id>` і тема. **Вихід тепер
  чистить чати** (`src/lib/localdata.ts`) — раніше розмови про зарплату лишались на диску
  назавжди. Тему свідомо не чіпаємо (це не дані акаунта).
- **Ретеншн:** прочитані сповіщення 90 дн · `ai_usage` 60 дн/24 міс · історія порад 24 записи ·
  транзакції — вічно (це і є суть застосунку).
- **Видалення (нове):** `POST /api/account/delete` — сам юзер стирає все (типізоване
  підтвердження `DELETE`); `DELETE /api/admin/users/:id` — власник стирає акаунт того, хто пішов.
  Порядок ЗАВЖДИ «дані → identity»: збій між кроками лишає недосяжний акаунт, а не живий
  акаунт із тихо зниклими даними. Власника видалити не можна (бутстрап у OAuth-колбеку
  відтворив би порожній акаунт і це читалось би як «дані відновились»).
- **Бекапи — щоночі в R2 (§BACKUP, 2026-08-08).** Ключ `backups/<user>/<київський день>.json.gz`,
  14 денних копій, ротація тільки датованих. Файл — ТОЙ САМИЙ дамп, що віддає `/export/all.json`
  (єдина реалізація — `lib/platform/backup.ts` `buildDump`; дві означали б, що ручний експорт і
  бекап можуть розійтись, і виявилось би це в день відновлення).
  ⚠️ **Пише ВОРКЕР у крон-фан-ауті, не DO:** обʼєкт не може дізнатись власне імʼя (`idFromName`
  односторонній), а імʼя й вирішує ключ. Обʼєкт дає лише два RPC — `exportDump`/`restoreBackup`.
  ⚠️ **Відновлення — єдина операція, що НАВМИСНО стирає дані.** Одна `transactionSync` +
  `PRAGMA defer_foreign_keys` (порядок таблиць не має значення); увесь план готується ДО
  транзакції, тож битий файл падає, нічого не видаливши. Схема-дрейф — перетином: зайва таблиця
  пропускається, зайва колонка відкидається, і обидва РАПОРТУЮТЬСЯ; файл із НОВІШОЇ схеми
  відхиляється (мовчки викинути частину даних гірше). Перед відновленням автоматично пишеться
  `pre-restore.json.gz` — поза ротацією, бо шукають її саме тоді, коли відновили не той файл.
  ⚠️ Демо заблоковане на рівні воркера (`/api/backups` до DO не доходить, тож денилист
  `user-app.ts` його не покриває), видалення акаунта стирає й копії. Тримається
  `worker/test/backup.test.ts` (6 сценаріїв).

## 🌐 i18n (P3, англійська) — ЄДИНІ правила
- **Клієнт:** усі UI-рядки через `t()` (`src/i18n`); теги локалі лише в `src/i18n/locale.ts`
  (`localeTag`). Місяці/дні — `monthShort()` тощо, не хардкод-масиви. Лінт `check-i18n.mjs`
  тримає парність `en`/`uk` + забороняє хардкод-тег. НЕ перекладати: коментарі, `brands.tsx`,
  матч-ключі (`.includes("фоп")`, `/переказ|зняття/i`), класи, `Icon name`.
- **Текст сповіщень (стрічка) — `shared/notif-i18n.ts`** (P3.3, див. §Центр сповіщень).
- **Будь-який рядок, який ВОРКЕР кладе у відповідь — `worker/lib/platform/i18n.ts` `st(locale, key, params)`**
  (B3, 2026-07-26). Знайдено скануванням: ~70 фраз їхали з API готовою українською — caveats під
  графіком нетворту, «без категорії» в легендах, мітки стабільності доходу, підписи Індексу
  здоровʼя, ВЕСЬ детермінований fallback Порадника, шапка CSV і кожна валідаційна помилка. У демо
  (стартує в `en`) це читалось як зламаний продукт, а не як брак перекладу. Локаль беруть із
  `c.get("locale")` (роути `api`) або `ownerLocale(env.DB)` (lib). `stLit()` — та сама фраза як
  SQL-літерал для фолбеків усередині запиту (`COALESCE(c.name, 'без категорії')`); `num()` —
  групування розрядів у локалі (`toLocaleString("uk-UA")` був хардкодом у Пораднику).
  **НЕ ліпити `if (locale === "en")` по місцях** — так зʼявляються два написання однієї фрази.
  **НЕ перекладати** (перевірено й лишено свідомо): промти й tool-схеми моделі; матч-ключі
  (`transfers.ts`, `REFUND_PREFIXES`, аліаси заголовків CSV); `label` банк-провайдерів (до
  клієнта не доходить — у нього власна мапа `BANK_LABEL`). Назва рахунку «Готівка»/«Cash»
  (`ensureCashAccount`) пишеться ОДИН раз при створенні: далі це дані юзера, і резолв на читанні
  мовчки перейменовував би рахунок, який він назвав сам.
- **Назви категорій — СЕРВЕР-РЕЗОЛВ у локалі власника (P3.4).**
  ⚠️ **`lib/messaging/*` не використовував `catNameSql` ЖОДНОГО разу до 2026-08-21.** §LANG-ARCH
  накрив `repo/*`, потім `lib/ai/*` — і проминув шар, що пише СТРІЧКУ, тобто найчастіший текст
  перед очима читача: англомовний бачив «Продукти» у сповіщенні й "Groceries" у списку категорій.
  **Новий рядок, що кладе назву категорії у видимий текст — байдуже з якого шару — йде через
  `catNameSql`.** `worker/lib/finance/categories-i18n.ts`:
  `catNameSql(locale, expr)` (інлайн-CASE, як `uahMult`; no-op для uk) у SQL-продюсерах +
  `localizeCatName` для JS-пост-мапи. Резолв keyed по ЗНАЧЕННЮ сідової назви (юзер-назва проходить
  як є). `api`-middleware дає `c.get("locale")`. Клієнт незмінний; перемикання мови інвалідує
  RTK-теги. **Нове місце, що віддає category_name клієнту — обгорни `catNameSql`.**
- **Мова відповіді — ЗАПИТУ, а не збереженого налаштування (§LANG, 2026-08-08).** Клієнт шле
  `x-mt-locale` на КОЖЕН запит (`prepareHeaders` + вручну в `lib/aiStream.ts` — стрім повз RTK
  Query); `UserDO.appEnv` кладе його в `env.UI_LOCALE`, і його читають ОБИДВА резолвери:
  `c.get("locale")` (мідлвар `routes/api/index.ts`) і `replyLangDirective`.
  **Збережена `app_state.locale` лишається ФОЛБЕКОМ** — для крону, TG і alarm, де запиту немає.
  ⚠️ **Чому:** колонка порожня в кожного, хто не відкривав Налаштування, а порожнє читалось як
  «українська» — тоді як дефолт клієнта англійська. Тобто новий акаунт і кожен демо-візитер бачили
  англійський екран, а назви категорій, тексти помилок і AI-проза приходили українською. Клієнт
  тепер ще й ПРОСТАВЛЯЄ мову на сервер, коли той не має жодної (`i18n/index.ts`) — інакше нічний
  крон і далі писав би звіт не тією мовою. Тримається `worker/test/locale.test.ts` (6 сценаріїв).
- **AI-локаль — лише user-facing** (`replyLangDirective(env)`, no-op для uk): chat/advisor/
  report/insight/budget/notify/**group**/**budget-план**. У `chatAdvice` — у ДИНАМІЧНИЙ блок (не в
  кеш-стабільну персону). Режим `conversation` відповідає МОВОЮ ПИТАННЯ, а налаштування вирішує
  лише нічию (повідомлення закоротке, щоб визначити мову).
- **§LANG-ARCH (2026-08-08) — ONE LANGUAGE IN, ONE LANGUAGE OUT.** The rewrite after the same bug
  was reported a THIRD time. The plumbing above was already correct; the answer still came back in
  Ukrainian on an English screen, because language was being *requested* rather than *produced*.
  Three defects, each sufficient on its own:
  1. **Four resolvers, two answers.** `routes/api/index.ts` read the reader first; `ownerLocale(db)`
     and two private copies in `notify.ts`/`deliver.ts` read `app_state.locale` ALONE. Twenty call
     sites — the whole AI surface, `/ingest`, `/setup`, `/import`, `/credentials`, the feed and the
     delivery layer — therefore ignored `x-mt-locale` entirely. And that column is EMPTY for anyone
     who never opened Settings and for every demo sandbox, while empty read as Ukrainian.
     → **`resolveLocale(env)` (`lib/platform/i18n.ts`) is now the single answer.** Reader first,
     stored preference only where there is no request (cron, Telegram, alarm). **A second reader of
     `app_state.locale` is a bug by construction.**
  2. **The prompts were WRITTEN in Ukrainian** — ~32 000 characters of it, opening with a 26k
     knowledge corpus as the first cached block. No instruction outvotes that mass; the model reads
     the language of its own instructions as the language of the job. → **Prompts are English, once.
     They are instructions, not UI, so there is still exactly ONE copy** and the prompt cache stays
     whole. Merchant strings, Cyrillic regex classes and the `uk` half of doc titles stay — they are
     data. A prompt names no language at all; that is `replyLangDirective`'s single job, and it is
     its OWN final system block in `chatAdvice`.
  3. **The DATA in the context was Ukrainian too.** `catNameSql` was used in `repo/*` (what the
     screen reads) and NOWHERE in `lib/ai/*`: the screen said "Groceries" while the model was handed
     «Продукти». One concept, two resolutions, diverging where the reader can see it — §CUR-PLAN
     again. → The AI snapshot, the taxonomy in `buildSystemPrefix`, the report, the insight and the
     chat tools all resolve through `catNameSql`.
     ⚠️ **Tool FILTERS too, not just tool output.** The model can only name a category it has been
     shown, so on an English screen it filters for "Groceries" — and `EFF_CAT_NAME LIKE '%Groceries%'`
     matches no stored row. The model then reports, truthfully and uselessly, that there is no such
     spending.
  4. **The demo inherited a language from the FIXTURE.** `worker/demo/dataset.json` is a dump of
     the owner's object, so its `app_state` carried a `locale` row — the owner's setting frozen when
     `scripts/seed-demo.mjs` last ran. That made the sandbox the ONE account holding a stored
     preference for someone who had never expressed one, so `resolveLocale` had a stored answer to
     prefer and the visitor's header never got a say. Symptom, reported precisely: the toggle reads
     EN, the shell is English, and category names and the whole AI answer come back Ukrainian —
     until the visitor toggles the language twice and the PUT overwrites the row.
     → `DEMO_EXCLUDED_STATE_KEYS` (`lib/platform/demo.ts`) drops it at LOAD time, so regenerating
     the fixture cannot put it back. **A stranger's language is a property of their request.**
  5. **Two raw `fetch`es bypassed `prepareHeaders`** (`i18n/index.ts`). The GET that DECIDES whether
     to adopt the server's language was asking without saying who was asking. Same class as
     `lib/aiStream.ts`. **Rule: a `fetch` outside RTK Query carries `x-mt-locale` by hand.**
  Held by `worker/test/locale.test.ts` (14 сценаріїв): `resolveLocale` in both directions, the
  header surviving the Worker→DO hop, the demo seed carrying no language, no
  Ukrainian category name in the AI context, no prompt naming a language, and a **budget of 2000
  Cyrillic characters** across `lib/ai` prompt strings (currently ~744, all of it data) — prose runs
  to thousands, so only prose can close that gap.
  ⚠️ **Enrich/OCR/parse — структурований вивід, але одне поле в них ПРОЗА.** `note` лягає в
  `transactions.ai_note` і показується під операцією, тож у нього є ВЛАСНА, адресна директива
  (`langNoteDirective`): перекладається лише `note`, а `clean_name` — імʼя власне («SILPO» лишається
  «Silpo») і не транслітерується ніколи. Промти лишаються українською — це інструкції.

## 🔴 Ops / деплой (рутина КОРИСТУВАЧА)

**✅ ЗАПУЩЕНО В ПРОДІ 2026-07-26 — `https://money.italik.dev`.**
Стан на 2026-08-24: міграції `finance` **до 0045**, `directory` **до 0010** (0036–0045 і directory
0006–**0010** — накотити перед деплоєм; **0008 `tg_links` обовʼязкова, інакше бот не маршрутизує
нікого, крім власника** — див. HISTORY 2026-08-21; **0009 `mcp_version` — без неї видача MCP-токена
падає, а вже виданий не відкликається**; **0010 `oauth_*` — без неї конектор Claude не підключиться
взагалі**),
D1 `directory` = `c72e2571-1fbb-44b2-8308-5a961aef9670`, секрети на місці,
**Google-застосунок ОПУБЛІКОВАНО** (не Testing) — отже відкрита реєстрація діє для будь-кого,
не лише для Test users. Історія блокерів — у `HISTORY.md`.

1. **Деплой:** `npm run deploy` (build + wrangler deploy). Нові міграції — спершу
   `npm run db:migrate:remote` (і `npm run db:dir:migrate:remote` для `directory`).
2. **Секрети** (`npx wrangler secret put`): `MONO_TOKEN`, `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `SECRETS_MASTER_KEY`,
   `OWNER_EMAIL`; бот — `TG_BOT_TOKEN`, `TG_SECRET`, `TG_CHAT_ID`.
   ⚠️ **`DEMO_ANTHROPIC_KEY` — постав ОКРЕМИЙ ключ із власним лімітом на боці Anthropic.**
   Без нього AI незнайомих людей у демо їде на ключі власника, і єдиний захист — стелі
   `lib/demo.ts` ($1/добу, $10/міс, 12/сесію, 200/добу) + форс Haiku. У логах воркера при
   цьому є `[demo] DEMO_ANTHROPIC_KEY is not set`.
   ⚠️ **`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`** — браузерні пуші (§PUSH). Згенерувати один раз:
   `node scripts/gen-vapid.mjs`, далі `npx wrangler secret put`. Без них картка сповіщень чесно
   каже «не налаштовано» і дозволу не просить. **Не ротувати** — усі підписки мовчки помруть.
   ⚠️ **`OWNER_EMAIL`** — пошта власника (значення лише у Worker-секреті, у репозиторії його немає).
   Заходити треба саме тим Google-акаунтом.
   ⚠️ **`SECRETS_MASTER_KEY` не ротувати** — збережені ключі юзерів стануть нечитабельними.
   `APP_PASSWORD` лишився лише як legacy-фолбек ключа підпису (парольного входу вже НЕМА).
3. **Google Cloud:** redirect URI мусить збігатись байт-у-байт із тим, що шле воркер —
   `https://money.italik.dev/auth/google/callback`. Застосунок **опубліковано** (2026-08-01),
   тож списку Test users більше немає — заходить будь-хто. Скоупи лише
   `openid`/`email`/`profile`: non-sensitive, тож publish не потребував verification.
4. **Акаунт народжується тільки через Google. Реєстрація ВІДКРИТА (2026-07-31).**
   ⚠️ З 2026-08-21 у застосунок можна ВВІЙТИ ще й через Telegram (`POST /auth/miniapp`,
   §TG-MINIAPP) — але лише в акаунт, який уже привʼязав свій чат. Створити нічого не може.
   Будь-хто з Google-акаунтом створює собі акаунт сам; рішення живе в ОДНОМУ місці —
   `loginWithGoogle`. Перемикач —
   `vars.SIGNUP` у `wrangler.jsonc` (`open` | `invite`), кіл-світч без правки коду. Стеля
   `DAILY_NEW_SIGNUPS=50/добу` рахує лише СТВОРЕННЯ рядка (колбек `allowSignup`), не входи.
   Owner-рядок і далі бутстрапиться в OAuth-callback рівно для `OWNER_EMAIL` — `is_owner=1`
   самореєстрація не дає ніколи. `disabled` відмовляється в обох режимах: це і є бан.
   📬 **Відгуки й перегляди демо** — там само, таб «Юзери» (owner-only, картка `FeedbackInbox`).
   `POST /api/feedback` відкритий і для ДЕМО (той, хто бачить застосунок уперше, і помічає
   незрозуміле); рядок їде в СПІЛЬНУ directory (міграція 0006), бо пісочниця живе добу, а власник
   не відкриває чужі обʼєкти. Адреса пошти під формою приходить із `OWNER_EMAIL` через
   `GET /api/feedback/contact` — **у бандл її не класти, репозиторій публічний.**
   Щоденні запуски демо — окрема таблиця `demo_daily` (directory 0007), київський день,
   інкремент ПІСЛЯ успішного сіду: `demo_sessions` вимітається через добу, а квотний лічильник
   `demo_new_<day>` рахує спроби включно з відмовленими. Це «скільки людей почали демо», не хіти.
   🧭 **Чек-лист першого запуску** (`FirstRun`, Налаштування → Дані) знає, що банку може НЕ БУТИ:
   без токена банківські кроки або `blocked` (даних ще нема — кнопка стала б обіцянкою, якої
   продукт не виконає), або `skipped` і поза лічильником (дані вже є з CSV/вручну — список, який
   неможливо завершити, це просто нагадування назавжди). «Зроблено» береться ЛИШЕ зі
   спостережуваного стану `/setup/status`, ніколи з прапорця «ми це запускали».
   👤 **Хто зайшов і чи користується** — таб «Юзери» в Налаштуваннях (owner-only). Лічильники
   (`last_seen_at`, `tx_count`, `accounts_count`, `has_*_key`) живуть у directory (міграція
   **0004**): DO звітує про СЕБЕ раз на добу з крон-фан-ауту, `last_seen_at` пише guard (раз на
   годину). Живий фан-аут по всіх DO на кожне відкриття сторінки був би тим повільнішим, чим
   більше юзерів він міряє. **Тільки обсяги — ніколи суми.**
5. **Перший запуск даних:** `POST /api/admin/import-legacy` (одноразово, переносить стару D1 у
   свій DO — без нього акаунт порожній) → Налаштування: перереєструвати вебхук (URL став
   per-user і підписаним) → курси → перекази.

⚠️ **Service worker тепер НАШ** (`src/sw.ts`, `injectManifest` з 2026-08-08 — генерований не вміє
ні `push`, ні POST share-target). Правило з нього не змінилось і не має: **жодного
`navigateFallback`**. Решта — нижче.

### ⚠️ Два шари, що можуть проковтнути роут воркера (обидва ловились у проді)
Новий роут поза `/api/*` треба додати В ОБИДВА місця, інакше він мовчки віддає SPA-шелл:
- **`wrangler.jsonc` → `assets.run_worker_first`** — роутер статики Cloudflare відповідає на
  навігаційні GET сам і воркер не будить.
  ⚠️ **Це стосується і НЕ-навігаційних роутів, які додаються пізніше** (`/mcp`, §MCP): симптом
  там інший — клієнт скаржиться на невалідний JSON, бо отримав `index.html`, — і читається як
  «сервер зламався», а не «статика перекрила воркер».
- **`vite.config.ts` → SW.** Тут фолбеку більше НЕМА (`navigateFallback: null`): service worker
  кешує лише статику й на навігації не відповідає взагалі. Не повертати `navigateFallback` —
  саме він двічі ламав `/demo` і `/auth/google/start`, і його денилист треба було тримати
  синхронним з роутером у шарі, якого `curl` не бачить.
- **Перевірка:** `curl -H 'Accept: text/html' <url>/роут` доводить лише серверний бік. Клієнтський
  шар відтворюється тільки в реальному браузері.

## 🧭 AI 4.0 — фаза ЗАКРИТА, ТЗ у `HISTORY.md`

§A1 факти · §A2 ціни · §A3 web_search · §A4 tool-use · §A5 корпус знань — усе реалізовано
(2026-07-19/20). Обґрунтування й початковий дизайн — `HISTORY.md`. Опційні хвости — `ROADMAP.md`.

## ➡️ Що далі
**Платформа-фаза ЗАКРИТА, проєкт у проді з 2026-07-26** (публічне портфоліо «зроблено за
допомоги AI»). **Структурна фаза (ARCH) теж закрита 2026-08-07:** `api.ts` більше не існує,
SQL лише в `repo/`, форма кожної відповіді оголошена один раз у `shared/api/`, `ai.ts` — лише
транспорт; тримається лінтами C1–C10 (`ARCHITECTURE.md §3`). Журнали фаз — `HISTORY.md`.
**Банківська фаза закрита 2026-08-13** (`BANKS.md §5`): один писар інжесту, спільна нормалізація,
пейсинг і вибірка від провайдера, резолвер креденшелів, полінг, `bank_connections` із читачем і
сам провайдер ПриватБанку. ⚠️ Приват НЕ перевірений на живому API — перший синк, найімовірніше,
потребує раунду правок (`ROADMAP.md`).
Жива черга — **`ROADMAP.md`**.
**⏸ Свідомо відкладено:** хвости Goals (графік для цілі-банки, звʼязок події з ціллю).
**UI/UX — читати `DESIGN.md` ПЕРШИМ** (там §2 «🔒 Падінг картки» — правило системи), зміни
фіксувати в його «Журналі рішень».
**Перед деплоєм:** `npm run check` + `npm run build`, міграції на remote — див. §Ops.
