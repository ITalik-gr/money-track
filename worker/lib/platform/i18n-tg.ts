/**
 * Server strings for the TELEGRAM surface — one table, split out of `i18n.ts` by C3 on
 * 2026-08-21 when translating the bot pushed that file past its cap.
 *
 * ⚠️ Split by SURFACE, not by language: both halves of every string stay side by side, which is
 * the property that makes an untranslated entry visible at a glance. The lint's advice ("split it
 * by path prefix, the way routes/api/ is organised") is exactly this — the bot is a prefix of the
 * product, and it owns forty of these keys while the rest of the server owns the others.
 *
 * `i18n.ts` spreads this into `S`, so there is still ONE key space, one `st()`, and `ServerStringKey`
 * still covers everything — a caller cannot tell the two files apart, which is the point.
 */
export const TG = {
  // §D1 made Telegram pushes PERSONAL — see the note on `alert.ts`. Until 2026-08-21 this whole
  // surface was exempt from translation on the grounds that only the owner ever read it, and that
  // premise expired the day a second person could link their own chat.
  tgUnexplained: {
    uk: "🔎 <b>Вагома непояснена операція</b>",
    en: "🔎 <b>A significant operation with no explanation</b>",
  },
  tgUnexplainedBody: {
    uk: "Це переказ/зняття. На що ці кошти пішли насправді?",
    en: "This is a transfer or a withdrawal. What was the money actually spent on?",
  },
  tgNoCategory: { uk: "🔎 <b>Вагома витрата без категорії</b>", en: "🔎 <b>A significant uncategorised expense</b>" },
  tgNoCategoryBody: { uk: "Не зміг визначити категорію.", en: "Could not work out the category." },
  tgBudgetOver: { uk: "⚠️ <b>Бюджет перевищено</b>", en: "⚠️ <b>Budget exceeded</b>" },
  tgBudgetLast: { uk: "Остання: {merchant} — {amount}.", en: "Latest: {merchant} — {amount}." },
  tgOpenInApp: { uk: "відкрити у застосунку", en: "open in the app" },
  tgBtnOtherCategory: { uk: "🏷 Інша категорія", en: "🏷 A different category" },
  tgBtnOwnTransfer: { uk: "🔁 Переказ між своїми", en: "🔁 Transfer between my accounts" },
  tgBtnOk: { uk: "👌 Все ок", en: "👌 All good" },
  tgBtnSetCategory: { uk: "🏷 Вказати категорію", en: "🏷 Set a category" },
  tgBtnGot: { uk: "👌 Зрозумів", en: "👌 Got it" },
  tgWeekly: { uk: "📊 Тижневий підсумок", en: "📊 Weekly summary" },
  tgBudgetsAtRisk: { uk: "⚠️ Бюджети під загрозою", en: "⚠️ Budgets at risk" },
  tgUpcoming: { uk: "🔔 Скоро списання (7 днів)", en: "🔔 Charges due soon (7 days)" },

  // The bot's INBOUND surface (`routes/telegram.ts`). Translated 2026-08-21, right after
  // directory 0008 made commands multi-user: until then the exemption «only the owner types to
  // this bot» was true, and the moment routing existed it stopped being.
  tgHelp: {
    uk: "<b>Money Track</b> — фінтрекер у Telegram.\n\n"
      + "• <b>Напиши витрату або надходження</b> — «кава 45 аромакава», «отримав 12000 зарплата» — розберу й запропоную зберегти.\n"
      + "• <b>Запитай</b> — «скільки я витратив на каву?» — відповім як порадник.\n"
      + "• <b>Надішли фото чека</b> — розпізнаю магазин, суму й позиції.\n\n"
      + "Команди:\n/balance — власні кошти\n/last — останні транзакції\n"
      + "/stats [week] — витрати, доходи, топ категорій\n/budget — конверти й прогноз\n"
      + "/subs — підписки: тягар на місяць і найближчі списання\n/goals — цілі та їхній темп\n"
      + "/notify — які сповіщення увімкнені · /mute, /unmute — змінити\n/unlink — відвʼязати цей чат\n"
      + "/insight — тижневий AI-інсайт\n/advice — фінансові поради\n"
      + "/ask &lt;питання&gt; — спитати AI-порадника\n/help — ця довідка",
    en: "<b>Money Track</b> — your finances in Telegram.\n\n"
      + "• <b>Type an expense or income</b> — «coffee 45 Aromakava», «got 12000 salary» — I will parse it and offer to save.\n"
      + "• <b>Ask a question</b> — «how much did I spend on coffee?» — I answer as the adviser.\n"
      + "• <b>Send a photo of a receipt</b> — I will read the shop, the total and the items.\n\n"
      + "Commands:\n/balance — your own funds\n/last — recent transactions\n"
      + "/stats [week] — spending, income, top categories\n/budget — envelopes and the forecast\n"
      + "/subs — subscriptions: monthly burden and what is due\n/goals — goals and their pace\n"
      + "/notify — which notifications are on · /mute, /unmute — change them\n/unlink — detach this chat\n"
      + "/insight — the weekly AI insight\n/advice — financial advice\n"
      + "/ask &lt;question&gt; — ask the AI adviser\n/help — this help",
  },
  tgOwnFunds: { uk: "<b>Власні кошти:</b> ≈ {amount}", en: "<b>Your own funds:</b> ≈ {amount}" },
  tgCreditLimit: {
    uk: "\nКредитний ліміт: {amount} — не рахую як свої.",
    en: "\nCredit limit: {amount} — not counted as yours.",
  },
  tgParsed: { uk: "Розпізнав витрату:", en: "Parsed an expense:" },
  tgSumLine: { uk: "Сума: <b>{amount}</b>", en: "Amount: <b>{amount}</b>" },
  tgCategoryLine: { uk: "Категорія: {name}", en: "Category: {name}" },
  tgNoteLine: { uk: "Нотатка: {note}", en: "Note: {note}" },
  tgUncategorized: { uk: "— без категорії", en: "— uncategorised" },
  tgUndetermined: { uk: "— не визначено", en: "— undetermined" },
  tgBtnSave: { uk: "✅ Зберегти", en: "✅ Save" },
  tgBtnCancel: { uk: "❌ Скасувати", en: "❌ Cancel" },
  tgBtnCategory: { uk: "✏️ Категорія", en: "✏️ Category" },
  tgNoInsightData: { uk: "Поки нема даних для інсайту.", en: "Not enough data for an insight yet." },
  tgNoAdvice: {
    uk: "Порад ще нема. Додай фінансову ситуацію у вебі й спробуй ще раз.",
    en: "No advice yet. Add your financial situation in the web app and try again.",
  },
  tgRunway: { uk: "⏳ Запасу на <b>{months} міс</b>", en: "⏳ Runway: <b>{months} mo</b>" },
  tgNoAiKey: { uk: "AI-ключ не налаштовано на сервері.", en: "No AI key is configured on the server." },
  tgAskUsage: {
    uk: "Напиши питання після /ask, напр. «/ask на чому зекономити?»",
    en: "Type a question after /ask, e.g. «/ask where can I cut back?»",
  },
  tgAnswerFailed: { uk: "Не вдалося відповісти. Спробуй ще раз.", en: "Could not answer. Try again." },
  tgNoTx: { uk: "Транзакцій ще немає.", en: "No transactions yet." },
  tgLastHeader: { uk: "<b>Останні:</b>", en: "<b>Recent:</b>" },
  tgNoAiKeyQuick: {
    uk: "AI-ключ не налаштовано на сервері — швидкий ввід недоступний.",
    en: "No AI key on the server — quick entry is unavailable.",
  },
  tgParseFailed: {
    uk: "Не вдалося розібрати. Спробуй напр. «таксі 120».",
    en: "Could not parse that. Try e.g. «taxi 120».",
  },
  tgNoAiKeyReceipt: {
    uk: "AI-ключ не налаштовано — розбір чека недоступний.",
    en: "No AI key — receipt scanning is unavailable.",
  },
  tgReceiptMatched: { uk: "✅ Причеплено до транзакції Monobank", en: "✅ Attached to a Monobank transaction" },
  tgReceiptCash: { uk: "💾 Створено готівкову витрату", en: "💾 Saved as a cash expense" },
  tgReceiptFallbackName: { uk: "Чек", en: "Receipt" },
  tgReceiptFailed: {
    uk: "Не вдалося розпізнати чек. Спробуй чіткіше фото.",
    en: "Could not read the receipt. Try a sharper photo.",
  },
  tgLeftAsIs: { uk: "👌 Гаразд, лишаю як є.", en: "👌 Fine, leaving it as it is." },
  tgMarkedTransfer: {
    uk: "🔁 Позначив переказом між своїми — прибрав зі статистики.",
    en: "🔁 Marked as a transfer between your own accounts — removed from the statistics.",
  },
  tgCbDone: { uk: "Готово", en: "Done" },
  tgCbSaved: { uk: "Збережено", en: "Saved" },
  tgChooseCategory: { uk: "Оберіть категорію:", en: "Choose a category:" },
  tgRealCategoryLabel: { uk: "Реальна категорія", en: "Real category" },
  tgCategoryLabelShort: { uk: "Категорія", en: "Category" },
  tgSkipped: { uk: "— пропущено", en: "— skipped" },
  tgCancelled: { uk: "Скасовано.", en: "Cancelled." },
  tgNoActiveEntry: { uk: "Немає активного запису.", en: "No entry in progress." },
  tgEntryStale: {
    uk: "Запис застарів — надішли витрату ще раз.",
    en: "That entry expired — send the expense again.",
  },
  tgSavedAs: { uk: "✅ Збережено: <b>{merchant}</b> — {amount}", en: "✅ Saved: <b>{merchant}</b> — {amount}" },
  tgGenericError: { uk: "Сталася помилка. Спробуй ще раз.", en: "Something went wrong. Try again." },
  tgChatLinked: {
    uk: "✅ Чат підключено. Сюди приходитимуть важливі сповіщення.",
    en: "✅ Chat linked. Important notifications will arrive here.",
  },

  // ---- statistics commands (2026-08-21) --------------------------------------
  // ---- the persistent button strip (2026-08-21) ------------------------------
  // ⚠️ Each label is ALSO the routing key: a reply keyboard sends its own text as an ordinary
  // message, so `buttonCommand()` has to recognise it. Changing a label without changing that map
  // gives a button that types a sentence at the expense parser.
  tgBtnStats: { uk: "📊 Статистика", en: "📊 Stats" },
  tgBtnBudget: { uk: "🧧 Конверти", en: "🧧 Envelopes" },
  tgBtnSubs: { uk: "🔁 Підписки", en: "🔁 Subscriptions" },
  tgBtnGoals: { uk: "🎯 Цілі", en: "🎯 Goals" },
  tgBtnBalance: { uk: "💰 Баланс", en: "💰 Balance" },
  tgBtnLast: { uk: "🧾 Останні", en: "🧾 Recent" },
  tgBtnAdvice: { uk: "💡 Порада", en: "💡 Advice" },
  tgBtnHelp: { uk: "❓ Довідка", en: "❓ Help" },

  // Sent ONCE per chat, alongside the strip itself (`tg-surface.ts`). New buttons appearing with
  // no word about them read as the app doing something on its own; one sentence is the whole
  // difference between a feature and a surprise.
  tgButtonsHint: {
    uk: "⌨️ Кнопки під полем вводу — команди можна не памʼятати.\nПовний список — у меню ⌘ біля скріпки.",
    en: "⌨️ Buttons are under the input field — no need to remember commands.\nThe full list is in the ⌘ menu next to the paperclip.",
  },

  tgStatsHeader: { uk: "📊 <b>{period}</b>", en: "📊 <b>{period}</b>" },
  tgStatsWeek: { uk: "Цей тиждень", en: "This week" },
  tgStatsMonth: { uk: "Цей місяць", en: "This month" },
  tgStatsSpend: { uk: "Витрати", en: "Spending" },
  tgStatsIncome: { uk: "Надходження", en: "Income" },
  tgStatsNet: { uk: "Чистий", en: "Net" },
  tgStatsSaved: { uk: "Відкладено {pct}% доходу", en: "Kept {pct}% of income" },
  tgStatsNoIncome: { uk: "Доходу за період не було", en: "No income in this period" },
  tgStatsTopCats: { uk: "<b>Куди пішло</b>", en: "<b>Where it went</b>" },
  tgStatsEmpty: { uk: "За цей період витрат ще немає.", en: "No spending in this period yet." },
  tgStatsOps: { uk: "{n} оп.", en: "{n} ops" },

  tgBudgetHeader: { uk: "🧧 <b>Конверти</b>", en: "🧧 <b>Envelopes</b>" },
  tgBudgetEmpty: {
    uk: "Конвертів ще немає. Створи їх на сторінці «План» у застосунку.",
    en: "No envelopes yet. Create them on the «Plan» page in the app.",
  },
  tgBudgetZero: { uk: "ліміт 0 — {state}", en: "limit 0 — {state}" },
  tgBudgetZeroKept: { uk: "тримається", en: "held" },
  tgBudgetZeroBroken: { uk: "зламано", en: "broken" },
  tgBudgetProjected: { uk: "прогноз {amount}", en: "projected {amount}" },
  tgBudgetLumpy: { uk: "разова витрата — не екстраполюю", en: "one-off — not extrapolated" },

  tgSubsHeader: { uk: "🔁 <b>Підписки й плани</b>", en: "🔁 <b>Subscriptions and plans</b>" },
  tgSubsBurden: { uk: "На місяць: <b>{amount}</b> · на рік ≈ {year}", en: "Per month: <b>{amount}</b> · per year ≈ {year}" },
  tgSubsEmpty: { uk: "Планових платежів ще немає.", en: "No planned payments yet." },
  tgSubsNext: { uk: "<b>Найближчі 7 днів</b>", en: "<b>Next 7 days</b>" },
  tgSubsNone7: { uk: "Найближчі 7 днів — нічого не списується.", en: "Nothing is due in the next 7 days." },

  tgGoalsHeader: { uk: "🎯 <b>Цілі</b>", en: "🎯 <b>Goals</b>" },
  tgGoalsEmpty: { uk: "Цілей ще немає.", en: "No goals yet." },
  tgGoalBehind: { uk: "відстає", en: "behind" },
  tgGoalAtRisk: { uk: "під загрозою", en: "at risk" },
  tgGoalOnTrack: { uk: "у графіку", en: "on track" },
  tgGoalDone: { uk: "зібрано", en: "reached" },
  tgGoalPerMonth: { uk: "треба {amount}/міс", en: "needs {amount}/mo" },
  tgGoalLeft: { uk: "лишилось {amount}", en: "{amount} to go" },

  tgParsedIncome: { uk: "Розпізнав надходження:", en: "Parsed income:" },
  tgSavedIncomeAs: { uk: "✅ Збережено надходження: <b>{merchant}</b> — {amount}", en: "✅ Income saved: <b>{merchant}</b> — {amount}" },
  tgOpenApp: { uk: "Відкрити у застосунку", en: "Open in the app" },

  tgNotifyHeader: { uk: "🔔 <b>Сповіщення</b>", en: "🔔 <b>Notifications</b>" },
  tgNotifyHint: {
    uk: "Вимкнути: <code>/mute {example}</code> · увімкнути: <code>/unmute {example}</code>",
    en: "Turn off: <code>/mute {example}</code> · turn on: <code>/unmute {example}</code>",
  },
  tgNotifyUnknown: {
    uk: "Не знаю такого типу: <code>{kind}</code>. Напиши /notify, щоб побачити список.",
    en: "No such type: <code>{kind}</code>. Send /notify to see the list.",
  },
  tgNotifyMuted: { uk: "🔕 Вимкнено: <b>{kind}</b>", en: "🔕 Turned off: <b>{kind}</b>" },
  tgNotifyUnmuted: { uk: "🔔 Увімкнено: <b>{kind}</b>", en: "🔔 Turned on: <b>{kind}</b>" },
  tgNotifyUsage: {
    uk: "Вкажи тип: <code>/mute budget</code>. Список — /notify",
    en: "Name a type: <code>/mute budget</code>. The list is /notify",
  },

  tgLinkPrivateOnly: {
    uk: "🚫 Привʼязати акаунт можна лише в ОСОБИСТОМУ чаті з ботом.\n"
      + "Сюди приходили б сповіщення з твоїми балансами й сумами — тобто всім у цій групі. "
      + "Відкрий бота напряму й натисни кнопку привʼязки там.",
    en: "🚫 An account can only be linked in a PRIVATE chat with the bot.\n"
      + "Notifications carry your balances and amounts — here that would mean everyone in this "
      + "group. Open the bot directly and press the link button there.",
  },
  tgRelinked: {
    uk: "⚠️ Цей акаунт щойно привʼязали до ІНШОГО чату. Сюди сповіщення більше не приходитимуть, і команди тут більше не працюють.\n"
      + "Якщо це були не ви — відкрийте застосунок і привʼяжіть чат заново; стара привʼязка вже знята.",
    en: "⚠️ This account has just been linked to a DIFFERENT chat. Notifications will stop here and commands no longer work.\n"
      + "If this was not you, open the app and link your chat again — the old link is already gone.",
  },
  tgUnlinkDone: {
    uk: "🔌 Чат відвʼязано. Сповіщення сюди більше не приходитимуть, і команди не працюватимуть.\n"
      + "Привʼязати знову — кнопка в Налаштуваннях застосунку.",
    en: "🔌 Chat unlinked. Notifications will stop and commands will no longer work here.\n"
      + "To link again, use the button in the app's Settings.",
  },

  tgTruncated: { uk: "(показано не все — решта у застосунку)", en: "(trimmed — the rest is in the app)" },

  // §TG-CSV — a statement dropped into the chat.
  tgImportNotCsv: {
    uk: "Я вмію читати виписки у CSV (.csv/.tsv/.txt). XLS і PDF поки не читаю — вивантаж CSV.",
    en: "I can read statements as CSV (.csv/.tsv/.txt). XLS and PDF are not supported yet — export CSV instead.",
  },
  tgImportTooBig: {
    uk: "Файл завеликий, щоб забрати його з Telegram. Заванаж його в застосунку.",
    en: "The file is too large to fetch from Telegram. Upload it in the app instead.",
  },
  tgImportDownloadFailed: {
    uk: "Не вдалося завантажити файл із Telegram. Спробуй надіслати ще раз.",
    en: "Could not download the file from Telegram. Try sending it again.",
  },
  tgImportUnreadable: {
    uk: "Не вдалося прочитати цей файл як таблицю — схоже, це не виписка.",
    en: "Could not read this file as a table — it does not look like a statement.",
  },
  tgImportColDate: { uk: "дата", en: "date" },
  tgImportColAmount: { uk: "сума", en: "amount" },
  tgImportColDesc: { uk: "опис", en: "description" },
  // The refusal NAMES the columns and points at the screen that can fix it: a chat cannot show a
  // column picker, and guessing here writes a month of wrong numbers nobody re-reads to catch.
  tgImportIncomplete: {
    uk: "Не впізнав колонки: {missing}. У чаті їх не вибереш — відкрий імпорт у застосунку: {url}",
    en: "Could not recognise these columns: {missing}. A chat cannot pick them — open the import in the app: {url}",
  },
  tgImportNoAccounts: {
    uk: "Немає жодного активного рахунку, куди це імпортувати.",
    en: "There is no active account to import this into.",
  },
  tgImportHead: { uk: "📄 <b>{name}</b> — розпізнав {n} операцій", en: "📄 <b>{name}</b> — read {n} operations" },
  tgImportWindow: { uk: "Період: {from} – {to}", en: "Period: {from} – {to}" },
  tgImportSkipped: { uk: "Пропущу {n} рядків (не дата або нульова сума)", en: "Will skip {n} rows (no date, or a zero amount)" },
  tgImportAiMapping: {
    uk: "⚠️ Колонки зіставив AI — перевір результат після імпорту.",
    en: "⚠️ The columns were matched by AI — check the result after importing.",
  },
  // Choosing the account IS the confirmation: there is nothing else worth deciding from a phone,
  // and an import into the wrong account is wrong by a factor of forty and looks ordinary after.
  tgImportPickAccount: { uk: "На який рахунок імпортувати?", en: "Which account should this go into?" },
  tgImportWorking: { uk: "⏳ Імпортую <b>{name}</b>…", en: "⏳ Importing <b>{name}</b>…" },
  tgImportDone: {
    uk: "✅ <b>{name}</b>: додано {inserted}, вже було {duplicates}, пропущено {skipped}.",
    en: "✅ <b>{name}</b>: added {inserted}, already present {duplicates}, skipped {skipped}.",
  },
  tgImportFailed: { uk: "Не вдалося імпортувати цей файл.", en: "Could not import this file." },
  tgImportStale: {
    uk: "Цей файл уже опрацьовано або застарів — надішли його ще раз.",
    en: "This file was already handled or has expired — send it again.",
  },
} as const;
