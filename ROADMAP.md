# ROADMAP — жива черга задач і фіч

> **Це постійний файл. Тут — ЛИШЕ те, що ще треба зробити.** Зроблене звідси **видаляється**;
> якщо результат важливий довгостроково — стислий підсумок їде в `CLAUDE.md`, наратив — у
> `HISTORY.md`. Довідник/інваріанти → `CLAUDE.md`. Дизайн → `DESIGN.md`. Шари й лінти →
> `ARCHITECTURE.md`.
>
> Останнє прибирання: **2026-08-14** — знято весь session log за 12 серпня (кожен рядок `DONE`,
> результати вже в `CLAUDE.md`), три закриті картки черги (звіти, сторінка категорії, розділення
> `index.css`) і закриті пункти UI-черги. **Правило: картка зі статусом ✅ тут не живе.**

## 🚦 Як працювати з цим файлом

1. Бери **найвищу невиконану задачу** з «Черги». Не перестрибуй без причини.
2. Задача = картка: **Ціль · Файли · Кроки · Готово-коли**. Спочатку прочитай згадані файли.
3. **Green-бар перед «готово»:** `npm run check` (tsc + лінти C1–C9 + тести) + `npm run build`.
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

### 1. The `.section-head` gap is wrong on EVERY page using `<section>`

Found while widening the category page. `.section-head` carries `margin: 26px 2px 10px` — the
app's gap between sections — but `.section-head:first-child` drops it to 4px so the first heading
does not push the page away from its header. **Inside a `<section>` wrapper every heading is a
first child**, so the moment a page groups its blocks semantically it silently loses the spacing
the design system says it has. That is 20+ files (`Dashboard`, `Stats`, `Subscriptions`, `Reports`,
`Advisor`, `Categories`, `Plan`, `Merchant`…).

The one-line fix is `section > .section-head:first-child { margin-top: 26px; }`, and it is NOT
applied yet: it changes vertical rhythm on every screen at once, and some may be tight on purpose.
Scoped to the category page for now (`budgets.css`, `.cat-page-stats ~ section`).
**Done when:** the owner has looked at two or three of those pages with the rule on.

### 2. STYLES phase 0.5 + 4 — needs the owner's EYE (`STYLES.md`)

The stylesheet is split (twelve parts under `src/styles/`, `index.css` is imports only, lint **C8**
keeps it that way), the 76 byte-identical dead blocks are gone and C9 has since removed 59 more.
Two phases stayed behind on purpose, because neither can be done blind:

- **Phase 0.5 — the 8 quietly conflicting selectors.** What renders today is their MERGE, which
  nobody wrote. Collapsing them CHANGES rendering, so each one needs a live before/after.
- **Phase 4 — true domain grouping.** It moves rules across cascade boundaries. `@layer` was
  skipped for the same reason.

⚠️ The exception mechanism is now a RATCHET: `settings.css` overflowed, its page shell moved to
`settings-shell.css` (§SET-FLOW), and after the C9 sweep it dropped under the cap and **lost its
exception entirely**. `domains-a.css` is down to 1 105. An exception may never grow — the next
overflow gets a seam, not a raised cap.

**Done when:** the 8 conflicts are resolved against live screens, with no visual change the owner
did not approve.

### 3. `worker/lib/ai/report.ts` is at its C3 ceiling (450)

Adding anything to it requires an extraction first. The obvious seam: context assembly and storage
stay, everything else follows `report-prompt.ts` out. Not urgent — it becomes urgent the moment a
report feature is asked for.

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

### H. UX / продуктивність / пошук
- **[лвл-ап] Плавність дашборду (S).** Дотягнути наявні анімації, прибрати ривки.
