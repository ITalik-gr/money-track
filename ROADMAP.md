# ROADMAP — жива черга задач

> **Тут ЛИШЕ те, що ще треба зробити.** Зроблене звідси **видаляється** — не викреслюється, не
> позначається ✅. Файл має ставати коротшим, коли робота завершується.
>
> Куди йде результат: durable-правило → відповідний `docs/*.md` + рядок в індекс § у `CLAUDE.md` ·
> наратив «що робив» → згори в `HISTORY.md` · дизайн-рішення → «Журнал рішень» `DESIGN.md`.
>
> Останнє оновлення: **2026-09-20**.

## 🚦 Як працювати з цим файлом

1. Бери **найвищу невиконану задачу** з «Черги». Не перестрибуй без причини.
2. Спочатку прочитай `docs/*.md` того домену, якого задача торкається (таблиця в `CLAUDE.md`).
3. **Green-бар перед «готово»:** `npm run check` + `npm run build`.
4. **Доробив → ВИДАЛИ картку звідси.** Нове/баг → у «Беклог» чи «Ідеї фіч».
5. **Live-звірку в чергу НЕ писати.** Власник ганяє її сам і повідомляє, якщо щось не так.
6. Один PR / логічний блок = одна задача.

### 📇 Формат картки

```
### <Назва одним рядком>
**Ціль:** що має стати правдою після цієї роботи (не «що зробити», а «що працюватиме»).
**Файли:** де це живе (щоб не шукати).
**Кроки:** 2-5 пунктів, кожен перевірюваний.
**Готово-коли:** умова, яку можна перевірити без обговорення.
```

Мінімум — один рядок у «Черзі» від власника. Модель сама розкладає його в картку перед роботою.

---

## 🔥 Черга (роби згори вниз)

> ⚠️ **The «UI/live» section below is blocked on the OWNER** — a live screen or a live connector.
> The build cards under it are not: they are self-contained and an unattended run can finish them.
>
> Closed 2026-09-18 by the owner's own live pass: the Statistics second sweep (Overview / Trends /
> Compare, cashflow calendar, month forecast, health index — all read right on screen), the `/plan`
> and Accounts design cards, the un-reviewed Advisor / Subscriptions / Categories screens, and the
> three §BASE-CUR screens in a non-hryvnia base. Still open because he could not judge them from
> the screen: the 13 no-op modifier classes, and the STYLES 0.5/4 conflicts.
>
> **2026-09-21 — §BIZ-SPLIT.** `/fop` → `/business`: five tabs, the business is the page and ФОП
> is a switch inside it, plus a sample mode so the screen can be judged without a real business.
> The «no gaps» report had a second cause worth knowing — seven CSS variables that do not exist,
> now closed by lint C15 (`docs/UI.md`). The three ФОП audit findings below are still open.
>
> **2026-09-20 — §FOP-GATE.** The ФОП module is hidden from every account but the owner's, the
> demo included (his call: «ще і близько поки не так як я планував»). One gate, five doors,
> `docs/TAX.md §0.15`. The three ФОП audit findings in the backlog below are NOT closed by this —
> they are still wrong, just wrong where only he can see them.
>
> Closed 2026-09-20 (owner's screenshot, not a queue card): §DIGEST-HOUR — the hour the app speaks
> is a setting now (Сповіщення → «Коли надсилати», default 20:00) and the cron is one hourly tick;
> §PLAN-LATE — a scheduled payment is announced 3 days AFTER its date, never before it. Both in
> `docs/AI.md`.
>
> Closed 2026-09-17: the whole-perimeter security pass (docs/PERIMETER.md), §QUICK-ADD (iPhone shortcuts, write-only token), statement import (the real MyRaif file reconciles; §CSV-STATE), §VOID-PAIR,
> §RENAME-MEMORY, §MERCH-QUIET. The one-off §ENRICH-GATE backfill was dropped — the owner: not
> needed, the next billing cycle heals it.
>
> Closed 2026-09-04 (overnight): C11, §ENV-PARTS, §ADVICE-LOOP, and the C3 slack — the last one
> written up as «C3 has no ratchet DOWN», **which turned out to be false**. See `HISTORY.md`.

### UI-черга з живого прода

- **13 класів-модифікаторів, що НІЧОГО не роблять** — перелічені в `STYLELESS_OK`
  (`scripts/check-styles-used.mjs`): `advisor-main`, `pulse-cats`, `top-subs-card`, `lp-top-signin`,
  `goal-jar`, `tip-net`, `alt`… Кожен — або залишок, або намір, який не дописали, і відрізнити одне
  від іншого можна лише з екраном перед очима. **Список має скорочуватись під час живого проходу,
  а не рости.**

### STYLES фази 0.5 + 4 — потребує ОКА власника (`STYLES.md`)

- **Фаза 0.5 — 8 селекторів, що тихо конфліктують.** Те, що рендериться сьогодні, — їхній МЕРДЖ,
  якого ніхто не писав. Згортання ЗМІНЮЄ рендер, тож кожен потребує живого before/after.
- **Фаза 4 — справжнє доменне групування.** Рухає правила через межі каскаду (`@layer` пропущено
  з тієї ж причини).
**Готово-коли:** 8 конфліктів розвʼязані проти живих екранів, без візуальних змін, яких власник
не схвалив.

### MCP для ДРУГОГО асистента (ChatGPT) — лишилась ЖИВА перевірка

**Зроблено 2026-09-02** (`docs/PERIMETER.md` §MCP-OAUTH, «готовність до другого клієнта»): `iss`
у кожній відповіді авторизації + прапорець RFC 9207, аліас `/.well-known/openid-configuration`,
преflight на `/.well-known/*` і на `/mcp` (перед гардом), `WWW-Authenticate` у
`expose-headers`, і строгі схеми інструментів (`required` завжди присутній +
`additionalProperties: false`). Форма редіректу другого клієнта пінується в `oauth.test.ts` поруч
із Claude, разом із CSP сторінки згоди для його оріджина.

**Лишилось те, чого код перевірити не може: підключити НАЖИВО.** Усе вище зроблено проти
специфікацій і проти тестів — тобто проти того, як клієнти МАЮТЬ поводитись. Єдине, що доводить
сумісність, — реальний конектор.
**Готово-коли:** ChatGPT (або інший асистент) підключився без правок у `chat-tools.ts`, і якщо
щось довелось міняти — це записано тут, а не в памʼяті.

---

## 🔨 Збірка (самодостатнє — не чекає власника)

### Jev (TypeSafe) — what is left after phase 4
Phases 1–4 are built and measured (`docs/JEV.md §7`); `AI_JUDGE = "jev"` is on, owner-only.
- **More held-out cases before any line moves.** The §SUB-REVIEW lines (0.5 / 0.4) sit in a 0.1-wide
  gap measured on 20 merchants. Add merchants to `worker/test/__eval__/sites.json` FIRST.
- **Search rerank — re-measure on a newer Jev** (`node scripts/eval-sites.mjs --site search`); wire it
  into `appendSemantic` only when a line separates «shown» from «hidden» (§7.4).
- **Other users** — a per-user TypeSafe key through `user_secrets`, like the Anthropic one (§10).
- **`known_plan`** — only with a real case whose bank name differs from the plan's («X Corp.» vs
  «Twitter»). The Київстар/EasyPay report was a code bug, not this.

### SQLite `LOWER() LIKE` with Cyrillic — two more sites
SQLite folds case for ASCII only, so `LOWER(x) LIKE '%київстар%'` misses «Київстар». Fixed in
`linkPlanHistory` (2026-09-21, pre-filter moved to the amount). Same shape still in
`consensusCategory` (`enrich.ts`, §R6 merchant consensus) and `repo/transactions.ts:888`.
Fix: filter by something script-free in SQL and match the name in JS, as `linkPlanHistory` now does.
A lint could flag `LOWER(` next to `LIKE` in worker SQL.


---

## 📌 Беклог (з відомим корінням, без дати)

### ФОП — findings of audit A1 (2026-09-18, overnight run)

Each one is a divergence the audit found and deliberately did NOT fix blind: all three need a canon
decision about what the right answer IS, and a tax figure guessed confidently is the one failure in
this project that costs money (`docs/TAX.md` §1).

- ⬜ **Money returned to a client does not reduce the quarter's income.** `INCOME_WHERE` requires
  `t.amount > 0`, so a returned advance leaves the base it was counted in untouched, and the app
  bills 5% + 1% on money the user gave back. The direction is the safe one (it overstates what is
  owed, so no penalty), which is exactly why it can sit unnoticed. The fix is a §-decision, not a
  query: on a cash basis a return in the SAME period reduces income, and a return in a LATER one
  does not touch the closed quarter — so it needs the §REFUND treatment for the income side
  (`repo/tax.ts`, `docs/TAX.md` §2).
- ⬜ **A future-dated business receipt is taxed but not counted against the annual ceiling.**
  `taxStatus` reads the quarter over `[quarterStart, nextQuarter)` and the annual limit over
  `[yearStart, now)`, so a receipt dated tomorrow (a manual entry accepts any `time`) accrues
  ЄП/ВЗ while §TAX-LIMIT ignores it. One window has to win; picking one is a canon call
  (`lib/finance/tax.ts`, `repo/tax.ts`).
- ⬜ **The limit's pace has no minimum window, so early January projects from one day.**
  `daysElapsed` is `max(1, …)`, so a single receipt on 1 January makes `perDay` the whole receipt
  and the screen says «at this pace you cross the ceiling on the 11th». §CADENCE already owns the
  question «is this delta meaningful» for the rest of the app; the limit projection never asked it
  (`lib/finance/tax.ts`).

### Банки

- ⬜ **Приват НЕ перевірений на живому API** — немає ФОП-рахунку й немає пісочниці. Перевірено лише
  мапінг (17 сценаріїв). Перший живий прогін, найімовірніше, потребує одного раунду правок:
  параметр `ID` (груповий режим) і точні назви полів балансу.
- ⬜ **Рішення ДО першого синку Привату:** ФОП-рахунок — це оборот, а не твої гроші, а
  `accounts.role` знає лише `liquid|investment`. Без третього значення перший синк зрушить подушку,
  runway і burn (`BANKS.md §2.2`).
- ⬜ **Відкликання операції.** Рядок, збережений як `p` (в обробці), який потім став сторнованим,
  лишається збереженим: у канону немає стану «скасовано». Робити з живим рахунком, не наосліп.

### Багато банків, одна аналітика (дослідження — `BANKS.md §7`)

> Мета власника: людина підключає кілька своїх банків — і колись крипту — і отримує одну аналітику
> над усім. Дослідження зроблено, не збудовано нічого.

- ⬜ **Обрати агрегатора, потім зробити рефактор, якого він вимагає.** За кордоном інтегрують не
  банки, а ОДНОГО агрегатора: ~9 700 установ США не публікують персонального API, рівно як і Приват
  (`BANKS.md §1`, у національному масштабі). Рекомендований порядок: **Teller** (self-serve,
  безкоштовно 100 живих підключень, US) → **SimpleFIN** (~$15/рік платить КОРИСТУВАЧ, read-only) →
  **Enable Banking** (EU, безкоштовний обмежений тариф) → Plaid, лише коли дзвінок із продажником
  вартий того. ⚠️ Безкоштовний тариф GoCardless/Nordigen ЗАКРИТО для нових — не планувати на нього.
- ⬜ **Справжня ціна — не HTTP, а `bankCredential(env, id)`** (§BANK-CRED): він резолвить ОДИН
  креденшел на провайдера, а агрегатор віддає один на УСТАНОВУ. `bank_connections` уже має
  правильну форму (рядок на креденшел) — саме туди сідає флоу підключення.
- ⬜ **Два записані припущення ламаються на першому іноземному рахунку:** настінний час без зони —
  київський (§BANK-PARSE), а закритий бюджетний місяць зберігається в гривні (§BASE-CUR). §APP_TZ
  складніший — константа на деплой має стати константою на юзера.
- ⬜ **Крипта — це дві роботи, не одна:** біржові рахунки = read-only API-ключі (юзерські,
  зберігаються як mono-токен); on-chain гаманці = публічна адреса й жодного креденшела (**Zerion**
  API — ⚠️ Zapper закрився 2026-08-03). У будь-якому разі `role: 'investment'`, ніколи не подушка.

### Мультипровайдерний AI *(відкладено 2026-07-26, «колись потім»)*

Дати юзеру вибір Anthropic / OpenAI / Grok. **Не «на ізі»:** розходяться tool-use
(`runToolConversation` написаний під блоки Anthropic), prompt-кеш (`cache_control ttl:1h` — на
ньому тримається економіка корпусу §A5), серверний `web_search` і таблиці цін `priceFor`.
**Дешевий шлях:** адаптер лише для одноходових викликів (enrich/OCR/parse/insight), агентний чат
лишити на Anthropic; Grok і DeepSeek дають OpenAI-сумісний ендпоінт — один адаптер відкриває
кількох. Шов уже прорізано: `worker/lib/ai/json.ts`, усе вище нього провайдер-агностичне.
⚠️ Зачепить `demoClamp` — він знає лише моделі Anthropic.
**Готово-коли:** ключ будь-якого підтримуваного провайдера дає робочу категоризацію, а UI чесно
каже, які фічі доступні для цього провайдера.

### Хвости AI 4.0 *(фаза закрита)*

- Юзер-аплоад власних PDF/MD у корпус знань (R2 + D1). Зараз лише .md/.txt через читання на клієнті.
- Нативний PDF `document`-блок (100 стор Haiku / 600 Sonnet) + `citations`.
- `output_config.format` (structured outputs) замість хака `repairTruncatedJson`.

### Архітектурне / потребує рішення

- **Масові прогони — МЕХАНІКА ЗРОБЛЕНА (2026-09-20), лишилось підключити реальний вид.**
  Черга вміє пачки: `progress_done/total` (міграція 0053), виконавець, що робить одну пачку за
  тік і лишає рядок `queued`, і зупинка на «прогрес мусить ЗРОСТАТИ» (§A6-BATCH у `docs/AI.md`).
  Планувальник DO чіпати не довелось — `hasQueuedJobs` + `armAlarm` уже роблять цикл.
  Запінено на фіктивному `noop_batch`: «10 пачок по 3 → done рівно за 10 тіків».
  **Лишилось:** повісити на це `enrichPending` (ре-світ / батч-enrich) — окремим видом задачі з
  власним `NotifKind` і шаблоном. Це прохід НА ЖИВОМУ ВЛАСНИКОВІ, не нічний: саме корисне
  навантаження без живого ключа не проганяється, тобто ту частину, що коштує, перевірити нічим.

- **Lazy-enrich** (варіант B) — за узгодженням.


---

## 🎨 Дизайн — майбутнє

> Як працювати — `DESIGN.md §9` (skills: `impeccable` основний, `review-animations` для руху).
> Кожну зміну фіксувати в «Журналі рішень» DESIGN.md.

- **Статистика** — редизайн вкладок **Огляд + Категорії/Тренди**. Потрібен live-скрін вкладок.
- **Чек-лист для сторінки, переглянутої вживу:** локальний хардкод-колір / тінь / `transition:all` /
  тіснота.
- **Розмітка для >1920px** — як стоять блоки на широких моніторах.

---

## 💡 Ідеї фіч — брейнсторм для тріажу

> Сирий список для пріоритезації. **[нове]** / **[лвл-ап]** / **[тех]**; розмір S/M/L — груба
> оцінка. Реалізоване звідси **видаляється** (не викреслюється).

### ФОП / податки *(знято з паузи 2026-09-18 — ядро поїхало в картку «ФОП / податковий модуль» вище)*

- **[нове] Податковий конверт-автовідкладання (S/M).** З кожного доходу відкладати % (ЄП 5% + ЄСВ +
  ВЗ) у віртуальний конверт → видно, скільки з балансу насправді «не твоє».
- **[нове] Податковий календар ФОП (M).** Дедлайни ЄП/ЄСВ/ВЗ із сумами, відлік, нагадування;
  «сплачено» → списання з конверта.
- **[нове] Трекер річного ліміту доходу ФОП (S).** Прогрес-бар до ліміту групи + прогноз перевищення.
- **[нове] Розрахунок ЄП за квартал (S).** Дохід × ставка; валютний дохід — за курсом НБУ на дату.
- **[нове] Валютний дохід ФОП — курс НБУ на дату (M).** Для USD/EUR-інвойсів фіксувати офіційний
  курс дня зарахування.
- **[лвл-ап] Позначка «робочі витрати» (S).** Тег бізнес/особисте → окремий підсумок.

### Порадник / AI

- **[нове] Розумні цілі-виклики (S).** AI пропонує реалістичний виклик («−15% на доставку =
  +1200 ₴») і трекає.

### Валюти / інвестиції / нетворт

- **[лвл-ап] Вплив курсу окремою цифрою (S).** Базу зроблено (`rate_history` 0024, нетворт рахує
  кожну точку курсом своєї дати). Лишилось розділити зміну нетворту на «рух грошей» і «рух курсу».
  Має сенс, коли історія накопичиться за кілька місяців.

### UX / продуктивність

- **[лвл-ап] Плавність дашборду (S).** Дотягнути наявні анімації, прибрати ривки.

### Стилі (див. `STYLES.md`)

> The two «orphaned media queries» / «duplicated blocks» entries that lived here were
> promoted into the **C11** card in the queue above (2026-09-04): probing turned them from
> ideas into eight named cases, three of which break a screen. Nothing is left here.
