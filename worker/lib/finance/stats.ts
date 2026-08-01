// §Аналітика 2.0 — ЄДИНЕ джерело правди для визначення «витрати/доходу» та зведення в ₴.
// Використовується в усіх /analytics-ендпоінтах, forecast, AI-контексті та репортах,
// щоб цифри UI = цифри AI = цифри репорту. Правила (узгоджено з користувачем):
//   • витрата: amount<0, НЕ пара-переказ, НЕ незакритий рух власних коштів,
//     ефективна категорія ≠ «Перекази і зняття» (13); holds рахуються (див. SPEND_WHERE);
//   • ефективна категорія = рол-ап real_category_id (готівка/зняття за реальною суттю),
//     інакше рол-ап звичайної category_id;
//   • зведення валют у ₴ через курси (inline CASE), опційно — «чиста» валюта.
import type { Rates } from "./finance.ts";
import type { Env } from "../../env.ts";

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
// Знайдено на реальних даних: «Від: Михайло +2400 ₴» покривав витрату −1870 ₴. Стара модель
// виключала з доходу ВСЕ надходження, тож 530 ₴ не потрапляли ні у витрати, ні в дохід —
// гроші зникали зі статистики. Тепер компенсацією є лише розподілена частина
// (`reimburses_total`), а нерозподілений залишок — справжній дохід.
export const EFF_INCOME = "(t.amount - COALESCE(t.reimburses_total, 0))";

// Ефективна категорія (рол-ап у батька): спершу частина спліту (sc/scp), тоді реальна (для
// зняття/переказів), інакше звичайна. NULL = без категорії (рахуємо як витрату).
export const EFF_CAT_ID = "COALESCE(scp.id, sc.id, rp.id, rc.id, p.id, c.id)";
export const EFF_CAT_NAME = "COALESCE(scp.name, sc.name, rp.name, rc.name, p.name, c.name)";
export const EFF_CAT_COLOR = "COALESCE(scp.color, sc.color, rp.color, rc.color, p.color, c.color)";

// §6 Вагомість: override операції → вагомість ефективної категорії (рол-ап; частина спліту має
// пріоритет) → дефолт 'discretionary'. Потребує STATS_JOINS. Значення: essential|discretionary|optional.
export const EFF_IMPORTANCE = "COALESCE(t.importance, scp.importance, sc.importance, rp.importance, rc.importance, p.importance, c.importance, 'discretionary')";

// Чи ефективна категорія рядка — ДОХІДНА. Та сама черга пріоритетів, що й `EFF_CAT_ID`.
export const EFF_CAT_IS_INCOME = "COALESCE(scp.is_income, sc.is_income, rp.is_income, rc.is_income, p.is_income, c.is_income)";

// ---- §REFUND: повернення коштів — це НЕ дохід ---------------------------------
// Баг, знайдений 2026-07-20 на реальних даних: `INCOME_WHERE` був просто `amount > 0`, тож
// «Скасування. BlaBlaCar +145 ₴» рахувалось ДОХОДОМ, а вихідна покупка −145 ₴ лишалась
// повною витратою в «Транспорті». Роздувались одночасно дохід, витрати категорії, норма
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

// Множник зведення в ₴ для поточного рядка (inline CASE з курсів). 980→1.0; кожен
// відомий код → його курс (₴ за одиницю-мінор, як у toUAHMinor); невідомий → 0.
export function uahMult(rates: Rates, col = "t.currency_code"): string {
  const parts = ["WHEN 980 THEN 1.0"];
  for (const [code, rate] of Object.entries(rates)) {
    if (code === "980") continue;
    if (Number.isFinite(rate) && rate > 0) parts.push(`WHEN ${Number(code)} THEN ${rate}`);
  }
  return `(CASE ${col} ${parts.join(" ")} ELSE 0 END)`;
}

// Режим значення: зведення в ₴ (дефолт) або «чиста» валюта (currency=NNN → множник 1,
// плюс фільтр по валюті). Повертає готовий множник і фрагмент WHERE (може бути порожній).
export function valueMode(rates: Rates, currency?: number | null): { mult: string; curFilter: string } {
  if (currency && currency !== 0) return { mult: "1.0", curFilter: ` AND t.currency_code = ${Math.trunc(currency)}` };
  return { mult: uahMult(rates), curFilter: "" };
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
export const SPEND_COUNT = `SUM(CASE WHEN (${SPEND_WHERE}) AND ${EFF_AMOUNT} < 0 THEN 1 ELSE 0 END)`;
export const INCOME_COUNT = `SUM(CASE WHEN ${INCOME_WHERE} THEN 1 ELSE 0 END)`;
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
function recurringMerchantsSubquery(refFrom: number, to: number): string {
  return `SELECT merchant FROM transactions
    WHERE time >= ${Math.trunc(refFrom)} AND time <= ${Math.trunc(to)}
      AND amount < 0 AND transfer_pair_id IS NULL AND is_transfer = 0
      AND merchant IS NOT NULL AND merchant <> ''
    GROUP BY merchant
    HAVING COUNT(DISTINCT strftime('%Y-%m', time, 'unixepoch')) >= ${RECUR_MIN_MONTHS}`;
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
      `SELECT t.merchant AS merchant, ${EFF_CAT_NAME} AS category,
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

// ---- Канонічний «місячний рівень» категорії (ЄДИНЕ джерело) -----------------
// Проблема (розходження 8к/12500): різні екрани рахували «місячну» суму по різних
// вікнах — 6-міс середнє / 90д÷3 / останній платіж. Після стрибка (рента 8к→12500)
// вони не збігались. Тут — один рівень на категорію, узгоджений скрізь:
//   • fixed-кост (регулярний, СТАБІЛЬНИЙ — низький CV, як рента/підписка): рівень = ОСТАННІЙ
//     повний місяць (ловить стрибок ціни, бо середнє відстає);
//   • змінна категорія (продукти/розваги — високий CV): рівень = середнє за вікно (згладжене).
// Рахуємо лише по ПОВНИХ місяцях (поточний частковий виключено). Зведено в ₴ (mult).
export interface MonthLevel { level: number; mean: number; last: number; active_months: number; cv: number; fixed: boolean }
export async function categoryMonthlyLevels(
  env: Env, mult: string, opts: { months?: number; now?: number } = {},
): Promise<Map<number, MonthLevel>> {
  const K = opts.months ?? 6;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -K);
  const monthStart = localMonthStart(now);
  // Ключі й групування МУСЯТЬ бути в одній зоні, інакше `months.get(k)` промахується і місяць
  // мовчки читається як нульовий — тобто рівень категорії просто занижується.
  const keys: string[] = [];
  for (let i = K; i >= 1; i--) keys.push(localYm(localMonthStart(now, -i)));

  const rows = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}, m`,
  ).bind(from, monthStart).all<{ id: number | null; m: string; spent: number }>();

  const byCat = new Map<number, Map<string, number>>();
  for (const r of rows.results ?? []) {
    if (r.id == null) continue;
    (byCat.get(r.id) ?? byCat.set(r.id, new Map()).get(r.id)!).set(r.m, r.spent);
  }

  const cvOf = (arr: number[]): number => {
    if (!arr.length) return 0;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (m <= 0) return 0;
    const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
    return Math.sqrt(v) / m;
  };

  const out = new Map<number, MonthLevel>();
  for (const [id, months] of byCat) {
    const series = keys.map((k) => months.get(k) ?? 0);
    const mean = Math.round(series.reduce((s, v) => s + v, 0) / K);
    const last = series[series.length - 1] ?? 0;
    const activeMonths = series.filter((v) => v > 0).length;
    // Fixed-кост розпізнаємо за СТАБІЛЬНІСТЮ ОСТАННІХ місяців, а не всього вікна: рента/підписка —
    // останні платежі майже однакові (CV≈0), тож рівень = їх середнє (ловить стрибок ціни). Змінні
    // категорії (продукти/розваги) мають розкид навіть недавно → рівень = середнє за все вікно
    // (не хапаємо випадковий пік останнього місяця). Крок ренти визнається за 2-3 міс нового рівня.
    const recentNz = series.slice(-3).filter((v) => v > 0);
    const fixed = recentNz.length >= 2 && cvOf(recentNz) <= 0.12;
    // §REFUND: місяць може вийти ВІД'ЄМНИМ (повернення перевищило витрати — напр. скасували
    // велику покупку минулого місяця). Рівень «мінус 400 ₴/міс» безглуздий і тягнув би burn
    // униз, тож підлога 0.
    const level = Math.max(0, fixed ? Math.round(recentNz.reduce((s, v) => s + v, 0) / recentNz.length) : mean);
    out.set(id, { level, mean, last, active_months: activeMonths, cv: Math.round(cvOf(series.filter((v) => v > 0)) * 100) / 100, fixed });
  }

  // §A1: коригування рівня ПІДТВЕРДЖЕНИМИ фактами (шар фактів). Тут — ЄДИНЕ місце,
  // де факт рухає число (не в ендпоінті), тож burn/runway/Патерни/чат лишаються узгодженими.
  // Лише confirmed_at IS NOT NULL і активний на `now`. multiplier масштабує рівень
  // (метро 8→30 = ×3.75), delta_minor додає копійки/міс (±). Обидва — в ₴-мінор, як level.
  await applyFactAdjustments(env, out, now);
  return out;
}

async function applyFactAdjustments(env: Env, out: Map<number, MonthLevel>, now: number): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT category_id AS id, adjust_kind AS kind, adjust_value AS val
       FROM facts
       WHERE confirmed_at IS NOT NULL AND category_id IS NOT NULL
         AND adjust_kind IS NOT NULL AND adjust_value IS NOT NULL
         AND effective_from <= ? AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(now, now).all<{ id: number; kind: string; val: number }>();
    for (const f of rows.results ?? []) {
      const cur = out.get(f.id);
      if (f.kind === "multiplier") {
        if (cur) cur.level = Math.round(cur.level * f.val); // 0×val=0 → категорію без історії не чіпаємо
      } else if (f.kind === "delta_minor") {
        if (cur) cur.level = Math.round(cur.level + f.val);
        else if (f.val > 0) out.set(f.id, { level: Math.round(f.val), mean: 0, last: 0, active_months: 0, cv: 0, fixed: false });
      }
    }
  } catch {
    // Таблиця facts може ще не бути на remote (міграція 0020) — не валимо канонічну статистику.
  }
}

// Канонічний МІСЯЧНИЙ BURN (₴-мінор) = сума місячних рівнів усіх категорій (ЄДИНЕ джерело).
// Замінив «витрати_90д ÷ 3» у пораднику/бюджетах: узгоджено з Патернами (`usual`) й уникає
// роздування разовими лумпами (податок/лікар) — рівень категорії їх усереднює/виключає.
// Runway = ліквідна подушка ÷ цей burn. Бере готову мапу categoryMonthlyLevels (без зайвого запиту).
export function sumLevels(levels: Map<number, MonthLevel>): number {
  let s = 0;
  for (const v of levels.values()) s += v.level;
  return s;
}

// ---- Бюджети-конверти: скільки з ліміту зʼїдено (ЄДИНЕ джерело) --------------
//
// Існує, бо цю саму пару «ліміт ↔ витрачено» рахували у ДВОХ місцях: стрічка сповіщень
// (`notify.draftBudgets`) — канонічно, а тижневий TG-пуш (`proactive.overBudget`) — власним
// SQL `t.hold = 0 AND t.is_transfer = 0 AND t.currency_code = 980`. Той другий:
//   • ігнорував спліти (`EFF_AMOUNT`) — розділена витрата рахувалась повною сумою в одну категорію;
//   • не віднімав компенсації й не враховував рефанди (§REFUND/§COMPENSATION);
//   • викидав УСІ валютні витрати замість зводити їх у ₴ (`t.currency_code = 980`);
//   • не виключав бакет 13 і не робив рол-ап по РЕАЛЬНІЙ категорії зняття.
// Тобто Telegram казав про той самий бюджет інше число, ніж застосунок. Тепер обидва шляхи
// викликають цю функцію — розійтись більше нема де.
export interface BudgetStatus {
  id: number;
  name: string;
  /** ліміт місяця, ₴-мінор */
  amount: number;
  /** витрачено з початку місяця, ₴-мінор (канон) */
  spent: number;
  /** spent / amount; ≥1 = перевитрата */
  ratio: number;
}

export async function budgetStatus(
  env: Env, mult: string, now = Math.floor(Date.now() / 1000),
): Promise<BudgetStatus[]> {
  const monthStart = localMonthStart(now);

  const [budgets, spend] = await Promise.all([
    env.DB.prepare(
      `SELECT b.category_id AS id, b.amount AS amount, c.name AS name
       FROM budgets b JOIN categories c ON c.id = b.category_id
       WHERE b.period = 'month' AND b.amount > 0`,
    ).all<{ id: number; amount: number; name: string }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart, now).all<{ id: number | null; spent: number }>(),
  ]);

  const spentByCat = new Map<number, number>();
  for (const r of spend.results ?? []) if (r.id != null) spentByCat.set(r.id, r.spent);

  return (budgets.results ?? []).map((b) => {
    const spent = spentByCat.get(b.id) ?? 0;
    return { id: b.id, name: b.name, amount: b.amount, spent, ratio: spent / b.amount };
  });
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
export type PeriodMode = "calendar" | "rolling";
export type Preset = "week" | "month" | "quarter" | "year";

export interface Bounds { from: number; to: number; prevFrom: number; prevTo: number; bucket: "day" | "week" | "month" }

const DAY = 86400;

// ---- Календар рахується в ЛОКАЛЬНІЙ таймзоні, не в UTC ----------------------
//
// Баг, через який це існує (знайдено 2026-08-01 на реальних даних): о 02:46 1 серпня в Києві
// Статистика показувала ЛИПЕНЬ, який би тип періоду не вибрати. Причина — рантайм воркера живе
// в UTC, а `new Date(x).getMonth()/getDate()/getDay()` віддають частини дати саме в зоні
// рантайму. 1 серпня 02:46 у Києві — це ще 31 липня 23:46 в UTC, тож «цей місяць» чесно
// обчислювався як липень. Щоночі з 00:00 до 03:00 застосунок був на добу позаду, і виглядало
// це як «статистика зламалась», а не як «межа періоду в іншій зоні».
//
// ⚠️ Ніколи не бери частини дати з `new Date(...).getMonth()` тощо для меж періоду — тільки
// через хелпери нижче. `Date.UTC` усередині них — це чиста календарна арифметика над уже
// локальними Y/M/D, а не повернення до UTC.
export const APP_TZ = "Europe/Kyiv";

const TZ_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** Частини локальної дати для unix-секунд. */
export function localParts(unix: number): LocalParts {
  const p: Record<string, string> = {};
  for (const part of TZ_FMT.formatToParts(unix * 1000)) p[part.type] = part.value;
  // Деякі версії ICU віддають опівніч як "24" — інакше доба з'їжджала б на добу.
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour! % 24, mm: +p.minute!, ss: +p.second! };
}

/**
 * Unix-секунди локальної півночі заданої локальної дати (місяць/день можуть виходити за межі —
 * `Date.UTC` нормалізує, тож `localMidnight(2026, 0, 1)` = 1 грудня 2025).
 *
 * Дві ітерації, а не одна: щоб дізнатись зсув зони, треба вже мати момент часу, а щоб мати
 * момент — треба зсув. Перший прохід дає зсув «приблизно там», другий сходиться. На переході
 * літнього часу це і розв'язує ±1 год неоднозначність.
 */
export function localMidnight(y: number, m: number, d: number): number {
  const wanted = Math.floor(Date.UTC(y, m - 1, d) / 1000);
  let ts = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(ts);
    const offset = Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000) - ts;
    const next = wanted - offset;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** Понеділок 0 … неділя 6 для ЛОКАЛЬНОЇ дати (чиста календарна арифметика). */
function dowMonday0(p: LocalParts): number {
  return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
}

/** Локальна північ дня, у якому лежить `unix` (+ зсув у днях). */
export function localDayStart(unix: number, addDays = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m, p.d + addDays);
}

/** Локальна північ ПОНЕДІЛКА ISO-тижня, у якому лежить `unix` (+ зсув у тижнях). */
export function localWeekStart(unix: number, addWeeks = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m, p.d - dowMonday0(p) + addWeeks * 7);
}

/** Локальна північ 1-го числа місяця, у якому лежить `unix` (+ зсув у місяцях). */
export function localMonthStart(unix: number, addMonths = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m + addMonths, 1);
}

/** Локальна північ 1-го числа кварталу (+ зсув у кварталах). */
export function localQuarterStart(unix: number, addQuarters = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, Math.floor((p.m - 1) / 3) * 3 + 1 + addQuarters * 3, 1);
}

/** Локальна північ 1 січня (+ зсув у роках). */
export function localYearStart(unix: number, addYears = 0): number {
  return localMidnight(localParts(unix).y + addYears, 1, 1);
}

/** `YYYY-MM` локального місяця — для ключів, які треба зіставляти з місячними рядами. */
export function localYm(unix: number): string {
  const p = localParts(unix);
  return `${p.y}-${String(p.m).padStart(2, "0")}`;
}

/** Наскільки зона попереду UTC у цей момент, у секундах (+7200 узимку, +10800 влітку). */
export function tzOffsetSec(unix: number): number {
  const p = localParts(unix);
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000) - unix;
}

/**
 * `strftime('%Y-%m')` у ЛОКАЛЬНІЙ зоні. Потрібне скрізь, де ключі місяців будуються в JS
 * (`localYm`), а групування — в SQL: інакше два боки одного зіставлення жили б у різних зонах.
 *
 * ⚠️ Свідоме спрощення: береться зсув на момент запиту й застосовується до всього вікна. У
 * SQLite немає бази таймзон, тож рядок з іншого боку переходу на літній час може потрапити не
 * в свій місяць — але лише якщо його час припадає на одногодинну смугу біля межі місяця.
 * Було гірше: розбіжність дорівнювала повному зсуву зони (2-3 год) ЗАВЖДИ.
 */
export function localYmSql(now: number, col = "t.time"): string {
  return `strftime('%Y-%m', ${col} + ${tzOffsetSec(now)}, 'unixepoch')`;
}

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
