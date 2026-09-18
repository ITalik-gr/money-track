// §QUICK-ADD — one operation from an iPhone shortcut (Wallet automation, a home-screen button, Siri).
//
// The shortcut sends what it has: a Wallet trigger gives an amount like «₴181.00», a merchant and a
// card name; a button or Siri gives a line like «200 кава». This scenario turns either into a
// canonical row and writes it through the ONE ingest writer, so categorisation, §RENAME-MEMORY and
// §ENRICH-GATE treat it exactly like a bank row. `createCashTx` was the other candidate and was
// rejected for that reason: it writes around the categoriser.
//
// Three decisions, each a place this could double-count:
//   • A card the BANK already syncs is refused (`synced`). A monobank card in Apple Pay fires the
//     Wallet trigger AND the webhook; the webhook may land seconds later, so a time-window dedup
//     alone would lose that race.
//   • An operation of the same signed amount already recorded within 15 minutes is a duplicate —
//     the webhook that DID land first, or the same thing typed by hand.
//   • The same shortcut firing twice within 2 minutes is one operation.
// ⚠️ What this cannot see: a CSV export imported LATER. Its rows dedup by content hash and will not
// match a shortcut row — the settings card says to point the automation only at cards that no feed
// or statement will bring in.
import type { Env } from "../env.ts";
import { parseAmountMinor } from "../lib/bank/normalize.ts";
import { CURRENCY_META, CURRENCY_NUM_BY_LETTERS } from "../../shared/currency.ts";
import { resolveBaseCurrency } from "../lib/finance/money.ts";
import { ensureCashAccount } from "../lib/finance/finance.ts";
import { upsertCanonicalTx } from "../repo/ingest.ts";
import { activeAccounts, nearbyDuplicate, type QuickAddAccount } from "../repo/quick-add.ts";
import type { QuickAddBody, QuickAddResult } from "../../shared/api/platform.ts";

const BANK_WINDOW = 15 * 60;
const REPEAT_WINDOW = 2 * 60;
const MAX_TEXT = 200;

/** «200 кава», «кава 200», «1 250,50 оренда» → amount text + the rest. */
export function splitLine(line: string): { amount: string; rest: string } | null {
  const m = /[+-]?\d[\d\s.,]*/.exec(line);
  if (!m) return null;
  const rest = (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { amount: m[0], rest };
}

/** A currency named inside the amount text («₴181.00», «EUR 12,50»), or null. */
export function currencyIn(raw: string): number | null {
  const code = /\b([A-Z]{3})\b/.exec(raw.toUpperCase())?.[1];
  if (code && CURRENCY_NUM_BY_LETTERS[code]) return CURRENCY_NUM_BY_LETTERS[code]!;
  // Longest sign first, so «zł» is not read as something shorter it contains.
  const signs = Object.entries(CURRENCY_META)
    .filter(([, m]) => m.sign)
    .sort((a, b) => b[1].sign!.length - a[1].sign!.length);
  for (const [num, m] of signs) if (raw.includes(m.sign!)) return Number(num);
  return null;
}

/** The Wallet card name against the user's account titles — loose on purpose, both directions. */
export function matchCard(card: string, accounts: QuickAddAccount[]): QuickAddAccount | null {
  const c = card.trim().toLocaleLowerCase("uk");
  if (c.length < 3) return null;
  return accounts.find((a) => {
    const t = (a.title ?? "").trim().toLocaleLowerCase("uk");
    return t.length >= 3 && (t.includes(c) || c.includes(t));
  }) ?? null;
}

export async function quickAddTx(env: Env, b: QuickAddBody, now = Math.floor(Date.now() / 1000)): Promise<QuickAddResult> {
  const line = typeof b.text === "string" ? splitLine(b.text.slice(0, MAX_TEXT)) : null;
  const amountRaw = b.amount != null ? String(b.amount) : line?.amount ?? "";
  const minor = parseAmountMinor(amountRaw);
  if (minor == null || minor === 0) return { ok: false, error: "amount_required" };
  // A shortcut reports what was PAID, as a positive number. Income is the explicit exception.
  const amount = b.income ? Math.abs(minor) : -Math.abs(minor);
  const merchant = (b.merchant ?? line?.rest ?? "").trim().slice(0, MAX_TEXT) || null;

  const accounts = await activeAccounts(env.DB);
  const card = b.card ? matchCard(b.card, accounts) : null;
  if (card && !card.is_manual) return { ok: true, status: "synced", account: card.title };

  const dup = await nearbyDuplicate(env.DB, amount, now, BANK_WINDOW, REPEAT_WINDOW);
  if (dup) return { ok: true, status: "duplicate", id: dup };

  const currency = card?.currency_code
    ?? currencyIn(amountRaw) ?? (b.currency ? CURRENCY_NUM_BY_LETTERS[b.currency.trim().toUpperCase()] : undefined)
    ?? await resolveBaseCurrency(env);
  const accountId = card?.id ?? await ensureCashAccount(env.DB, currency);
  const id = `qa_${crypto.randomUUID()}`;
  await upsertCanonicalTx(env.DB, {
    id, account_id: accountId, time: now, amount, currency_code: currency,
    description: merchant, comment: b.note?.trim().slice(0, MAX_TEXT) || null,
    // `description` in the payload is what §RENAME-MEMORY learns from, as for a bank row.
    raw: { via: "shortcut", description: merchant, card: b.card ?? null, amount: amountRaw },
  }, { source: "shortcut", onConflict: "ignore" });

  const { enrichAfterIngest } = await import("../lib/ai/enrich-gate.ts");
  await enrichAfterIngest(env, id);
  return { ok: true, status: "added", id };
}
