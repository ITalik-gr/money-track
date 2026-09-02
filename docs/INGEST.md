# INGEST.md — як операція потрапляє в базу

> Банківський вебхук, полінг, CSV-імпорт і ручне додавання. **Читай перед будь-якою роботою з
> банком або імпортом.** Стратегія банків (що ПриватБанк узагалі віддає, агрегатори, крипта) —
> у `BANKS.md`; тут — інваріанти самого запису.
>
> Правило шару: SQL лише в `repo/`, нормалізація рядків банку — лише в `lib/bank/normalize.ts`.

## Єдиний писар

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
  ⚠️ **A deployment-wide secret is the OWNER'S, never everyone's fallback** (`docs/PERIMETER.md` — shipped
  twice, gave one user another user's statement). **A new provider gets NO deployment fallback at
  all, owner included:** there is no single-user history to stay compatible with.

## Заглушка рахунку й авторитет ручної назви

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
- **Ручна назва операції авторитетна:** `transactions.name_locked=1` (ставиться при ручній зміні мерчанта в TxDetail) → enrich/ре-світ НЕ перезаписує `merchant` (`merchant = CASE WHEN name_locked=1 THEN merchant ELSE ? END`); категорію/ai_note ще уточнює. Знімається кнопкою «дозволити AI оновлювати». Міграція 0019.

## Файли, полінг, зʼєднання

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
- **§TG-CSV (2026-09-02): виписку можна кинути в ЧАТ боту.** Причина — на iOS немає share-target
  (§SHARE-CSV працює лише на Android), а Telegram є скрізь. Бот качає файл (`file_id` → `getFile`)
  і жене його через ТОЙ САМИЙ конвеєр, що й веб.
  ⚠️ **Конвеєр переїхав із роуту в `lib/bank/statement-import.ts`.** `routes/import.ts` уже писав
  вголос, що превʼю й коміт МУСЯТЬ резолвити мапінг однаково, інакше файл, зіставлений AI у
  превʼю й підказками на коміті, імпортує не ті колонки, які людина схвалила. Третій виклик із
  власною копією зробив би цю розбіжність ще й МІЖПОВЕРХНЕВОЮ: схвалив у чаті — імпортувалось інше.
  Тепер роут — це транспорт і код статусу, а що саме імпортується — вирішується в одному місці.
  ⚠️ **Превʼю в чаті — це ДІАЛОГ, а не кнопка.** Мапінг ПОВНИЙ → бот каже, що зрозумів (скільки
  операцій, за який період, скільки пропустить і чому) і питає, на ЯКИЙ РАХУНОК; вибір рахунку і є
  підтвердженням, бо більше нічого корисного з телефона не вирішиш. Мапінг НЕПОВНИЙ → бот
  відмовляє, називає колонки, яких не знайшов, і дає посилання на веб-імпорт. Текстовий вибір
  колонок у чаті був би гіршою версією екрана, який уже є, а помилка тут пише місяць хибних чисел.
  ⚠️ **Рахунок не вгадується НІКОЛИ, навіть коли він один.** Імпорт не в той рахунок зберігає кожну
  суму в чужій валюті (доларова виписка в гривневий рахунок — помилка в сорок разів) і виглядає
  після цього абсолютно звичайно. Людина з одним рахунком — це саме та, хто не помітить.
  ⚠️ **У pending лежить `file_id`, а не файл** (Telegram і так тримає байти), **але МАПІНГ лежить
  саме той, що показали:** повторний `resolveMapping` міг би вдруге дійти до моделі й відповісти
  інакше — імпортувавши колонки, яких людина не бачила.
  ⚠️ **Pending чиститься ДО запису, не після:** коміт великого файлу триває секунди, і другий тап у
  цьому вікні імпортував би виписку двічі. Контентний хеш проковтнув би дублікати рядків, але
  людині двічі сказали б, що спрацювало.
  ⚠️ Файл упізнають за РОЗШИРЕННЯМ, а не за `mime_type`: Telegram віддає CSV як
  `application/vnd.ms-excel` достатньо часто, щоб довіра до типу відхиляла найзвичайніший реальний
  файл. XLS і PDF відмовляються з поясненням (див. беклог). Тримається `tg-import.test.ts`
  (7 сценаріїв).
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


## §CSV-AI — колонки виписки, яких гадалка не впізнала (2026-09-02)

Детерміновий шлях (`guessMapping` + `findHeaderRow` + §CSV-PREAMBLE) звіряє назви колонок зі
списком написань, які ми вже бачили. Він тримає банки, з якими ми зустрічались, і мовчки програє
наступному: превʼю каже «зістав колонки сам» — тобто форма, що просить людину зробити рівно те, що
мав зробити застосунок. Запит власника: «щоб воно автоматично розуміло що є що, можливо аі юзати
навіть якщо кодом не розібраться легко».

`worker/lib/ai/statement-map.ts`, один виклик Haiku на ФАЙЛ.

⚠️ **ФОЛБЕК, а не шлях за замовчуванням.** Виклик іде тільки коли трьох обовʼязкових колонок не
знайдено правилом. Банк, який ми вже впізнаємо, не сміє почати коштувати виклик моделі — і, що
важливіше, детермінований шлях ВІДТВОРЮВАНИЙ: той самий файл зіставляється однаково сьогодні й
через рік, чого модель не обіцяє.

⚠️ **Модель називає КОЛОНКИ, ніколи значення.** Вона повертає індекси; кожне число й дату далі
читає §BANK-PARSE, тим самим кодом, що й на детермінованому шляху. Модель, що повертала б розібрані
суми, була б другим парсером, який тихо розійдеться з першим у округленні, роздільниках тисяч і
часових поясах — §CUR-PLAN у новому одязі.

⚠️ **Її відповідь ДОВОДИТЬСЯ перед використанням** (`mappingParsesSample`): запропонована колонка
дат мусить справді парситись як дати, а колонка сум — як суми, щонайменше у двох рядках. Один
вдалий рядок — це збіг: колонка вільного тексту рано чи пізно міститиме дату. Плюс перевірка меж:
індекс поза шириною файлу — це колонки, яких немає. Промт, що просить валідне зіставлення, — це
прохання; ця перевірка робить хибну відповідь нешкідливою.
**Найнебезпечніша відповідь — переставлені місцями дата й сума:** валідний JSON, правдоподібна
форма, і рік безглуздих чисел, які виглядають абсолютно звично. Вона відхиляється саме тут.

⚠️ **Результат усе одно показується на підтвердження**, і UI КАЖЕ, що зіставлення від AI
(`mapping_source`). Здогад, який приховує, що він здогад, — саме той, якому вірять не дивлячись.

⚠️ **Модель, що впала, недоступна або без ключа, не ламає ПРЕВʼЮ** — лишається ручна форма, яка
працювала й до цього. Фіча існує, щоб зекономити набирання; економія, здатна зламати те, чому вона
допомагає, — не економія.

⚠️ **Превʼю і коміт зіставляють через ОДНУ функцію** (`resolveMapping` у `routes/import.ts`).
Доти кожен будував `{...found.mapping, ...body.mapping}` інлайном — той самий вираз двічі, тож
різниці не було. З появою фолбека вона зʼявляється: файл, зіставлений моделлю у превʼю і
підказками на коміті, імпортував би не ті колонки, які людина схвалила.

Тримається `worker/test/statement-map.test.ts` (9 сценаріїв; сім із них — про відмови).
