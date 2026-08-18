/**
 * §BASE-CUR — WHICH CURRENCY THIS ANSWER IS EXPRESSED IN. One question, one module.
 *
 * The canon already had exactly one conversion seam: every multi-currency sum passes through
 * `baseMult` in SQL or `toBaseMinor` in JS, and nothing else is allowed to multiply money by a
 * rate. That seam was pinned to the hryvnia — `WHEN 980 THEN 1.0` and `if (code === 980) return
 * amountMinor` — so "roll up to one unit" and "roll up to ₴" had become the same sentence.
 * They are not: the English UI exists for readers who hold dollars, and a screen full of ₴ told
 * them nothing about the size of anything.
 *
 * WHAT CHANGED, EXACTLY: `getRates(env)` no longer returns "₴ per unit" — it returns
 * **BASE per unit**, including an explicit entry for 980 itself. Every existing caller therefore
 * converts into the reader's currency without knowing that it does, which is the only way this
 * could be done without auditing forty call sites for the one that was forgotten. The raw stored
 * table is still reachable, under a name that says so (`getStoredRates`), and lint **C10** keeps
 * it to the two modules that legitimately need it: this one and the rate snapshotter.
 *
 * WHAT DID NOT CHANGE: storage. Amounts stay INTEGER minor units in the currency the bank
 * reported. A display setting that rewrote stored money would make the ledger unreconstructable
 * the first time a rate moved.
 *
 * ⚠️ **API fields still end in `_uah`.** The suffix is now historical and means "minor units of
 * the display base". Renaming it is not free the way a code rename is: those keys are inside
 * every report already stored in `reports.data_json`, so the rename would silently blank sections
 * of a user's saved history. Named here so the next reader does not have to guess.
 */
import type { Env } from "../../env.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { getState } from "./repo.ts";
import { asBaseCurrency, baseCurrencyForLocale, DEFAULT_BASE, type BaseCurrency } from "../../../shared/currency.ts";

// §R2-CUR2: єдине джерело правди для зведення сум у гривню. rates — мапа
// «код валюти → скільки ₴ за 1 одиницю» (див. cron/rates). Суми в мінімальних
// одиницях (копійки/центи); множення на курс дає ₴-копійки без ділення на 100.
export type Rates = Record<string, number>;

/**
 * The rate table AS STORED: ₴ per unit, exactly what the bank published (§BASE-CUR).
 *
 * Not for reading money into a screen — that is `getRates(env)` in `money.ts`, which re-expresses
 * this map in the currency the reader chose. Two legitimate callers only (lint **C10**): the
 * re-expression itself, and the snapshotter below, which must archive the published rate rather
 * than today's display choice.
 */
export async function getStoredRates(db: AppDb): Promise<Rates> {
  const raw = await db
    .prepare("SELECT value FROM app_state WHERE key = 'rates'")
    .first<{ value: string }>();
  return raw ? (JSON.parse(raw.value) as Rates) : {};
}

/**
 * Re-express a rate map (₴ per unit, as stored) in `base` units per unit.
 *
 * The output ALWAYS carries an entry for 980, which the stored map never does — that entry is
 * what lets `baseMult`/`toBaseMinor` stop special-casing the hryvnia. `base` itself maps to 1.
 *
 * ⚠️ **No rate for `base` → we stay in hryvnia.** Dividing by a missing rate gives 0 or Infinity,
 * and either one turns every number on every screen into nonsense that still renders. The caller
 * finds out which base actually applied (`resolveBaseCurrency` runs the same check), so the sign
 * printed next to the number is the sign the number is really in.
 */
export function ratesInBase(stored: Rates, base: number): Rates {
  const out: Rates = { "980": 1 };
  for (const [code, rate] of Object.entries(stored)) {
    if (Number(code) > 0 && Number.isFinite(rate) && rate > 0) out[code] = rate;
  }
  if (base === 980) return out;
  const per = out[String(base)];
  if (!Number.isFinite(per) || per <= 0) return out;   // unknown base — hryvnia, honestly
  const scaled: Rates = {};
  for (const [code, rate] of Object.entries(out)) scaled[code] = rate / per;
  scaled[String(base)] = 1;
  return scaled;
}

/**
 * Зафіксувати поточні курси за добу (крон). Ідемпотентно: повторний прогін того самого дня
 * перезаписує запис, а не плодить дублі.
 *
 * Навіщо: без історії ретроспективні перерахунки (нетворт) беруть СЬОГОДНІШНІЙ курс на
 * минулі залишки, і коливання курсу читається як рух грошей.
 */
export async function snapshotRates(db: AppDb, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const rates = await getStoredRates(db);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const entries = Object.entries(rates).filter(([code, rate]) => Number(code) > 0 && rate > 0);
  if (!entries.length) return 0;
  await db.batch(entries.map(([code, rate]) =>
    db.prepare(
      `INSERT INTO rate_history (day, code, rate, ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, code) DO UPDATE SET rate = excluded.rate, ts = excluded.ts`,
    ).bind(day, Number(code), rate, now),
  ));
  return entries.length;
}

/**
 * Курси на КОЖНУ з переданих дат. Для дати без запису бере найсвіжіший ЛІВОРУЧ (курс тримається
 * до наступної фіксації), а якщо історії ще нема зовсім — фолбек на поточні курси.
 * Повертає {день: Rates} + `covered` — чи всі дати покриті історією (для чесного caveat).
 */
export async function ratesForDays(
  db: AppDb, days: string[], base = 980,
): Promise<{ byDay: Map<string, Rates>; covered: boolean }> {
  // §BASE-CUR: each day is re-expressed with THAT DAY's rate for the base, not today's. Scaling
  // the whole series by one number would put the entire rate move of a dollar-denominated month
  // into the reader's currency as if it were a money move — the very thing `rate_history` exists
  // to stop.
  const inBase = (r: Rates) => ratesInBase(r, base);
  const current = inBase(await getStoredRates(db));
  const byDay = new Map<string, Rates>();
  if (!days.length) return { byDay, covered: true };

  // Таблиці може ще не бути на remote (міграція 0024) — тоді просто працюємо на поточних
  // курсах, як до фічі. Нова аналітика не має ламати вже робочий графік.
  let rows: { results?: { day: string; code: number; rate: number }[] };
  try {
    rows = await db.prepare(
      "SELECT day, code, rate FROM rate_history WHERE day <= ? ORDER BY day ASC",
    ).bind(days[days.length - 1]).all<{ day: string; code: number; rate: number }>();
  } catch {
    for (const day of days) byDay.set(day, current);
    return { byDay, covered: false };
  }

  // Один прохід: несемо «останній відомий курс» уперед по датах.
  const running: Rates = {};
  let i = 0;
  const hist = rows.results ?? [];
  let anyMissing = false;
  for (const day of [...days].sort()) {
    while (i < hist.length && hist[i].day <= day) {
      running[String(hist[i].code)] = hist[i].rate;
      i++;
    }
    if (!Object.keys(running).length) { byDay.set(day, current); anyMissing = true; }
    else byDay.set(day, inBase(running));
  }
  return { byDay, covered: !anyMissing };
}

/**
 * Convert a minor-unit amount in `code` into the BASE the `rates` map is expressed in (§BASE-CUR).
 * Unknown code → 0, which is how "we have no rate" has always been reported here.
 *
 * ⚠️ 980 is no longer identity: a map from `getRates(env)` carries its own entry for it (₴ are
 * worth a fraction of a dollar). The `?? 1` fallback is for the RAW stored map, which never had
 * a 980 row — that is the only case where the hryvnia is the unit by construction.
 */
export function toBaseMinor(amountMinor: number, code: number, rates: Rates): number {
  const rate = rates[String(code)] ?? (code === 980 ? 1 : 0);
  return Math.round(amountMinor * rate);
}

/** `app_state` key holding the reader's explicit choice. Empty = never chose one. */
export const BASE_CURRENCY_KEY = "display_currency";

/**
 * WHICH CURRENCY DOES THIS READER SEE — the single answer, for the whole worker.
 *
 * Reader first (`env.UI_CURRENCY`, sent as `x-mt-currency` on every request), explicit stored
 * choice second (`app_state.display_currency` — all a cron run, a Telegram push or the alarm
 * has), and the LANGUAGE last: someone who has never expressed a preference and is reading the
 * app in English is not being served by a hryvnia total. Same order, and the same reasoning, as
 * `resolveLocale` — this is the currency half of the bug §LANG-ARCH fixed for language.
 *
 * ⚠️ A base we cannot convert into is refused here, not downstream: `ratesInBase` would quietly
 * hand back hryvnia numbers while the caller kept printing "$".
 */
export async function resolveBaseCurrency(env: Env, stored?: Rates): Promise<BaseCurrency> {
  const asked = asBaseCurrency(env.UI_CURRENCY)
    ?? asBaseCurrency(await getState(env.DB, BASE_CURRENCY_KEY))
    ?? baseCurrencyForLocale(await resolveLocale(env));
  if (asked === DEFAULT_BASE) return asked;
  const rates = stored ?? await getStoredRates(env.DB);
  const per = rates[String(asked)];
  return Number.isFinite(per) && per > 0 ? asked : DEFAULT_BASE;
}

/**
 * Rates for THIS request, already expressed in the reader's base.
 *
 * Deliberately keeps the old name and the old return type: every `valueMode(rates, …)` and
 * `toBaseMinor(…, rates)` in the worker goes on working unchanged and now answers in the right
 * currency. The signature moved from `AppDb` to `Env` because the reader's header only exists
 * there — and that compile error is exactly how each call site got visited once.
 */
export async function getRates(env: Env): Promise<Rates> {
  const stored = await getStoredRates(env.DB);
  return ratesInBase(stored, await resolveBaseCurrency(env, stored));
}

/** Rates AND the base they are in, for the handful of callers that must print a symbol. */
export async function moneyScope(env: Env): Promise<{ base: BaseCurrency; rates: Rates }> {
  const stored = await getStoredRates(env.DB);
  const base = await resolveBaseCurrency(env, stored);
  return { base, rates: ratesInBase(stored, base) };
}

/**
 * AMOUNTS THE USER TYPED, WHICH ARE STORED IN HRYVNIA.
 *
 * A budget limit, a goal target, an event budget and a fact's `delta_minor` have no currency
 * column — they were written when ₴ was the only unit there was, and giving each of them one is a
 * migration per feature for a number that is not a bank record. So the STORAGE stays hryvnia and
 * the display converts, exactly like a transaction in dollars does.
 *
 * ⚠️ **Named cost:** a limit typed as $200 is stored as its hryvnia equivalent, so next month it
 * reads as $198. That is the honest consequence of a hryvnia-denominated plan being read in
 * another currency, and it is smaller than the alternative — a limit compared against spending
 * measured in a different unit, which is not a rounding error but a wrong answer.
 */
export function uahToBase(rates: Rates): number {
  const f = rates["980"];
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/** The inverse, for writes: the client sends base minor units, storage wants hryvnia. */
export function baseToUah(minorInBase: number, rates: Rates): number {
  return Math.round(minorInBase / uahToBase(rates));
}

/** …and the read direction, for a single value. */
export function uahToBaseMinor(minorInUah: number, rates: Rates): number {
  return Math.round(minorInUah * uahToBase(rates));
}

/**
 * SQL multiplier pinned to the HRYVNIA, for sums that are being STORED rather than shown
 * (`budget_months.spent_minor`). A stored number must not depend on which currency the reader
 * happened to have selected the day the cron closed the month — that is a history whose unit
 * changes under it.
 */
export async function hryvniaMult(env: Env, col?: string): Promise<string> {
  const { baseMult } = await import("./stats.ts");
  return baseMult(await getStoredRates(env.DB), col);
}

/** Persist an explicit choice. `null` clears it, putting the reader back on the language default. */
export async function setBaseCurrency(db: AppDb, base: BaseCurrency | null): Promise<void> {
  const { setState } = await import("./repo.ts");
  await setState(db, BASE_CURRENCY_KEY, base == null ? "" : String(base));
}
