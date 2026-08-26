# ROADMAP — жива черга задач і фіч

> **Це постійний файл. Тут — ЛИШЕ те, що ще треба зробити.** Зроблене звідси **видаляється**;
> якщо результат важливий довгостроково — стислий підсумок їде в `CLAUDE.md`, наратив — у
> `HISTORY.md`. Довідник/інваріанти → `CLAUDE.md`. Дизайн → `DESIGN.md`. Шари й лінти →
> `ARCHITECTURE.md`.
>
> **A card marked ✅ does not live here.** What has been closed is narrated in `HISTORY.md`; the
> durable rule it bought goes to `CLAUDE.md`, next to the invariant it protects. This file gets
> shorter, never longer, when work finishes.
>
> Останнє оновлення: **2026-08-22**.
>
> ⚠️ **Не починай новий аудиторський прохід без нової поверхні.** Дванадцять проходів
> 2026-08-21 вичерпали метод «шукати другі копії правила»: останні два дали по одній дрібниці.
> Що метод НЕ бачить — реальні дані власника, живі екрани, справжній API ПриватБанку. Саме
> звідти прийшов блок 0 нижче.

## 🚦 Як працювати з цим файлом

1. Бери **найвищу невиконану задачу** з «Черги». Не перестрибуй без причини.
2. Задача = картка: **Ціль · Файли · Кроки · Готово-коли**. Спочатку прочитай згадані файли.
3. **Green-бар перед «готово»:** `npm run check` (tsc + лінти C1–C10 + тести) + `npm run build`.
   Гроші/статистика — лише через `worker/lib/finance/stats.ts`, не дублюй SQL.
4. **UI/UX** — спершу `DESIGN.md`, зміну фіксуй у його «Журналі рішень». Хук impeccable ганяє
   детектор — знайдене виправляй, не глуши.
5. **Доробив → ВИДАЛИ картку звідси.** Нове/баг → у «Беклог» чи «Ідеї фіч».
6. **Live-звірку в чергу НЕ писати.** Користувач ганяє її сам і повідомляє, якщо щось не так.
7. Один PR / логічний блок = одна задача.

---

## 🎨 UI-черга від власника (2026-08-14, з живого прода)

> Знято зі скріншотів після деплою. **Кожен пункт — те, що власник побачив на власних даних.**
> Закриваю згори вниз; зроблене видаляю звідси.

**Бюджети**
- [x] §BUDGET-MEMORY — конверт памʼятає минулий місяць (перенесення залишку І боргу, історія
      закритих місяців). Заразом полагоджено `budgets.rollover`, який існував із міграції 0017 і
      нічого не робив.
- [ ] Лишилось із запиту власника: **дизайн самої сторінки `/plan`** — картки конвертів і
      автобюджет переглянути вживу (смуга історії й бейдж перенесення вже є).

**Рахунки**
- [ ] Назви груп рахунків і перерозподіл колонок. *(Сам баг «Райффайзен у групі Monobank» закрито:
      це був `accounts.provider` DEFAULT `'mono'` у `createManual` — міграція 0042.)*

**Не переглянуто вживу після правок**
- [ ] Порадник, Підписки, Категорії — чек-лист із §Дизайн нижче.
- [ ] **13 класів-модифікаторів, що НІЧОГО не роблять** — перелічені в `STYLELESS_OK`
      (`scripts/check-styles-used.mjs`): `advisor-main`, `pulse-cats`, `top-subs-card`,
      `lp-top-signin`, `goal-jar`, `tip-net`, `alt`… Кожен — або залишок, або намір, який не
      дописали, і відрізнити одне від іншого можна лише з екраном перед очима. **Список має
      скорочуватись під час живого проходу, а не рости.**

## 🔥 Черга (роби згори вниз)

### 0b. MCP for a SECOND assistant (ChatGPT), when it is wanted

> Asked for on 2026-08-24, deliberately not started: it is a real piece of work and nothing depends
> on it. Parked here so the reason it is cheap does not get forgotten.

**Where it already stands.** Almost none of this is Claude-specific. `/mcp` is a plain Streamable
HTTP MCP server; the authorization server implements the standards (RFC 7591 DCR, PKCE S256,
RFC 8707 resource indicators, RFC 9728 + RFC 8414 discovery) rather than anything Anthropic-shaped.
The one place Claude appears by name is a comment.

**What will actually need work,** and it is all at the edges:
- **Redirect URIs.** OpenAI's callback host has to be accepted; ours are pre-registered per client
  through DCR, so this may need nothing at all — but it must be VERIFIED against the real client,
  not assumed. The loopback exemption is already there for CLI clients.
- **Discovery probing differs per client.** Claude falls back to
  `/.well-known/oauth-protected-resource/<path>` then the bare path; another client may probe a
  different order or expect OIDC-style metadata. Cheap to add, invisible when missing — the symptom
  is "cannot reach the server" with zero traffic at the OAuth endpoints.
- **The consent page's CSP** lists the client's redirect origin, derived from the registered value,
  so it should follow automatically. Worth an explicit check: this is the exact thing that shipped
  broken for Claude (§MCP-OAUTH).
- **Tool schema strictness.** Some clients validate JSON Schema more strictly than Anthropic's
  tool-use does (e.g. requiring `additionalProperties`), and `financeChatTools()` was written for
  the latter. A schema the client rejects means the tool silently does not exist.

**Готово-коли:** a second assistant connects with no change to `chat-tools.ts`, and
`oauth.test.ts` has the second client's redirect shape pinned beside Claude's.


### 0.0 Нагадай юзеру. Треба з підписками розібратись, особливо на сторінці. Зараз пише іноді що там немає транзакцій таких, але нижче пише що є, але якщо на неї перейти - 404. Та і взагалі бредово працює. Треба щоб автоматично ще і аналізувало транзакції і розпізнавало підписки, бо зараз тіки вручну - морока, ті в принципі все погано працює це. Треба покращити, навіть якщо це чуть чуть дорожче буде. Проаналіувати як краще буде покращити цей фунціонал, які варіанти, скільки кожен затрат збільшить і тд


### 0. Від власника, з живого користування (2026-08-21) — роби згори вниз

> Знято зі слів власника після дня з продом. **Це найцінніша черга у файлі:** усі дванадцять
> аудиторських проходів разом не бачили жодного з цих пунктів, бо кожен видно лише з екрана або з
> телефона. Цитати власника лишені як є — це дані, не проза.
>
> **Закрито 2026-08-21:** кнопки бота (§TG-SURFACE) · «відвʼязав, а бот працює» (§TG-OFF) · вхід у
> міні-апці (§TG-MINIAPP) · три дефекти сторінки категорії (§I18N-DYNKEY, §CAT-PARTS).
> **Закрито 2026-08-22:** фолбек власника для входу в міні-апці · перекошений падінг списків,
> приліплені блоки й розклад з однієї частки · клік по стовпчику тренду відкриває операції місяця ·
> §FX-COST згорнуто до однієї цифри.
> ⚠️ **Щоб побачити це в проді, потрібен `npm run deploy`** — попередній Telegram-блок лежав
> незадеплоєним, і саме тому кнопок не було видно.

#### 0.1 Сторінка категорії — ЛИШИЛАСЬ ГЛИБИНА (три дефекти закрито 2026-08-21)

Закрито: сирий `imp.optional` (плюс лінт на весь клас — §I18N-DYNKEY), підпис плитки, що не
слухав перемикач періоду, заголовок «12 місяців» над 24-місячним графіком і 15 стовпців
до-історії в ньому, і перший блок глибини — «З чого складається» (§CAT-PARTS).

**Що ще варте додавання** (кандидати з N7; обирати з розумом, не додавати число, яке вже є деінде
в іншій формі): розподіл по днях тижня / числах місяця ДЛЯ ЦІЄЇ категорії (канон є — `weekday.ts`,
`buildDomAnalytics`); прогноз кінця місяця саме для категорії (`projectSpend` уже вміє); вагомість
(`EFF_IMPORTANCE`) в межах категорії — скільки з неї обовʼязкове.
⚠️ Спершу `DESIGN.md`, зміну — в його «Журнал рішень».
⚠️ Порівняння з торішнім періодом і середній чек уже Є — не дублювати.

#### 0.1a «Підписки» як КАТЕГОРІЯ — рішення власника потрібне

> «є ж у мене софт і хмара, та підписки. підписки на клауд потрапляють туди і туди»

`CLAUDE.md` уже каже: **підписка ≠ категорія «Підписки»** — це ВЛАСТИВІСТЬ операції
(`planned_id`), а не місце в таксономії. Категорія відповідає на «на що витрачено» (хмара — це
Софт), план — на «чи це регулярний платіж». Тож категорія з такою назвою конкурує з іншими за ті
самі рядки, і куди впаде конкретне списання, вирішує випадковість: ані enrich, ані людина не мають
правила, яке з двох правильне.

**Пропозиція:** прибрати категорію «Підписки» (перенести її операції в Софт/Комуналку/…), а
питання «скільки я віддаю за підписки» лишити сторінці Підписок і каноновому
`monthlyPlannedUAH`. Плюс дешевий блок на сторінці категорії: «з них підписки: X ₴ (N планів)» —
`planned_id` уже є на транзакціях, тож це один запит і жодного нового поняття.
**Готово-коли:** власник вирішив, чи прибирати категорію.
✅ 2026-08-27 — блок «з них підписки» на сторінці категорії зроблено (§CAT-SUBS).

#### 0.2 Перевірити правильність кожного блока статистики — ПЕРШИЙ ПРОХІД ЗРОБЛЕНО 2026-08-27

> «Перевірити правильність всієї статистики, кожного блока»

Це не той самий прохід, що дванадцять аудитів: ті звіряли КОД із каноном, а це — звірка ЧИСЕЛ на
реальних даних власника. Метод: блок за блоком, кожне число проти незалежного способу його дістати
(експорт, інший екран, ручний підрахунок), і кожен розбіг — картка.

**Зійшлось точно** (знімок Порадника проти інструментів чату — інша реалізація SQL):
`by_importance` = 90-денні витрати до копійки · `this_month.spend` = сумі категорій за той період ·
`budgetStatus.spent` = канонічному запиту по всіх 8 категоріях · `monthly_trend` поточного місяця =
`this_month` · `own_funds = подушка − борг` · `runway = подушка ÷ burn`.

**Знайдено й закрито:** §LEVEL-WINDOW (рівень ділився на місяці, яких не було — занижував КОЖНУ
категорію в 1.5 раза, робив автобюджет недосяжним і runway оптимістичним) · §AI-AVGNAME (одне
імʼя `avg_month_uah` на дві різні величини в одному payload).

**Названо, не виправлено:** `subscriptions_monthly_uah` 2 770 проти суми списку 2 771 — округлення
пункту проти округлення суми.

**Лишилось для наступного проходу:** блоки, яких МСР не бачить — Огляд/Тренди/Порівняння на екрані
(вісь, бакети, дельти), Cashflow-календар, прогноз місяця, Індекс здоровʼя. Їх треба звіряти з
відкритим екраном.

#### 0.3 5–7 нових статистик (Статистика + Порадник)

> «Додати більше статистик, штук 5-7. На сторінці статистика та порадника.»

⚠️ Те саме правило, що для 0.1: кожен новий блок має відповідати на питання, на яке сторінка ЩЕ не
відповідає. Спершу список кандидатів із формулюванням питання, ПОТІМ код.

**Зроблено 2026-08-27 (§SUB-PAGE + §CAT-SUBS)** — пʼять із них, усі на новій сторінці підписки та
на сторінці категорії, кожен із власним питанням:
1. «Скільки ця підписка вже мені коштувала» — сума ВСІХ привʼязаних списань від першого.
2. «Чи вона подорожчала» — останнє списання проти оголошеного, у валюті білінгу (курс ≠ ціна).
3. «Чи списують так часто, як каже план» — реальна каденція між списаннями проти оголошеної.
4. «Скільки це на рік» + «яку частку займає» — від підписок, від категорії, від місячних витрат.
5. «Скільки з категорії — це підписки» (§CAT-SUBS), із часткою від канонічного місячного рівня.

**Зроблено 2026-08-27 (§SHAPE)** — три блоки на вкладці «Тренди», про ФОРМУ періоду, а не розмір:
6. «Кілька великих платежів чи сотня дрібних» — розподіл за розміром чека (середній чек і максимум
   — рівно ті дві цифри, що це ховають).
7. «Яка частка витрат не проходить через жоден конверт» — сліпа пляма всієї фічі бюджетів.
8. «Скільки ГРОШЕЙ застосунок не зміг віднести до категорії» — чесна засторога до всіх інших чисел
   на сторінці (стрічка рахує операції, а не суму).

Черга 0.3 закрита: вісім блоків замість 5-7.

### 1. STYLES phase 0.5 + 4 — needs the owner's EYE (`STYLES.md`)

The stylesheet is split (thirteen parts under `src/styles/`, `index.css` is imports only, lint **C8**
keeps it that way), the 76 byte-identical dead blocks are gone and C9 has since removed 59 more.
Two phases stayed behind on purpose, because neither can be done blind:

- **Phase 0.5 — the 8 quietly conflicting selectors.** What renders today is their MERGE, which
  nobody wrote. Collapsing them CHANGES rendering, so each one needs a live before/after.
- **Phase 4 — true domain grouping.** It moves rules across cascade boundaries. `@layer` was
  skipped for the same reason.

⚠️ The exception mechanism is now a RATCHET: `settings.css` overflowed, its page shell moved to
`settings-shell.css` (§SET-FLOW), and after the C9 sweep it dropped under the cap and **lost its
exception entirely**. `domains-a.css` is down to 1 105. An exception may never grow — the next
overflow gets a seam, not a raised cap. **This happened again on 2026-08-21** and the ratchet held
three times in one session: `domains-a.css` overflowed → `analytics.css` (the thirteenth part);
`worker/routes/api/analytics.ts` overflowed twice → `lib/finance/price-drift.ts` and
`lib/finance/forecast.ts`, both of which were judgement sitting in transport anyway; and
`lib/finance/stats.ts` overflowed → `savingsRatePct` went to `finance.ts`, because a two-argument
ratio is not SQL canon.

**Done when:** the 8 conflicts are resolved against live screens, with no visual change the owner
did not approve.

### 2. §BASE-CUR — three screens to look at with dollars selected

The display currency is in (`CLAUDE.md §BASE-CUR`): Settings → Account → «Валюта показу», and an
account that never chose one follows its language, so an English visitor and the demo land on USD.
The numbers are covered by tests and by lint C10; what is NOT covered is how they LOOK, and three
places are the likely offenders because their layout was sized around hryvnia figures:

- **Dashboard hero + KPI row** — a hryvnia total is 4–5 digits, a dollar total is 3. Columns sized
  for the long form will look empty, and `useCountUp` animates a much shorter number.
- **`/plan` envelopes** — the limits round to a whole unit in a foreign base (50 ₴ converts to
  $1.21, which is not a round number in either currency). Worth checking that the proposals read as
  decisions rather than as arithmetic.
- **Charts with a ₴-shaped Y axis** — `width="auto"` should handle it, but the axis is the one
  place where a shorter number changes the plot area rather than just the label.

⚠️ Also NOT verified live: the very first paint of a fresh English account, where the language
default applies before `/rates` has answered.

**Done when:** the owner has switched to USD and looked at those three.

### 3. The `.section-head` gap fix is APPLIED — it needs eyes, not work

`section > .section-head:first-child { margin-top: 26px }` is now global (`styles/shell.css`), and
the scoped workaround on the category page kept only its wider 34px. This restores the design
system's section gap on the 67 blocks that group themselves semantically and had silently lost it —
which means **vertical rhythm changed on every page using `<section>` at once**. Two rules were
given explicit `:first-child` to keep winning (`.acct-sec`, cards), because their spacing is
deliberate.

**Done when:** the owner has looked at Dashboard, Stats and Accounts and confirmed nothing got
loose. Revert is one line.

> **2026-08-21, owner:** looked over and nothing seemed off. Left in the queue because «наче все
> гуд» over one session is not the same as a deliberate before/after on the eight conflicting
> selectors below — the point of cards 1–3 is a comparison, not an absence of complaints.

## 📌 Беклог (з відомим корінням, без дати)

### Фічі, відкладені свідомо

**Many banks, one analytics surface (researched 2026-08-27 — see `BANKS.md §7`)**
> The owner's stated goal: a person connects several of their own banks — and one day crypto — and
> gets one analytics surface over all of it. Research is done; nothing is built.
- ⬜ **Pick the aggregator, then do the refactor it forces.** You do not integrate banks abroad,
  you integrate ONE aggregator: ~9 700 US institutions publish no personal API, exactly as Privat
  does not (`BANKS.md §1`, at national scale). Recommended order: **Teller** (self-serve, free 100
  live connections, US) → **SimpleFIN** (~$15/yr paid by the USER, read-only, the self-hosted-PFM
  route) → **Enable Banking** (EU, free restricted tier) → Plaid only when a sales call is worth
  it. ⚠️ GoCardless/Nordigen's free tier is CLOSED to new signups — do not plan around it.
- ⬜ **The real cost is not the HTTP, it is `bankCredential(env, id)`** (§BANK-CRED): it resolves
  ONE credential per provider, and an aggregator returns one per INSTITUTION. `bank_connections`
  already has the right shape (a row per credential) — that is where the link flow lands.
- ⬜ **Two written-down assumptions break on the first foreign account:** a zone-less wall clock is
  Kyiv (§BANK-PARSE) and a closed budget month is stored in hryvnia (§BASE-CUR). §APP_TZ is the
  harder one — a per-deployment constant that has to become per-user.
- ⬜ **Crypto is two jobs, not one:** exchange accounts = read-only API keys (the user's, stored
  like the mono token); on-chain wallets = a public address and no credential at all (**Zerion**
  API — ⚠️ Zapper's shut down 2026-08-03). Either way `role: 'investment'`, never the cushion (§R3).

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

**P2.1 — Goals: CLOSED 2026-08-14.** Contribution history, auto-top-up, goal kinds, §GOAL-PACE,
§GOAL-CHART (the jar chart, with both kinds resolved into one server-side series) and §EVENT-GOAL
(an event names the goal it saved toward, and the AI close-out sees it) are all done.
- *(Round-up лишився поза межами свідомо: він потребує гачка на КОЖНІЙ транзакції, а не місячного
  проходу — це інша механіка, не варіант того самого поля.)*

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
- **Prompt-кеш verify** на проді (`cache_read` у логах) — потребує деплою.
- **Тексти помилок віддають сиру причину** (свідоме рішення §Обробка помилок). Якщо зʼявляться
  сторонні юзери поза колом друзів — сховати `detail` за owner-прапорцем.

---

## 🎨 Дизайн — майбутнє
> Як працювати — `DESIGN.md §10` (skills: `impeccable` основний, `review-animations` для руху).
> Кожну зміну фіксувати в «Журналі рішень» DESIGN.md.
- **Статистика** — редизайн вкладок **Огляд + Категорії/Тренди**. Потрібен live-скрін вкладок.
- **Чек-лист для сторінки, переглянутої вживу:** локальний хардкод-колір / тінь / `transition:all` /
  тіснота. (Які саме сторінки чекають — у «UI-черзі» вгорі, щоб список був один.)
- **Розмітка для >1920px** — як стоять блоки на широких моніторах.

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

### F. Сповіщення / проактивність
- **[лвл-ап] Достроїти TG-бота (M).** Маршрутизацію, мову, валюту й статистику зроблено
  2026-08-21; лишок — у блоці 0 черги (кнопки, міні-апка, відвʼязка).

### G. Валюти / інвестиції / нетворт
- **[лвл-ап] Вплив курсу окремою цифрою (S).** Базу зроблено (`rate_history` 0024, нетворт рахує
  кожну точку курсом своєї дати). Лишилось розділити зміну нетворту на «рух грошей» і «рух курсу».
  Має сенс, коли історія накопичиться за кілька місяців.
  *(Сусідню половину закрито 2026-08-21: §FX-COST рахує націнку банку на конвертації — це інше
  питання до тих самих даних, і воно вже відповідає.)*

### H. UX / продуктивність / пошук
- **[лвл-ап] Плавність дашборду (S).** Дотягнути наявні анімації, прибрати ривки.

### I. Стилі (STYLES.md фаза 0.5 — потребує живого ока)
- **[баг] Осиротілі медіа-запити після розділення `index.css` (S).** `@media` додає нуль
  специфічності, тож умовне правило програє БЕЗумовному з пізнішого файлу — і мовчить. Один такий
  випадок був фатальним (`.settings-grid { columns: 1 }` лишилась у `settings.css`, коли розкладка
  переїхала в `settings-shell.css`: Налаштування на телефоні були нечитабельні; виправлено
  2026-08-22). Лишився щонайменше ще один — `.cashflow-head` (`shell.css` просить `gap: 8px`,
  `dashboard.css` безумовно ставить 12px). Знаходиться скриптом: для кожного селектора в `@media`
  шукати те саме безумовне оголошення в файлі, імпортованому пізніше. Варте окремого ліннта C11.
- **[баг] Дубльовані блоки в чотирьох файлах (S).** §WEEKDAY (`.wd-col`/`.wd-bar-wrap`/`.wd-bar`)
  і §HABITS (`.hb-grid`) оголошені по 4-5 разів — двічі в самому `domains-a.css` (рядки ~188 і
  ~763) плюс копії в `shell.css`, `topbar.css`, `domains-b.css`, разом із коментарями. Правила
  зараз ідентичні, тож нічого не видно; розійдуться вони мовчки, і виграє та копія, що нижча.
