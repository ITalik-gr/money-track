/**
 * Server-side UI strings (B3) — the SINGLE source for any Ukrainian text the worker puts into an
 * API response.
 *
 * Why this exists. The client is fully translated (`src/i18n`), but a scan of the worker found
 * ~70 phrases going out of the API as finished Ukrainian: networth caveats printed under a chart,
 * "без категорії" landing inside chart legends, income-stability labels, health-index labels, the
 * deterministic advisor fallback, CSV headers and every validation error. With the demo starting
 * in `en`, a visitor sees an English shell with Ukrainian data in it — which reads as a bug in the
 * product, not as a missing translation.
 *
 * Deliberately NOT here (they are not UI):
 *   - model prompts and tool schemas (`lib/ai/*`) — instructions to Claude, which answers in the
 *     reader's language via `replyLangDirective`;
 *   - match keys (`transfers.ts`, `REFUND_PREFIXES` in `stats.ts`, CSV header aliases) — they are
 *     compared against bank data, so translating them would break the matching;
 *   - the Telegram bot (`routes/telegram.ts`, `messaging/{alert,proactive}.ts`) — owner-only by
 *     the security audit, and the owner's language is Ukrainian.
 *
 * Rule for new code: a string that reaches the client goes through `st()`. Do not write
 * `if (locale === "en")` at the call site — that is how two spellings of one phrase appear.
 */
import type { NotifLocale } from "../../../shared/notif-i18n.ts";

export type ServerLocale = NotifLocale;

/**
 * uk/en pairs in one place, so a missing translation is impossible to commit: the `en` half is
 * part of the same object literal, and `tsc` derives the key union from it.
 */
const S = {
  // ---- fallback labels for missing data ------------------------------------
  // These end up as chart legends and list rows, not as prose. Kept short for that reason.
  uncategorized: { uk: "без категорії", en: "uncategorized" },
  other: { uk: "Інше", en: "Other" },
  unidentified: { uk: "не визначено", en: "not identified" },
  incoming: { uk: "Надходження", en: "Incoming" },
  expense: { uk: "Витрата", en: "Expense" },

  // ---- income analytics (`/analytics/income`) -------------------------------
  stabilityUnknown: { uk: "мало даних", en: "not enough data" },
  stabilityStable: { uk: "стабільний", en: "stable" },
  stabilityModerate: { uk: "помірний", en: "moderate" },
  stabilityVolatile: { uk: "нестабільний", en: "volatile" },

  // ---- networth caveats (`/analytics/networth`) ----------------------------
  // Printed under the chart. Both state a LIMIT OF ACCURACY, so they have to be readable prose,
  // not a code — the whole point is that the visitor can judge how much to trust the line.
  networthRatesCaveat: {
    uk: "Для частини періоду історії курсів ще нема — ті місяці перераховано поточним курсом, тож рух курсу там виглядає як рух грошей. Історія накопичується щодоби.",
    en: "Exchange-rate history does not cover part of this period — those months are converted at today's rate, so a rate move shows up as a money move. History accumulates daily.",
  },
  networthFlatCaveat: {
    uk: "Рахунки без історії операцій ({accounts}) назад показані плоскими — їхній баланс це ручний зріз «на зараз».",
    en: "Accounts with no transaction history ({accounts}) are drawn flat going back — their balance is a manual snapshot of today.",
  },

  // ---- CSV export header ---------------------------------------------------
  csvDate: { uk: "Дата", en: "Date" },
  csvMerchant: { uk: "Мерчант", en: "Merchant" },
  csvComment: { uk: "Коментар", en: "Comment" },
  csvNote: { uk: "Нотатка", en: "Note" },
  csvAmount: { uk: "Сума", en: "Amount" },
  csvCurrency: { uk: "Валюта", en: "Currency" },
  csvCategory: { uk: "Категорія", en: "Category" },
  csvAccount: { uk: "Рахунок", en: "Account" },
  csvGroup: { uk: "Група", en: "Group" },
  csvTransfer: { uk: "Переказ", en: "Transfer" },
  csvYes: { uk: "так", en: "yes" },

  // ---- CSV import: why a row was skipped -----------------------------------
  csvBadDate: { uk: "не розпізнав дату: «{value}»", en: "could not parse the date: “{value}”" },
  csvBadAmount: { uk: "не розпізнав суму: «{value}»", en: "could not parse the amount: “{value}”" },
  csvZeroAmount: { uk: "нульова сума", en: "zero amount" },

  // ---- manual transfer (`POST /transactions/transfer`) ----------------------
  errTransferAccounts: {
    uk: "Оберіть два РІЗНІ свої рахунки.",
    en: "Pick two DIFFERENT accounts of your own.",
  },
  errTransferAmount: { uk: "Сума переказу має бути більшою за нуль.", en: "The transfer amount must be greater than zero." },
  errTransferToAmount: {
    uk: "Рахунки в різних валютах — вкажіть, скільки саме надійшло на другий рахунок.",
    en: "The accounts use different currencies — state how much actually arrived on the second one.",
  },

  // ---- custom-range report (`POST /reports/generate`) -----------------------
  reportBadRange: {
    uk: "Некоректний діапазон дат: кінець має бути пізніше за початок.",
    en: "Invalid date range: the end must be later than the start.",
  },
  reportRangeLimits: {
    uk: "Діапазон має бути від {min} дн. до {max} дн.",
    en: "The range must be between {min} and {max} days.",
  },

  // Bank provider `label`s are deliberately NOT here: nothing returns them to the client (the
  // client keeps its own `BANK_LABEL` map, since bank names are proper nouns), so they are
  // registry metadata rather than UI.

  // ---- health index (`/analytics/health`) -----------------------------------
  healthRunway: { uk: "Подушка (runway)", en: "Runway" },
  healthRunwayHint: {
    uk: "Скільки протягнеш на ліквідну подушку при поточному burn. 6+ міс — добре.",
    en: "How long your liquid cushion lasts at the current burn rate. 6+ months is good.",
  },
  healthSavings: { uk: "Норма заощаджень", en: "Savings rate" },
  healthSavingsHint: {
    uk: "Частка доходу, що лишається після витрат (за повними місяцями). 20%+ — добре.",
    en: "Share of income left after spending (over complete months). 20%+ is good.",
  },
  healthDebt: { uk: "Борг / дохід", en: "Debt / income" },
  healthDebtHint: {
    uk: "Скільки місяців доходу треба, щоб покрити борг по кредитці. Менше — краще.",
    en: "How many months of income it would take to clear the credit-card debt. Lower is better.",
  },
  healthStability: { uk: "Стабільність доходу", en: "Income stability" },
  healthStabilityHint: {
    uk: "Наскільки рівний дохід по місяцях (менший розкид = стабільніше).",
    en: "How even income is month to month (less spread = more stable).",
  },
  healthNoDebt: { uk: "нема боргу", en: "no debt" },
  healthMonthsMax: { uk: "12+ міс", en: "12+ mo" },
  healthMonths: { uk: "{n} міс", en: "{n} mo" },
  healthDebtRatio: { uk: "{n}× міс", en: "{n}× mo" },

  // ---- deterministic advisor fallback (advisor.ts `fallbackAdvice`) ---------
  // Shown when there is no AI key or the model call failed. It is a full advice screen, so it is
  // the longest block here — and the one most likely to be read closely.
  advRunwayTooLittle: {
    uk: "Місячних витрат поки замало, щоб порахувати запас.",
    en: "There isn't enough monthly spending yet to compute a runway.",
  },
  advRunwayText: {
    uk: "Ліквідної подушки {cushion} вистачить приблизно на {months} міс за поточних витрат {burn}/міс.",
    en: "A liquid cushion of {cushion} lasts roughly {months} months at the current {burn}/mo of spending.",
  },
  advTopCatTitle: { uk: "«{name}» — найбільша стаття витрат", en: "“{name}” is your largest spending category" },
  advTopCatDetail: {
    uk: "У середньому {avg} ₴/міс. Скорочення на 15% дає {cut} ₴/міс — це {year} ₴ за рік.",
    en: "{avg} ₴/mo on average. Cutting 15% frees {cut} ₴/mo — that is {year} ₴ a year.",
  },
  advTopCatAction: { uk: "Ліміт {amount} ₴ на «{name}»", en: "Set a {amount} ₴ limit on “{name}”" },
  advOptionalTitle: { uk: "Необовʼязкові витрати — найбезпечніше скорочення", en: "Optional spending is the safest thing to cut" },
  advOptionalDetail: {
    uk: "За 90 днів {sum} ₴ (≈ {perMonth} ₴/міс) у категоріях, позначених як необовʼязкові. Це те, що ріжеться без шкоди для базових потреб.",
    en: "{sum} ₴ over 90 days (≈ {perMonth} ₴/mo) in categories marked optional. This is what you can cut without touching essentials.",
  },
  advBudgetOverOne: { uk: "Бюджет «{category}» перевищено", en: "The “{category}” budget is over" },
  advBudgetOverMany: { uk: "Перевищено бюджетів: {n}", en: "Budgets over limit: {n}" },
  advBudgetOverTail: {
    uk: ". Або підтягни витрати до ліміту, або визнай, що ліміт нереалістичний, і онови його.",
    en: ". Either bring spending back to the limit, or admit the limit is unrealistic and update it.",
  },
  advSubsTitle: { uk: "Підписки йдуть фоном", en: "Subscriptions run in the background" },
  advSubsDetail: {
    uk: "{month} ₴/міс — це {year} ₴ за рік, які списуються без окремого рішення. Перевір, чи всіма користуєшся.",
    en: "{month} ₴/mo is {year} ₴ a year leaving without a decision each time. Check whether you use them all.",
  },
  advUpcomingTitle: { uk: "Найближчі 7 днів: {total} ₴ списань", en: "Next 7 days: {total} ₴ in charges" },
  advUpcomingItem: { uk: "{title} — {amount} ₴ (через {days} дн)", en: "{title} — {amount} ₴ (in {days} d)" },
  advEmptyTitle: { uk: "Даних поки замало", en: "Not enough data yet" },
  advEmptyDetail: {
    uk: "Коли назбирається історія витрат за кілька місяців, тут зʼявляться конкретні кроки на твоїх числах.",
    en: "Once a few months of spending history build up, concrete steps on your own numbers will appear here.",
  },
  advFactCushion: { uk: "Ліквідна подушка", en: "Liquid cushion" },
  advFactBurn: { uk: "Витрати на місяць", en: "Monthly spending" },
  advFactDebt: { uk: "Борг по кредитці", en: "Credit-card debt" },
  advFactTopCat: { uk: "Найбільша категорія", en: "Largest category" },
  advSummary: {
    uk: "Це підсумок на твоїх числах без AI — детерміновані спостереження з тих самих канонічних розрахунків, що й уся статистика.",
    en: "This is a summary on your own numbers without AI — deterministic observations from the same canonical calculations as the rest of the stats.",
  },

  // ---- AI insight empty state ----------------------------------------------
  insightEmpty: { uk: "За обраний період ({label}) витрат не було.", en: "No spending in the selected period ({label})." },
  insightWeek: { uk: "тиждень", en: "week" },
  insightMonth: { uk: "місяць", en: "month" },
  insightDays: { uk: "{n} дн", en: "{n} d" },

  // ---- validation and failure messages -------------------------------------
  errNothingToApply: { uk: "Нема що застосовувати", en: "Nothing to apply" },
  errTransferCatLocked: { uk: "категорію «Перекази і зняття» видаляти не можна", en: "the “Transfers & withdrawals” category cannot be deleted" },
  // ONE phrase for "there is no AI key", used by all ~16 sites that check for it.
  //
  // Since signup opened (2026-07-31) this is the most common thing a new account runs into:
  // there is no deployment-wide fallback for anyone but the owner. The old wordings —
  // "не налаштовано на цьому середовищі" and "ANTHROPIC_API_KEY не налаштовано — див. README" —
  // named an environment variable at a person and pointed at a file they will never open.
  // Say where the button is instead.
  errAiKeyMissing: {
    uk: "Щоб працювали AI-функції, додай свій ключ Anthropic у Налаштуваннях → «Ключі й дані».",
    en: "AI features need your own Anthropic key — add it in Settings → “Keys & data”.",
  },
  errTxNotFound: { uk: "Операцію не знайдено", en: "Transaction not found" },
  // Says the number and when it resets: "limit reached" without either forces the reader to guess
  // whether to wait a minute or give up on the feature.
  errReceiptQuota: {
    uk: "Ліміт чеків на сьогодні вичерпано ({n} на добу). Наступні можна завантажити завтра.",
    en: "Today’s receipt limit is used up ({n} per day). You can upload more tomorrow.",
  },
  goalContribAmount: { uk: "Сума внеску має бути ненульовим числом", en: "A contribution needs a non-zero amount" },
  goalNotFound: { uk: "Ціль не знайдено", en: "Goal not found" },
  goalJarNoContrib: {
    uk: "Ця ціль привʼязана до банки — її прогрес веде баланс рахунку, вносити вручну не треба.",
    en: "This goal tracks a jar account — its progress follows the account balance, no manual entries needed.",
  },
  goalKind: { uk: "Невідомий тип цілі", en: "Unknown goal type" },
  goalAutofillKind: { uk: "Невідоме правило авто-поповнення", en: "Unknown auto-contribution rule" },
  goalAutofillValue: { uk: "Правило авто-поповнення потребує додатного значення", en: "An auto-contribution rule needs a positive value" },
  goalAutofillPct: { uk: "Відсоток від доходу має бути від 1 до 100", en: "The income share must be between 1 and 100" },
  jobBadKind: { uk: "Невідомий тип задачі", en: "Unknown job kind" },
  tgDemoUnavailable: {
    uk: "У демо Telegram недоступний — пісочниця живе 24 години.",
    en: "Telegram is unavailable in the demo — the sandbox only lives 24 hours.",
  },
  tgNotConfigured: {
    uk: "Telegram-бот не налаштований на цьому середовищі.",
    en: "The Telegram bot is not configured on this deployment.",
  },

  errSplitOnlyExpense: { uk: "Ділити можна лише витрату", en: "Only an expense can be split" },
  errSplitHasReimbursement: {
    uk: "На операції вказано компенсацію — прибери її, щоб поділити на категорії",
    en: "This transaction has a reimbursement — remove it to split across categories",
  },
  errSplitMinParts: { uk: "Потрібно щонайменше 2 частини", en: "At least 2 parts are required" },
  errSplitPartShape: { uk: "Кожна частина: категорія + сума < 0", en: "Each part needs a category and a negative amount" },
  errSplitSumMismatch: { uk: "Сума частин має дорівнювати сумі операції ({amount})", en: "Parts must add up to the transaction amount ({amount})" },

  errReimbOnlyExpense: { uk: "Компенсацію можна вказати лише для витрати", en: "A reimbursement can only be set on an expense" },
  errReimbHasSplit: {
    uk: "Операція вже поділена на категорії — прибери поділ, щоб указати компенсацію",
    en: "This transaction is already split across categories — remove the split to set a reimbursement",
  },
  errReimbSomeNotFound: { uk: "Частину операцій не знайдено", en: "Some of the transactions were not found" },
  errReimbSelf: { uk: "Операція не може компенсувати сама себе", en: "A transaction cannot reimburse itself" },
  errReimbOnlyIncome: { uk: "Компенсацією може бути лише надходження", en: "Only an incoming transaction can be a reimbursement" },
  errReimbCurrency: { uk: "Надходження має бути в тій самій валюті, що й витрата", en: "The incoming transaction must be in the same currency as the expense" },
  errReimbNegative: { uk: "Сума розподілу має бути ≥ 0", en: "The allocated amount must be ≥ 0" },
  errReimbSourceExceeded: { uk: "З надходження лишилось {left} — не можна взяти {take}", en: "Only {left} is left on this incoming transaction — cannot take {take}" },
  errReimbTotalNegative: { uk: "Сума компенсації має бути ≥ 0", en: "The reimbursement amount must be ≥ 0" },
  errReimbExceedsExpense: { uk: "Компенсація {total} перевищує суму витрати {expense}", en: "A reimbursement of {total} exceeds the expense of {expense}" },

  errFilterNameRequired: { uk: "Потрібна назва", en: "A name is required" },
  errFilterNoActive: { uk: "Немає жодного активного фільтра", en: "No filter is active" },
  errFilterTooMany: { uk: "Забагато збережених фільтрів (максимум {max})", en: "Too many saved filters (maximum {max})" },

  errDocNotFound: { uk: "Документ не знайдено", en: "Document not found" },
  errDocTitleRequired: { uk: "Потрібна назва документа", en: "A document title is required" },
  errDocEmpty: { uk: "Документ порожній", en: "The document is empty" },
  errDocTooLong: { uk: "Задовгий документ: {len} символів, максимум {max}", en: "Document too long: {len} characters, maximum {max}" },
  errCorpusFullEdit: {
    uk: "Не влазить у корпус: власні документи займуть {used} символів із {max}. Скороти або вимкни інший.",
    en: "Does not fit the corpus: your own documents would take {used} of {max} characters. Shorten or disable another one.",
  },
  errCorpusFull: {
    uk: "Не влазить у корпус: власні документи займуть {used} символів із {max}.",
    en: "Does not fit the corpus: your own documents would take {used} of {max} characters.",
  },
  errDocLocked: {
    uk: "Цей документ описує канон розрахунків застосунку — його не можна змінити",
    en: "This document describes the app's canonical calculations — it cannot be edited",
  },
  errDocCannotHide: { uk: "Цей документ не можна прибрати", en: "This document cannot be removed" },

  errAccountNotFound: { uk: "рахунок не знайдено", en: "account not found" },
  errAccountOnlyManual: { uk: "лише ручний рахунок можна видалити; mono — архівуй", en: "only a manual account can be deleted; archive a mono one instead" },
  errAccountHasTx: { uk: "на рахунку є операції — заархівуй замість видалення", en: "the account has transactions — archive it instead of deleting" },

  errAnthropicRejected: { uk: "Anthropic відхилив ключ", en: "Anthropic rejected the key" },
  errMonoRateLimited: {
    uk: "monobank обмежив перевірку (1 запит/60с) — токен збережено без звірки",
    en: "monobank rate-limited the check (1 request/60s) — the token was saved without verification",
  },
} as const;

export type ServerStringKey = keyof typeof S;

/**
 * Render one string. `{name}` placeholders are substituted from `params`; an unknown placeholder
 * is left as-is rather than blanked, so a typo shows up in the output instead of silently
 * producing a sentence with a hole in it.
 */
export function st(
  locale: ServerLocale,
  key: ServerStringKey,
  params?: Record<string, string | number>,
): string {
  const tpl = S[key][locale === "en" ? "en" : "uk"];
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/**
 * SQL-literal form of a fallback label. Several canonical queries carry their fallback inside the
 * statement (`COALESCE(c.name, 'без категорії')`), and those have to follow the locale too. The
 * quote escaping is here rather than at each call site because forgetting it turns a UI string
 * into a syntax error at runtime, where `tsc` cannot see it.
 */
export function stLit(locale: ServerLocale, key: ServerStringKey): string {
  return `'${st(locale, key).replace(/'/g, "''")}'`;
}

/** Locale-aware grouping for numbers the server formats itself (advisor fallback, health index). */
export function num(locale: ServerLocale, n: number): string {
  return n.toLocaleString(locale === "en" ? "en-US" : "uk-UA");
}
