// §Аналітика 2.0 — ЄДИНЕ джерело правди для визначення «витрати/доходу» та зведення в ₴.
// Використовується в усіх /analytics-ендпоінтах, forecast, AI-контексті та репортах,
// щоб цифри UI = цифри AI = цифри репорту. Правила (узгоджено з користувачем):
//   • витрата: amount<0, НЕ пара-переказ, НЕ незакритий рух власних коштів,
//     ефективна категорія ≠ «Перекази і зняття» (13); holds рахуються (див. SPEND_WHERE);
//   • ефективна категорія = рол-ап real_category_id (готівка/зняття за реальною суттю),
//     інакше рол-ап звичайної category_id;
//   • зведення валют у ₴ через курси (inline CASE), опційно — «чиста» валюта.
import type { Rates } from "./money.ts";
import type { Env } from "../../env.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { getState } from "./repo.ts";
import { catNameSql } from "./categories-i18n.ts";
import { resolveLocale } from "../platform/i18n.ts";

export const TRANSFER_CAT = 13; // «Перекази і зняття» (+ діти через рол-ап)

// Джоїни, потрібні для рол-апу і звичайної, і реальної категорії. Очікує alias `t`.
// §SPLIT: LEFT JOIN tx_splits — якщо у tx є частини, рядок розмножується на них; sc/scp —
// рол-ап категорії частини. Для НЕ-спліт tx усі sp/sc/scp = NULL → рядок один, поведінка стара.
export const STATS_JOINS = `
  LEFT JOIN categories c  ON c.id  = t.category_id
  LEFT JOIN categories p  ON p.id  = c.parent_id
  LEFT JOIN categories rc ON rc.id = t.real_category_id
  LEFT JOIN categories rp ON rp.id = rc.parent_id
  LEFT JOIN tx_splits sp  ON sp.tx_id = t.id
  LEFT JOIN categories sc ON sc.id = sp.category_id
  LEFT JOIN categories scp ON scp.id = sc.parent_id`;

// §SPLIT: ефективна сума рядка = сума частини (якщо tx розділено), інакше сума tx. Копійки, знак tx.
// §COMPENSATION (0029/0030): якщо частину витрати компенсували («скинули за вечерю»), своєю є
// лише решта — тому до суми tx додається `reimbursed` (додатне, а сума витрати відʼємна → модуль
// меншає). Компенсація навмисно НЕ розподіляється по частинах спліту: спліт відповідає на
// «на що пішли гроші», компенсація — на «скільки з цього моє», і змішувати їх в одному рядку
// означало б ділити компенсацію пропорційно з округленням на кожну частину. Тому запис
// компенсації на спліт-tx заборонено на рівні ендпоінта (`/reimbursement`), і `sp.amount`
// тут безпечно виграє.
// `t.reimbursed` — денормалізована сума розподілів із `tx_reimbursements` (єдиний писар —
// ендпоінт). Саме тому найгарячіший вираз проєкту не отримує жодного нового JOIN.
export const EFF_AMOUNT = "COALESCE(sp.amount, t.amount + COALESCE(t.reimbursed, 0))";

// §COMPENSATION v2 (0030): дохід рахується від ЗАЛИШКУ надходження, а не «все або нічого».
// Знайдено на реальних даних: P2P-надходження, більше за витрату, яку воно покривало. Стара
// модель виключала з доходу ВСЕ надходження, тож різниця не потрапляла ні у витрати, ні в дохід —
// гроші зникали зі статистики. Тепер компенсацією є лише розподілена частина
// (`reimburses_total`), а нерозподілений залишок — справжній дохід.
export const EFF_INCOME = "(t.amount - COALESCE(t.reimburses_total, 0))";

// Ефективна категорія (рол-ап у батька): спершу частина спліту (sc/scp), тоді реальна (для
// зняття/переказів), інакше звичайна. NULL = без категорії (рахуємо як витрату).
export const EFF_CAT_ID = "COALESCE(scp.id, sc.id, rp.id, rc.id, p.id, c.id)";
export const EFF_CAT_NAME = "COALESCE(scp.name, sc.name, rp.name, rc.name, p.name, c.name)";
export const EFF_CAT_COLOR = "COALESCE(scp.color, sc.color, rp.color, rc.color, p.color, c.color)";

/**
 * §CAT-LEAF — the effective category WITHOUT the roll-up: the row's own sub-category.
 *
 * `EFF_CAT_ID` deliberately prefers the PARENT (`scp`/`rp`/`p` come first), because every aggregate
 * in the app groups by parent. The consequence, found on live data: filtering `EFF_CAT_ID = <a
 * sub-category id>` matches NOTHING, because rows in "Таксі" report as "Транспорт". So the category
 * page rendered completely empty for every sub-category — and it links to its own children, so the
 * app offered a link to a page it guaranteed would be blank.
 *
 * ⚠️ This is NOT an alternative canon and must not be used for aggregation. It answers exactly one
 * question — "which leaf did this row land in" — and exists so a page ABOUT a leaf can find its
 * rows. Anything summing across categories keeps using `EFF_CAT_ID`, or a split filed under a
 * sub-category would stop rolling into its parent.
 */
export const EFF_CAT_LEAF_ID = "COALESCE(sc.id, rc.id, c.id)";

// §6 Вагомість: override операції → вагомість ефективної категорії (рол-ап; частина спліту має
// пріоритет) → дефолт 'discretionary'. Потребує STATS_JOINS. Значення: essential|discretionary|optional.
export const EFF_IMPORTANCE = "COALESCE(t.importance, scp.importance, sc.importance, rp.importance, rc.importance, p.importance, c.importance, 'discretionary')";

// Чи ефективна категорія рядка — ДОХІДНА. Та сама черга пріоритетів, що й `EFF_CAT_ID`.
export const EFF_CAT_IS_INCOME = "COALESCE(scp.is_income, sc.is_income, rp.is_income, rc.is_income, p.is_income, c.is_income)";

// ---- §REFUND: повернення коштів — це НЕ дохід ---------------------------------
// Баг, знайдений 2026-07-20 на реальних даних: `INCOME_WHERE` був просто `amount > 0`, тож
// скасування покупки («Скасування. <мерчант>») рахувалось ДОХОДОМ, а сама покупка лишалась
// повною витратою своєї категорії. Роздувались одночасно дохід, витрати категорії, норма
// заощаджень, burn і runway.
//
// Правильна модель: рефанд — це ВІД'ЄМНА ВИТРАТА своєї категорії. Тому він проходить
// `SPEND_WHERE` (і `amountSum` віднімає його, бо рахує `-EFF_AMOUNT`) і НЕ проходить
// `INCOME_WHERE`. Розпізнаємо двома незалежними ознаками:
//   1) надходження з ВИТРАТНОЮ категорією (is_income=0) — категоризований рефанд;
//   2) опис від банку («Скасування. …») — коли категорії ще нема (звірено на remote:
//      усі 6 рефандів мають рівно цей префікс, решта надходжень — реальний дохід/перекази).
// ⚠️ Кирилиця: SQLite згортає регістр лише для ASCII, тож перелічуємо варіанти явно.
const REFUND_PREFIXES = ["Скасування", "скасування", "СКАСУВАННЯ", "Повернення", "повернення", "Відміна", "відміна", "Refund", "refund"];
// ⚠️ `COALESCE(t.merchant, '')`, НЕ голий `t.merchant` (знайдено тестами E1, 2026-07-26).
// SQL — тризначна логіка: при `merchant IS NULL` кожен `LIKE` дає NULL, а `false OR NULL` = NULL
// (не false). Тому `IS_REFUND` ставав NULL, `NOT IS_REFUND` — теж NULL, і рядок НЕ проходив
// `INCOME_WHERE`. Наслідок: будь-яке надходження БЕЗ назви мерчанта — готівковий дохід, вхідний
// P2P без опису, імпорт CSV без колонки опису — мовчки зникало з доходу. Прогнано: зарплата
// 5000 ₴ з `merchant IS NULL` давала дохід 0. Це той самий клас, що §COMPENSATION v1: гроші не
// потрапляли ні у витрати, ні в дохід. Порожній рядок під LIKE — звичайний false.
const REFUND_DESC = REFUND_PREFIXES.map((w) => `COALESCE(t.merchant, '') LIKE '${w}%'`).join(" OR ");
// ⚠️ Категорія мусить ІСНУВАТИ: `COALESCE(..., 0)` зробив би рефандом будь-яке надходження
// без категорії — зокрема вхідний P2P «Від: Кирило», який є справжнім доходом. Некатегоризований
// рефанд ловиться другою ознакою (описом), а не відсутністю категорії.
// ⚠️ Бакет «Перекази і зняття» (13) теж має is_income=0, тож без явного виключення сюди
// потрапляли б «З Білої картки» / «Поповнення рахунку Банки» — це рух ВЛАСНИХ коштів,
// а не повернення покупки (звірено на remote).
export const IS_REFUND =
  `(t.amount > 0 AND ${EFF_CAT_ID} IS NOT ${TRANSFER_CAT}
    AND ((${EFF_CAT_ID} IS NOT NULL AND ${EFF_CAT_IS_INCOME} = 0) OR ${REFUND_DESC}))`;

// Канонічний фільтр витрати. `IS NOT 13` (а не `!= 13`) — щоб NULL-категорія (без
// категорії) все одно рахувалась як витрата; лише явний бакет 13 виключається.
// Holds НЕ виключаємо: monobank надсилає лише реальні (виконані) операції, а коли hold
// закривається — той самий id перезаписується (repo.ts). Тому held-рядок = справжня
// витрата; інакше свіжий тиждень/місяць у репорті/Статистиці порожній, хоча в списку
// транзакцій операції є (той список holds показує). Прапорець `hold` лишається для UI-бейджа.
// §REFUND: рефанд теж проходить сюди — з ДОДАТНОЮ сумою, тож `amountSum`/`spendSum`
// (вони рахують `-EFF_AMOUNT`) віднімають його від витрат категорії. Це і є «чисті витрати».
// §COMPENSATION: надходження, з якого хоч щось розподілено на витрати, не може бути ще й
// «відʼємною витратою» — його ефект уже сидить у `reimbursed` тих витрат. Без цього рядка
// компенсація, якій користувач дав витратну категорію («Кафе»), проходила б як `IS_REFUND`
// і віднімалась удруге. Нерозподілений залишок ловить `INCOME_WHERE` (див. `EFF_INCOME`).
export const SPEND_WHERE = `
  (${EFF_AMOUNT} < 0 OR ${IS_REFUND})
  AND t.transfer_pair_id IS NULL
  AND COALESCE(t.reimburses_total, 0) = 0
  AND NOT (t.is_transfer = 1 AND t.real_category_id IS NULL)
  AND ${EFF_CAT_ID} IS NOT ${TRANSFER_CAT}`;

// Канонічний фільтр доходу: надходження, не пара-переказ, не рух власних (holds — див. SPEND_WHERE).
// §REFUND: повернення коштів сюди НЕ входить — це не заробіток, а відкат власної витрати.
// ⚠️ Так само виключено бакет «Перекази і зняття» (13) — симетрично до `SPEND_WHERE`.
// Без цього надходження з категорією 13, у яких `is_transfer=0` (виплата банки, «З Білої
// картки»), рахувались ДОХОДОМ: рух власних грошей роздував і дохід, і норму заощаджень.
// §COMPENSATION: гроші, які тобі скинули за спільну витрату, — це НЕ заробіток. Розподілена
// частина вже зменшила ту витрату через `reimbursed`; порахувати її ще й доходом означало б
// покращити норму заощаджень на рівному місці. Але НЕрозподілений залишок доходом Є —
// тому фільтр дивиться на `EFF_INCOME > 0`, а не виключає надходження цілком.
export const INCOME_WHERE = `
  t.amount > 0 AND ${EFF_INCOME} > 0
  AND t.transfer_pair_id IS NULL AND t.is_transfer = 0
  AND ${EFF_CAT_ID} IS NOT ${TRANSFER_CAT} AND NOT ${IS_REFUND}`;

// Roll-up multiplier for the current row, in the READER'S base (inline CASE over the rates): each
// known code → how many base units one minor unit is worth (same as `toBaseMinor`); unknown → 0.
//
// §BASE-CUR: this used to hardcode `WHEN 980 THEN 1.0`, which made "roll up into one unit" and
// "roll up into ₴" the same sentence. The 980 row now arrives in the map itself (`ratesInBase`),
// so this function does not know which currency the base is — and that is exactly why none of its
// forty consumers had to be audited for the one that forgot to convert.
export function baseMult(rates: Rates, col = "t.currency_code"): string {
  const parts: string[] = [];
  for (const [code, rate] of Object.entries(rates)) {
    if (Number(code) > 0 && Number.isFinite(rate) && rate > 0) parts.push(`WHEN ${Number(code)} THEN ${rate}`);
  }
  // The hryvnia arm is guaranteed. A map from `getRates(env)` always carries its own 980 entry;
  // a RAW map (or an empty one, on an account whose rates step has never run) never does, and
  // without this line every hryvnia row in such a query would multiply by the ELSE branch — 0.
  // That is the whole ledger silently reading as zero, which looks like an empty account.
  if (!("980" in rates)) parts.unshift("WHEN 980 THEN 1.0");
  return `(CASE ${col} ${parts.join(" ")} ELSE 0 END)`;
}

// Value mode: roll up into the reader's base (default, §BASE-CUR), or a "pure" currency
// (currency=NNN → multiplier 1 plus a currency filter). Returns the multiplier and a WHERE
// fragment, which may be empty.
export function valueMode(rates: Rates, currency?: number | null): { mult: string; curFilter: string } {
  if (currency && currency !== 0) return { mult: "1.0", curFilter: ` AND t.currency_code = ${Math.trunc(currency)}` };
  return { mult: baseMult(rates), curFilter: "" };
}

// Готові SUM-вирази із ВБУДОВАНИМ канонічним фільтром (тому totals — один запит; запит
// має включати STATS_JOINS). `mult` — з valueMode(). Округлено, знак витрати додатний.
export function spendSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM(CASE WHEN ${SPEND_WHERE} THEN (-${EFF_AMOUNT}) * ${mult} ELSE 0 END), 0)) AS INTEGER)`;
}
// §COMPENSATION v2: сумуємо `EFF_INCOME`, а не `t.amount` — інакше частково розподілене
// надходження зайшло б у дохід повною сумою, хоч частина вже пішла на покриття витрати.
export function incomeSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM(CASE WHEN ${INCOME_WHERE} THEN ${EFF_INCOME} * ${mult} ELSE 0 END), 0)) AS INTEGER)`;
}
// §REFUND: рахуємо лише реальні ВІДТОКИ. Рефанд проходить SPEND_WHERE (щоб відняти суму),
// але як «операція-витрата» він не рахується — інакше середній чек ділився б на більшу
// кількість і виходив заниженим.
// `COALESCE(…, 0)` не косметика: `SUM()` над ПОРОЖНЬОЮ множиною в SQL — це NULL, а не нуль.
// Сусідні `spendSum`/`incomeSum` COALESCE мали з самого початку, ці два — ні, тож новий акаунт
// (і демо в перші хвилини) отримував `n: null` там, де UI чекає число, і картка «операцій»
// показувала ПОРОЖНЄ місце. Порожнеча читається як збій, а не як «даних ще нема» — те саме
// правило, що для «вантажиться vs даних нема» (CLAUDE.md).
export const SPEND_COUNT = `COALESCE(SUM(CASE WHEN (${SPEND_WHERE}) AND ${EFF_AMOUNT} < 0 THEN 1 ELSE 0 END), 0)`;
export const INCOME_COUNT = `COALESCE(SUM(CASE WHEN ${INCOME_WHERE} THEN 1 ELSE 0 END), 0)`;
// §CADENCE: скільки РЕАЛЬНИХ списань, а не рядків. `SPEND_COUNT` рахує рядки після
// STATS_JOINS, тож витрата, розбита на 3 частини (§SPLIT), важить у ньому 3 — для середнього
// чека це свідомо, а для «як часто ця категорія списується» — ні: підписка виглядала б
// щоденною. Використовується там, де рахуємо РИТМ (звіт коротшого за місяць періоду).
// SPEND_WHERE мусить бути у WHERE рядка — тут лише відсів рефандів (вони не списання).
export const SPEND_TX_COUNT = `COUNT(DISTINCT CASE WHEN ${EFF_AMOUNT} < 0 THEN t.id END)`;
// Сума однієї канонічної гілки (byCategory/byMerchant — SPEND_WHERE уже у WHERE рядка).
export function amountSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM((-${EFF_AMOUNT}) * ${mult}), 0)) AS INTEGER)`;
}

// ---- §E1: Разові vs регулярні (канонічно) -----------------------------------
// Операція «регулярна», якщо: (а) прив'язана до планового платежу/підписки (planned_id) —
// напр. квартальна PS Plus, яку інакше не зловиш повторюваністю; АБО (б) її мерчант має
// витрати у ≥RECUR_MIN_MONTHS РІЗНИХ календарних місяцях у трейлінг-референс-вікні. Це
// відділяє звичні витрати (продукти, транспорт, підписки) від разових (податки, стоматолог,
// велика покупка), щоб «нормальний» місячний burn не спотворювався викидами. Без AI.
export const RECUR_MIN_MONTHS = 3;

// Підзапит мерчантів, що кваліфікуються як регулярні (легкий фільтр — рекуренція евристична).
//
// ⚠️ Місяці рахуються в APP_TZ (`localFmtSql`, виправлено 2026-08-21). Голий `strftime` віддає
// UTC-місяць, тож списання 1-го числа до 03:00 за Києвом зараховувалось у ПОПЕРЕДНІЙ місяць — а
// поріг тут рівно `>= 3 різних місяці`, тобто один такий платіж вирішує, регулярна витрата чи
// разова. Це, своєю чергою, вирішує, чи потрапить вона в місячний burn.
function recurringMerchantsSubquery(refFrom: number, to: number): string {
  return `SELECT merchant FROM transactions
    WHERE time >= ${Math.trunc(refFrom)} AND time <= ${Math.trunc(to)}
      AND amount < 0 AND transfer_pair_id IS NULL AND is_transfer = 0
      AND merchant IS NOT NULL AND merchant <> ''
    GROUP BY merchant
    HAVING COUNT(DISTINCT ${localFmtSql(to, "%Y-%m", "time")}) >= ${RECUR_MIN_MONTHS}`;
}
// Булевий вираз «поточний рядок t — регулярний» (для CASE/фільтрів). Потребує alias `t`.
// planned_id → підписка/розстрочка (регулярне за визначенням); або мерчант із рекуренцією.
export function isRecurringExpr(refFrom: number, to: number): string {
  return `(t.planned_id IS NOT NULL OR (t.merchant IS NOT NULL AND t.merchant IN (${recurringMerchantsSubquery(refFrom, to)})))`;
}

export interface SplitBucket { spent: number; n: number }
export interface OneoffItem { merchant: string | null; category: string | null; amount: number; time: number }
export interface RecurringSplit {
  ref_from: number;
  recurring: SplitBucket;
  oneoff: SplitBucket;
  oneoff_items: OneoffItem[];  // найбільші разові витрати періоду
}

// Референс-вікно за замовчуванням — 6 календарних місяців назад від `to` (щоб було з чого
// рахувати «≥3 місяці»).
export function defaultRefFrom(to: number): number {
  return localMonthStart(to, -5);
}

// Канонічний split витрат періоду на регулярні/разові + топ разових. Зведено в ₴ (mult).
export async function recurringOneoffSplit(
  env: Env, from: number, to: number, mult: string, refFrom = defaultRefFrom(to),
): Promise<RecurringSplit> {
  const recur = isRecurringExpr(refFrom, to);
  const [split, items] = await Promise.all([
    env.DB.prepare(
      `SELECT CASE WHEN ${recur} THEN 'recurring' ELSE 'oneoff' END AS kind,
              ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY kind`,
    ).bind(from, to).all<{ kind: string; spent: number; n: number }>(),
    env.DB.prepare(
      // §LANG-ARCH: the category name is resolved HERE, not by whoever renders it. Three of the
      // four callers are AI context builders, which had no post-map at all — so the model was
      // handed «Продукти» while the screen beside it said "Groceries", the exact split that made
      // the tool filters miss and the prose come back in the wrong language.
      `SELECT t.merchant AS merchant, ${catNameSql(await resolveLocale(env), EFF_CAT_NAME)} AS category,
              CAST(ROUND((-${EFF_AMOUNT}) * ${mult}) AS INTEGER) AS amount, t.time AS time
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND NOT ${recur}
       ORDER BY amount DESC LIMIT 6`,
    ).bind(from, to).all<OneoffItem>(),
  ]);
  const get = (k: string): SplitBucket => {
    const r = (split.results ?? []).find((x) => x.kind === k);
    return { spent: r?.spent ?? 0, n: r?.n ?? 0 };
  };
  return { ref_from: refFrom, recurring: get("recurring"), oneoff: get("oneoff"), oneoff_items: items.results ?? [] };
}

// ---- Прогноз витрати «зі здоровим глуздом» ----------------------------------
// Проблема наївного темпу (`spent / elapsedFrac`): рано в місяці або для «лумпів»
// (податки, оренда, одна заправка) він роздуває прогноз у рази — 3000₴ податку на 9-й
// день → 10000₴; одна заправка 900₴ → 2500₴. Замість цього: прогноз = «вже витрачено +
// історичний залишок», а лумпи (домінує одна велика операція) НЕ екстраполюємо взагалі.
//   • cur         — витрачено цього періоду (₴-мінор, додатне);
//   • usual        — історичне середнє за трейлінг-місяці (₴-мінор);
//   • elapsedFrac — частка періоду, що минула (0..1);
//   • lumpy       — витрата зосереджена в 1-2 великих операціях (не «капає» щодня).
// Континуальні категорії блендуємо: рано довіряємо історії, пізно — фактичному темпу;
// із запобіжником-кепом (не вище 3× звичного, поки факт сам не перевищив) проти «бреду».
export function projectSpend(cur: number, usual: number, elapsedFrac: number, lumpy: boolean): number {
  const ef = Math.min(1, Math.max(0.05, elapsedFrac));
  if (lumpy || usual <= 0) return Math.round(Math.max(cur, usual)); // лумп уже стався — не множимо
  const remHist = usual * (1 - ef);                 // скільки історія каже ще витратити
  const remPace = (cur / ef) * (1 - ef);            // якщо тримати поточний темп
  const remaining = remHist * (1 - ef) + remPace * ef; // рано→історія, пізно→темп
  const projected = cur + remaining;
  const cap = Math.max(cur, usual * 3);             // антибред: не вище 3× звичного (поки факт не перевищив)
  return Math.round(Math.min(projected, cap));
}

// ---- Періоди (календарний ⇄ ковзний) ----------------------------------------
//
// §APP_TZ now lives in `time.ts` and is RE-EXPORTED here. The move was forced by the C3 ceiling,
// but the re-export is not a dodge: `stats.ts` is the canon every consumer already imports, and
// rewriting twenty-seven import lists would have buried a set of real bug fixes in churn. New
// code may import either; the definitions exist exactly once.
export {
  APP_TZ, localParts, localMidnight, localWallTime, localDayStart, localWeekStart,
  localMonthStart, localQuarterStart, localYearStart, localYm, localYmd, tzOffsetSec,
  localYmSql, localFmtSql, type LocalParts,
} from "./time.ts";
import {
  localWeekStart, localMonthStart, localQuarterStart, localYearStart,
  localFmtSql,
} from "./time.ts";
/**
 * The canonical monthly LEVEL and the burn built from it live in `levels.ts` (lint C3, 2026-08-27)
 * and are re-exported here: they are canon, and every caller has always reached them through this
 * module. Same arrangement as `time.ts` — one definition, two spellings of the import.
 */
export { categoryMonthlyLevels, sumLevels, type MonthLevel } from "./levels.ts";

export type PeriodMode = "calendar" | "rolling";
export type Preset = "week" | "month" | "quarter" | "year";

export interface Bounds { from: number; to: number; prevFrom: number; prevTo: number; bucket: "day" | "week" | "month" }

const DAY = 86400;


// Межі періоду + рівний попередній (для «vs минулий»). Календарний = природні межі
// циклу; ковзний = останні N днів. `now` — верхня межа (звичайно поточний час).
export function periodBounds(mode: PeriodMode, preset: Preset, now = Math.floor(Date.now() / 1000)): Bounds {
  const bucket: Bounds["bucket"] = preset === "year" ? "month" : preset === "quarter" ? "week" : "day";

  if (mode === "rolling") {
    const days = preset === "week" ? 7 : preset === "month" ? 30 : preset === "quarter" ? 90 : 365;
    const from = now - days * DAY;
    return { from, to: now, prevFrom: from - days * DAY, prevTo: from, bucket };
  }

  // Календарний — межі в ЛОКАЛЬНІЙ зоні (див. §APP_TZ вгорі).
  if (preset === "week") {
    const from = localWeekStart(now);          // ISO-тиждень: понеділок 00:00 за Києвом
    return { from, to: now, prevFrom: localWeekStart(now, -1), prevTo: from, bucket };
  }
  if (preset === "month") {
    const from = localMonthStart(now);
    return { from, to: now, prevFrom: localMonthStart(now, -1), prevTo: from, bucket };
  }
  if (preset === "quarter") {
    const from = localQuarterStart(now);
    return { from, to: now, prevFrom: localQuarterStart(now, -1), prevTo: from, bucket };
  }
  const from = localYearStart(now);
  return { from, to: now, prevFrom: localYearStart(now, -1), prevTo: from, bucket };
}

// Поточний період ДО сьогодні (для ручної генерації/тесту — дані, які видно зараз).
// Попередній — той самий відрізок минулого циклу (чесний MTD).
export function currentPeriodToDate(preset: "week" | "month", now = Math.floor(Date.now() / 1000)): { from: number; to: number; prevFrom: number; prevTo: number } {
  const from = preset === "week" ? localWeekStart(now) : localMonthStart(now);
  const prevFrom = preset === "week" ? localWeekStart(now, -1) : localMonthStart(now, -1);
  const elapsed = now - from;
  return { from, to: now, prevFrom, prevTo: prevFrom + elapsed };
}

// Повні (закриті) межі попереднього періоду — для репортів «за минулий тиждень/місяць».
export function lastCompletePeriod(preset: "week" | "month", now = Math.floor(Date.now() / 1000)): { from: number; to: number; prevFrom: number; prevTo: number } {
  if (preset === "week") {
    return {
      from: localWeekStart(now, -1), to: localWeekStart(now),
      prevFrom: localWeekStart(now, -2), prevTo: localWeekStart(now, -1),
    };
  }
  return {
    from: localMonthStart(now, -1), to: localMonthStart(now),
    prevFrom: localMonthStart(now, -2), prevTo: localMonthStart(now, -1),
  };
}

/**
 * The owner's period mode, with its default applied ONCE (§D4).
 *
 * Three handlers used to write `getState(db, "period_mode") || "calendar"` by hand, and after the
 * route split they sit in three different files — so the duplication became LESS visible, not
 * more, which is precisely when a fourth copy appears with a different default. Which mode is in
 * force decides the boundaries the Dashboard, Statistics and the AI adviser all count within: two
 * of them disagreeing would show the same period under two different totals.
 *
 * `getPeriodMode` lives here rather than in `repo/state.ts` because the DEFAULT is a domain
 * decision, not a storage detail — reading the row is what `getState` does; deciding that an
 * absent row means "calendar" is canon.
 */
export async function getPeriodMode(db: AppDb): Promise<PeriodMode> {
  const raw = await getState(db, "period_mode");
  return raw === "rolling" ? "rolling" : "calendar";
}
