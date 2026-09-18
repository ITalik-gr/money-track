/**
 * §TAX-FX — the National Bank's OFFICIAL rate for a date, which is a different question from
 * «what is this worth today».
 *
 * `money.ts` owns the rates the app displays with (§BASE-CUR): a moving, roughly-right number
 * whose job is to make today's screen readable, and which is expected to change. This module owns
 * the rate the STATE computes tax with: official, tied to one calendar date, and immutable once
 * published. They are deliberately separate tables and separate modules, because sharing one would
 * mean that improving how a chart looks silently edits a filed declaration.
 *
 * Cash-basis is what makes the date matter: a ФОП's income exists on the day the money ARRIVES,
 * converted at that day's official rate — not at the invoice date, not at today's rate.
 *
 * The API is public, keyless and stable:
 *   https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=YYYYMMDD&json
 */
import type { AppDb } from "../platform/db-shim.ts";
import { localYmd } from "./time.ts";
import { currencyCode } from "../../../shared/currency.ts";

const API = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange";

/** Rates are stored ×10000: the NBU publishes four decimals, and money here is never a float. */
export const RATE_SCALE = 10_000;

export interface OfficialRate {
  /** ₴ per one unit of the currency, ×10000. */
  rate: number;
  /** The date the rate is actually FOR — earlier than the asked date over a weekend. */
  effective_date: string;
}

interface NbuRow { rate?: number; exchangedate?: string; cc?: string }

/** 'YYYY-MM-DD' → 'YYYYMMDD', the only format the NBU endpoint accepts. */
function compact(ymd: string): string {
  return ymd.replaceAll("-", "");
}

function shiftDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T12:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The official rate for one date, cached forever after the first fetch.
 *
 * ⚠️ WEEKENDS AND HOLIDAYS ARE THE NORMAL CASE, not an edge case: money lands on a Saturday all
 * the time. The NBU publishes nothing for a non-working day, and the rule is that the previous
 * published rate applies. So a miss walks BACKWARDS up to four days — long enough for a New Year
 * run of holidays — and records which date it actually landed on. Recording both dates means the
 * fallback is visible in the data rather than re-derived, differently, by the next reader.
 *
 * ⚠️ Never invents a rate. A fetch that fails returns null and the caller leaves the row without a
 * tax base, because a guessed rate in a tax figure is worse than a missing one: the first is wrong
 * and confident, the second is visibly incomplete.
 */
export async function officialRate(
  db: AppDb, code: number, ymd: string,
): Promise<OfficialRate | null> {
  const cached = await db.prepare(
    "SELECT rate, effective_date FROM nbu_rates WHERE fetched_for = ? AND currency_code = ?",
  ).bind(ymd, code).first<{ rate: number; effective_date: string }>();
  if (cached) return { rate: cached.rate, effective_date: cached.effective_date };

  // ⚠️ number → letters, and it has to be THIS helper. `CURRENCY_BY_CODE` is the reverse map
  // (letters → number) and was used here by mistake; because it is typed `Record<string, number>`,
  // indexing it with 840 compiles and simply answers `undefined`, so `officialRate` returned null
  // for EVERY foreign currency and no request was ever made. §TAX-FX looked like «the NBU has no
  // rate» — every foreign receipt stayed without a base, and «Підтягнути курси» filled nothing.
  const valcode = currencyCode(code);
  // `currencyCode` falls back to the number as a string for a code we do not carry. Asking the NBU
  // for `valcode=999` would be a request built from a guess, and §TAX-FX never guesses.
  if (!/^[A-Z]{3}$/.test(valcode)) return null;

  for (let back = 0; back <= 4; back++) {
    const ask = back === 0 ? ymd : shiftDays(ymd, -back);
    let rows: NbuRow[];
    try {
      const res = await fetch(`${API}?valcode=${valcode}&date=${compact(ask)}&json`);
      if (!res.ok) return null;
      rows = await res.json();
    } catch {
      return null; // offline or the NBU is down: the caller must see «unknown», not a made-up number
    }
    // An empty array is exactly what a non-working day returns — not an error, just no publication.
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.rate) continue;

    const rate = Math.round(row.rate * RATE_SCALE);
    const effective = row.exchangedate
      // The NBU answers with DD.MM.YYYY; normalise here so nothing downstream parses two formats.
      ? row.exchangedate.split(".").reverse().join("-")
      : ask;
    await db.prepare(
      `INSERT INTO nbu_rates (fetched_for, currency_code, rate, effective_date, fetched_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(fetched_for, currency_code) DO NOTHING`,
    ).bind(ymd, code, rate, effective, Math.floor(Date.now() / 1000)).run();
    return { rate, effective_date: effective };
  }
  return null;
}

/**
 * The hryvnia tax base for one receipt.
 *
 * Hryvnia in, hryvnia out — no rate, no fetch, no stored copy of a number we already have. That
 * shortcut is the reason `tax_base_uah` is NULL for most rows rather than a duplicate of `amount`.
 */
export async function taxBaseUah(
  db: AppDb, amountMinor: number, code: number, unixTime: number,
): Promise<number | null> {
  if (code === 980) return amountMinor;
  const r = await officialRate(db, code, localYmd(unixTime));
  if (!r) return null;
  // Minor units × scaled rate, divided back down: one integer expression, rounded once.
  return Math.round((amountMinor * r.rate) / RATE_SCALE);
}
