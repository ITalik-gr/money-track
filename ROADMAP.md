# ROADMAP — жива черга задач і фіч

> **Це постійний файл. Тут — ЛИШЕ те, що ще треба зробити.** Зроблене звідси **видаляється**;
> якщо результат важливий довгостроково — стислий підсумок їде в `CLAUDE.md`, наратив — у
> `HISTORY.md`. Довідник/інваріанти → `CLAUDE.md`. Дизайн → `DESIGN.md`. Шари й лінти →
> `ARCHITECTURE.md`.
>
> Last sweep: **2026-08-21** — two passes over the ANALYTICS surface, then two audits: §APP_TZ
> (nine places the timezone rule never reached — chart buckets, every drill dimension, two
> recurrence thresholds, everything the model is told about time, two counters) and truthfulness
> (eight more), then a write-path audit (three, one of them a regression the previous pass had
> just introduced). Narrative in `HISTORY.md`.
>
> The recurring shape across all four: **not missing features, but second copies of a rule the app
> already had**, each rendering a plausible number so nothing failed. Two findings worth reusing on
> the next audit: **the currency sweep is blind wherever the fixture is empty** — an absent field
> cannot leak, and fourteen tables had no rows at all — and **an exemption cites a fact, and a fact
> can expire** (C10 let Telegram print `₴` because it was owner-only; §D1 had ended that three
> weeks earlier). A third from the write pass: **the sweep reads GETs, and a mutation returns
> numbers too** — `DELETE /goals/:id/contributions/:cid` answered in hryvnia where its sibling
> answered in the reader's base. **Rule: a card marked ✅ does not live here.**

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

## ▶️ Що брати далі (лишено вранці 2026-08-21)

> Нічна черга вичерпана, аудит теж (девʼять проходів; останні два дали по одній дрібниці —
> метод «шукати другі копії правила» накрив усі грошові поверхні). Далі за спаданням цінності:

1. **Три картки «🔥 Черги» нижче — потребують ОЧЕЙ, не коду.** STYLES 0.5+4, §BASE-CUR у доларах,
   `.section-head`. Вони блокують себе самі, поки власник не подивиться.
2. **Дизайн `/plan`** — прохання власника з UI-черги, теж живий погляд.
3. **TG-бот, залишок:** кнопки під `/stats` для перемикання періоду.
   *(Групові чати закрито 2026-08-21 і НЕ як фічу: перевірка показала, що `fromId === chatId` —
   це запобіжник, а не баг, зате привʼязка в групі проходила й слала туди пуші з балансами. Тепер
   відмовляється. Деталі — HISTORY.)*
4. **Мультипровайдерний AI** (беклог) — шов у `lib/ai/json.ts` уже прорізано.
5. **Масові прогони в чергу задач** (§A6 покрив одиничні; ре-світ і батч-enrich мають іншу
   природу — прогрес у %).

⚠️ **Не починай новий аудиторський прохід** без нової поверхні: вони дали ~30 знахідок за ніч і
вичерпались. Якщо шукати ще — то в місцях, куди метод не діставав: реальні дані власника, живі
екрани, справжній API ПриватБанку.

## 🌙 Нічна черга — ВИКОНАНА (2026-08-21, N1–N7 закриті)

> Усі сім пунктів закрито, плюс девʼять аудиторських проходів і прохід по гілках помилки.
> Підсумок — у `HISTORY.md`, розділ «🌙 Ніч 2026-08-21». Картки лишені тут із позначками, щоб було
> видно, що саме робилось; **видали цей розділ, коли прочитаєш.**
>
> ⚠️ **Перед деплоєм:** `npm run db:dir:migrate:remote` — directory 0008 (`tg_links`). Без неї бот
> маршрутизує лише власника.

## 🌙 Нічна черга (виставлено 2026-08-21 04:33, власник спить)

> **Це робоча черга автономного прогону.** Порядок узгоджений; іти згори вниз, `npm run check` +
> `npm run build` після КОЖНОГО пункту, зроблене — одразу коротким блоком у `HISTORY.md`.
> **Не комітити й не деплоїти.** Якщо green bar не відновлюється — зупинитись і лишити нотатку
> прямо тут, а не тягнути далі.
>
> Написано так, щоб це міг підняти той, хто прийшов уперше: усе потрібне — `CLAUDE.md` (інваріанти)
> + згадані файли.

### N1. Telegram: зняти блокер мультиюзерності (M, міграція directory 0008)

**Проблема.** Вихідні пуші персональні з §D1, а вхідні КОМАНДИ owner-only: воркер не знає, чий
обʼєкт будити на повідомлення з довільного чату, бо немає індексу `chat_id → user_id`.

**Кроки.** Міграція `directory` 0008 → `tg_links(chat_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL,
linked_at INTEGER NOT NULL)`. Пише підписаний `/start` (він уже доводить власність чату — сам
Telegram повідомляє, з якого чату натиснули; див. §D1). Воркер резолвить чат і форвардить у
відповідний DO. Розвʼязка — команда + кнопка в Налаштуваннях, чистить рядок.

⚠️ **Індекс — ЄДИНИЙ авторитет.** Чат без рядка отримує «привʼяжи акаунт», ніколи дані.
⚠️ Deployment-секрет `TG_CHAT_ID` лишається owner-only фолбеком — рівно як `tgTarget` на
вихідному боці, щоб «кому шлемо» і «кого слухаємо» не могли розійтись.
⚠️ Рейт-ліміт на чат (форма є в `lib/platform/quota.ts`).
**Готово-коли:** другий акаунт привʼязує свій чат і `/balance` віддає ЙОГО баланс; чужий чат не
дістає нічого; тести на резолвінг і на відмову.

### ~~N2. Telegram: мова й валюта вхідного боку~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY)

Після N1 премиса «це owner-only» вмирає і для команд — так само, як вона вмерла для пушів
2026-08-21. Усі тексти `routes/telegram.ts` → `st()`, усі суми → `num()` + `currencySign(base)`.
`HELP`, `balanceText`, `confirmText`, клавіатури, повідомлення про помилки.

### ~~N3. Telegram: статистика, оформлена як у продакшн-бота~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY)

`/stats [week|month]`, `/budget`, `/subs`, `/goals`. **Усе через наявний канон** — `periodTotals`,
`spendByCategory`, `budgetStatus`, `monthlyPlannedUAH`, `goalPace`. Жодного SQL у боті: рівно те
правило, заради якого й були три аудити.
⚠️ Графіків не буде: у Worker немає canvas, а SVG→PNG потребує зовнішнього сервісу. Текстові
смуги (`████░░░░`) + `tabular` вирівнювання — і сказати це прямо, а не малювати щось приблизне.
⚠️ Довгі відповіді різати по 4096 символів (ліміт Telegram), інакше повідомлення просто не піде.

### ~~N4. Telegram: двосторонній звʼязок~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY)

Диплінки з бота в застосунок (частково є — `link()` в `alert.ts`); назад — «надіслати в Telegram»
із застосунку; керування типами сповіщень із чату (`/mute budget`).

### ~~N5. Telegram: розумний ввід~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY)

Зараз вільний текст = витрата. Додати дохід і переказ; повідомлення-ПИТАННЯ слати в `chatReply`
з інструментами, а не в парсер витрати.
⚠️ Голосові — НІ: STT у стеку немає, і вигадувати зовнішній сервіс заради цього не варто.

### ~~N6. Аудит-хардening~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY)

- **Тест на повноту фікстури:** падає, коли таблиця схеми не має рядків у `fixture.ts`. Це
  мета-фікс найбільшої знахідки 2026-08-21 — sweep сліпий там, де фікстура порожня, і сліпа пляма
  зможе повернутись інакше.
- **Дата й причина на КОЖНОМУ записі у списках винятків лінтів.** Двічі за день виявилось, що
  виняток посилається на факт, який протух (C10/Telegram, `budgets.rollover`). Лінт друкує їх.

### ~~N7. Статистика категорій у вебі~~ ✅ ЗРОБЛЕНО 2026-08-21 (HISTORY) — але це ПЕРШИЙ крок: варте живого погляду, і три кандидати свідомо відкинуті з причинами

**Це фінальний пункт і найважливіший для власника:** сторінка `/categories/:id` має стати сильною.
§CAT-PAGE 2026-08-14 полагодив те, що вона була ПОРОЖНЯ; зробити її корисною — окрема робота.
Що вже є: канонічний рівень, тренд 24 міс, конверт, разові/регулярні, lifetime, топ-мерчанти
з часткою, історія закритих місяців. Чого бракує (пропозиції, обирати з розумом):
- порівняння з тим самим періодом торік — сезонність видно лише так;
- розподіл по днях тижня / числах місяця ДЛЯ ЦІЄЇ категорії (канон уже є: `weekday.ts`);
- «з чого складається» — підкатегорії стековою смугою по місяцях;
- середній чек і його тренд (не лише сума);
- прогноз кінця місяця саме для категорії (`projectSpend` уже вміє);
- вагомість (`EFF_IMPORTANCE`) в межах категорії — скільки з неї обовʼязкове.
⚠️ **Спершу `DESIGN.md`**, зміну — в його «Журнал рішень».
⚠️ Не додавати числа, які вже є деінде в іншій формі: кожен новий блок має відповідати на питання,
на яке сторінка ЩЕ не відповідає.


---

## 🔥 Черга (роби згори вниз)

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

*(Closed 2026-08-21: **§CADENCE reached the screen.** The rule that a period shorter than a
billing cycle cannot compare a monthly charge existed only inside `report.ts`, as three inline
expressions — so the app told the MODEL to be careful about «підписки −92%» and kept showing that
same figure to the person, in colour. It is `lib/finance/cadence.ts` now, and `/analytics/compare`
does the merge, the noise floor and the verdict: both tabs read it instead of building their own.
The two client copies also disagreed about sorting (one buried a category that vanished) and both
carried a bare `5000` noise floor — 50 ₴ as intended, $50 for a dollar reader. 8 scenarios in
`cadence.test.ts`.)*

*(Closed 2026-08-21: **§BUDGET-MEMORY has a reader.** `budget_months` has held the answer to «чи я
тримаю план» since migration 0043 and had two readers that each threw it away — the auto-budget
keeps a ratio, the category page draws one envelope. `GET /budgets/history` + the card on `/plan`:
kept share, month strip, and a per-envelope run counting back from the LATEST close. Found on the
way: `budget_history` on `/categories/:id/overview` returned hryvnia into a converted card, and the
currency sweep could not see it because the fixture has no closed months — it does now.)*

*(Closed 2026-08-21: **§FX-COST** — what conversion actually cost, which appears on no statement.
Both halves of every foreign purchase have been stored since 2026-07 and `rate_history` since
migration 0024; nothing compared them. Each side is valued at the published rate OF ITS OWN DAY, so
a currency move cannot be reported as a bank markup, and a day with no stored rate is dropped and
counted rather than filled in. Statistics → Огляд, hidden when there is nothing abroad.)*

*(Closed 2026-08-21: the day-of-month heat map and the weekday bars on Trends were computed IN THE
CLIENT off UTC daily buckets, with raw sums — so every purchase after 21:00 Kyiv was filed a day
late, and the 31st looked cheap because a 90-day window holds fewer of them. §WEEKDAY existed to
prevent exactly this and was already on screen elsewhere. Both now come from
`/analytics/weekday` and the new `/analytics/day-of-month`; `first_five_share_pct` names how much
of a month is committed before any of it is decided. 6 scenarios in `calendar-shape.test.ts` —
the §WEEKDAY canon had none.)*

*(Closed 2026-08-21: the savings rate had THREE spellings — the AI report, the Trends strip and
nothing else; `savingsRatePct` is one function in `finance.ts` and `/analytics/monthly-history`
carries it per month. And `top_merchants` on a category page now carries `share_pct`, so «70% цієї
категорії — це один магазин» can be said instead of a column of totals.)*

*(Closed 2026-08-18: **§BASE-CUR** — every rolled-up number is expressed in a currency the reader
chooses (`x-mt-currency` → stored choice → language), instead of the hryvnia the canon had nailed
into `uahMult`/`toUAHMinor`. `getRates(env)` answers in that base, so forty call sites converted
without being edited; lint **C10** is what keeps the raw table from creeping back, because the
wrong version renders a plausible number. Stored plan amounts (budgets, goals, event budgets, fact
deltas) stay in hryvnia and convert at the edge; a closed budget month stays hryvnia because an
archive whose unit moves is not a history. 11 scenarios in `currency.test.ts`.)*

*(Closed 2026-08-18: the AI group verdict counted only hryvnia rows (`AND t.currency_code = 980`).
The same hole had been found and closed twice, in `/events` and `/events/:id`, each time with the
note that a trip is the worst place for it — abroad is where another currency appears. The close-out
was the third copy and the one nobody had read: it told the owner a trip came in under budget by
ignoring everything paid in euros.)*

*(Closed 2026-08-18: category names leaked Ukrainian into the Statistics drill — `categoryTransactions`
was the one query on that page without `catNameSql`, so an English reader got English headings over
a Ukrainian list. Same for `recurringOneoffSplit`, which three AI context builders read raw.)*

*(Closed 2026-08-18: `worker/lib/ai/report.ts` and its C3 ceiling — the extraction the card asked
for had already happened with `report-prompt.ts`; the file is 360 lines and holds context assembly
and storage, which is exactly the end state the card described.)*

*(Closed 2026-08-14: **§CAT-PAGE** — the category page rendered empty over real data for three
independent reasons, all silent: a SUB-category never matched the rolled-up `EFF_CAT_ID`, an INCOME
bucket had no spending to find, and the window was month-to-date so a quiet month looked like an
empty category. One `CatScope` now drives every query on the page AND its drill; lifetime stats, a
period selector and a 24-month trend make the page answer "is there anything here" before "how much
this month". 9 scenarios in `category-page.test.ts`.)*

*(Closed 2026-08-14: **§INCOME-PLAN** — income has a schedule at last (migration 0044), so
`safe-to-spend` and `forecast` stop subtracting a month of projected spending from a few days of
actual income. Expected income stays OUT of `safe` deliberately (it is the number people spend
against) and drives the FORECAST instead; lateness is derived by comparing totals, which survives
income that is neither the same size nor on time. `OUTFLOW_ONLY` on every planning selector keeps a
salary from ever being counted as a subscription. The cashflow calendar and the liquidity drafter
are no longer outflow-only — that gap was announced for anyone whose salary lands after their rent.
10 scenarios in `income-plan.test.ts`.)*

*(Closed 2026-08-14: **§GOAL-CHART** + **§EVENT-GOAL** — the last two Goals tails.)*

*(Closed 2026-08-14: **§BUDGET-ZERO** — a limit of 0 is now a plan («сюди я не витрачаю»), not the
absence of one; removing an envelope became its own verb (`DELETE /budgets/:categoryId`), a negative
limit is refused rather than clamped, and a zero envelope shows a word instead of a percentage
because «80% від нуля» is not a quantity.)*

*(Closed 2026-08-14: **лінт C9** — кожен `className` має правило й навпаки. Куплений трьома
багами того самого дня (картка без фону, сторінка категорії з чотирма класами без жодного правила).
Вимів 59 мертвих правил, зняв `domains-a.css` зі стелі винятку C8 і дозволив `settings.css`
відмовитись від винятку зовсім; заразом знайшов `.acct-card.editing`, написаний під клас `acct2` —
тобто «редактор рахунку на весь ряд» не працював жодного разу.)*

*(Closed 2026-08-14: §BUDGET-MEMORY — `budget_months` (migration 0043) gives budgets the time
dimension they never had; the carry is folded into `budgetStatus` so every reader gets it, an
overspend carries as readily as a surplus, and the category page shows how the last six months
closed. 10 scenarios in `budget-memory.test.ts`.)*

*(Closed 2026-08-12/14: reports diagnosability — a failed cron step is announced in the feed,
`already_covered` capped 24 → 12, every report stores `_diag`; §CATEGORY-PAGE `/categories/:id`
with entry points from the envelope tile and the category list; §BUDGET-FORECAST; §RULES-UI;
§TX-CHAT; §AI-AUDIT; §IMPORTANCE-TREND; §LOCK; §GOAL-PACE; §HABITS → plan in one click; the
statistics-consistency suite; STYLES phase 0 + the split.)*

*(Безпека: прохід по периметру ✅ 2026-08-07 — `CLAUDE.md §Безпека`. `gitleaks` по всій історії
власник прогнав, чисто. Рішення власника закриті 2026-08-03: історію git не переписуємо,
`database_id` лишається в `wrangler.jsonc`.)*

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

**P2.1 — Goals: CLOSED 2026-08-14.** Contribution history, auto-top-up, goal kinds, §GOAL-PACE,
§GOAL-CHART (the jar chart, with both kinds resolved into one server-side series) and §EVENT-GOAL
(an event names the goal it saved toward, and the AI close-out sees it) are all done.
- *(Round-up лишився поза межами свідомо: він потребує гачка на КОЖНІЙ транзакції, а не місячного
  проходу — це інша механіка, не варіант того самого поля.)*

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
- **Чек-лист для сторінки, переглянутої вживу:** локальний хардкод-колір / тінь / `transition:all` /
  тіснота. (Які саме сторінки чекають — у «UI-черзі» вгорі, щоб список був один.)
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

### F. Сповіщення / проактивність
- **[лвл-ап] Достроїти TG-бота (M).** Див. картку в беклозі — потрібен індекс `chat_id → user_id`.

### G. Валюти / інвестиції / нетворт
- **[лвл-ап] Вплив курсу окремою цифрою (S).** Базу зроблено (`rate_history` 0024, нетворт рахує
  кожну точку курсом своєї дати). Лишилось розділити зміну нетворту на «рух грошей» і «рух курсу».
  Має сенс, коли історія накопичиться за кілька місяців.
  *(Сусідню половину закрито 2026-08-21: §FX-COST рахує націнку банку на конвертації — це інше
  питання до тих самих даних, і воно вже відповідає.)*

### H. UX / продуктивність / пошук
- **[лвл-ап] Плавність дашборду (S).** Дотягнути наявні анімації, прибрати ривки.
