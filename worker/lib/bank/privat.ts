// PrivatBank AutoClient v3 client, read-only (BANKS.md §2.1). Base https://acp.privatbank.ua,
// auth via a `token` header. Docs: the "Опис API для взаємодії з серверною частиною Автоклієнта"
// document linked from api.privatbank.ua.
//
// ⚠️ **Read BANKS.md §1 before assuming this covers "PrivatBank".** It does not, and cannot:
// the personal-card API (`p24api/rest_fiz`) was closed on 18 July 2023 with no replacement, and
// AutoClient reaches the ФОП / legal-entity settlement account only. Personal Privat cards go
// through the CSV importer. The UI has to say so, or the product promises what it cannot do.
//
// ⚠️ **This code has never spoken to the real service.** It is written from the published spec,
// which is why every unexpected shape below fails LOUDLY with what was received instead of
// returning an empty list — a bank integration that answers "no transactions" when it actually
// failed is the worst possible outcome, because nothing looks wrong.
import { localParts } from "../finance/stats.ts";
import { currencyNumeric, parseAmountMinor, parseStatementDate } from "./normalize.ts";
import type { CanonicalAccount, CanonicalTx } from "./providers/provider.ts";

const BASE = "https://acp.privatbank.ua";

/** The two values Privat24 for Business shows under Автоклієнт → API. */
export interface PrivatCredential {
  /** The client identifier. Sent as `ID` (group mode); omitted when empty. */
  id?: string;
  token: string;
}

/**
 * "Come back later" in all its forms: HTTP 429, and the documented non-working `phase`.
 *
 * One class for both because the CALLER's reaction is identical — pause without losing the
 * window. Distinguishing them would only matter to a log nobody reads.
 */
export class PrivatUnavailable extends Error {
  constructor(reason: string) {
    super(`PrivatBank is not accepting requests right now (${reason})`);
    this.name = "PrivatUnavailable";
  }
}

/** One transaction, as AutoClient spells it. Only the fields we read are declared. */
export interface PrivatTransaction {
  AUT_MY_ACC?: string;
  AUT_CNTR_NAM?: string;
  AUT_CNTR_ACC?: string;
  CCY?: string;
  SUM?: string;
  SUM_E?: string;
  OSND?: string;
  REF?: string;
  REFN?: string;
  ID?: string;
  TECHNICAL_TRANSACTION_ID?: string;
  /** `D` debit / `C` credit — the SIGN lives here, not in `SUM`. */
  TRANTYPE?: string;
  /** `p` processing · `r` executed · `t` reversed · `n` rejected. */
  PR_PR?: string;
  DAT_OD?: string;
  DATE_TIME_DAT_OD_TIM_P?: string;
}

export interface PrivatBalance {
  acc?: string;
  currency?: string;
  balanceOut?: string;
  nameACC?: string;
  state?: string;
}

interface PrivatPage<T> {
  status?: string;
  exist_next_page?: boolean;
  next_page_id?: string;
  transactions?: T[];
  balances?: T[];
}

/** `DD-MM-YYYY` in Kyiv — the API takes a DATE, so the day boundary must be the local one. */
function apiDate(unix: number): string {
  const p = localParts(unix);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.d)}-${pad(p.m)}-${p.y}`;
}

async function get<T>(cred: PrivatCredential, path: string, params: Record<string, string>): Promise<PrivatPage<T>> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  // Group mode wants the client id on every request; single-client tokens do not have one, so it
  // is sent only when the user supplied it.
  if (cred.id) url.searchParams.set("ID", cred.id);

  const res = await fetch(url.toString(), {
    headers: {
      token: cred.token,
      // The API requires a User-Agent; some gateways reject the default one outright.
      "User-Agent": "money-track/1.0",
      "Content-Type": "application/json;charset=utf8",
    },
  });
  if (res.status === 429) throw new PrivatUnavailable("429");
  if (!res.ok) throw new Error(`privat ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = (await res.json()) as PrivatPage<T>;
  // A body that is not `SUCCESS` is an error even with HTTP 200 — treating it as "no rows" would
  // report an empty account to a user who has one.
  if (body.status && body.status !== "SUCCESS") {
    throw new Error(`privat ${path}: status=${body.status}`);
  }
  return body;
}

/**
 * Follows `next_page_id` to the end.
 *
 * The page cap is a safety belt, not a limit anyone should hit: a server that always answers
 * `exist_next_page: true` would otherwise spin inside a single alarm until the isolate is killed,
 * and a backfill that never returns looks exactly like one that is still working.
 */
async function allPages<T>(
  cred: PrivatCredential,
  path: string,
  params: Record<string, string>,
  key: "transactions" | "balances",
  maxPages = 40,
): Promise<T[]> {
  const out: T[] = [];
  let followId = "";
  for (let page = 0; page < maxPages; page++) {
    const body = await get<T>(cred, path, { ...params, followId });
    out.push(...((body[key] as T[] | undefined) ?? []));
    if (!body.exist_next_page || !body.next_page_id) return out;
    followId = body.next_page_id;
  }
  throw new Error(`privat ${path}: more than ${maxPages} pages — refusing to loop`);
}

/** Server phase. Anything but `WRK` means requests may fail, so we pause instead of burning them. */
export async function assertWorking(cred: PrivatCredential): Promise<void> {
  const body = (await get<never>(cred, "/api/statements/settings", {})) as { phase?: string };
  if (body.phase && body.phase !== "WRK") throw new PrivatUnavailable(`phase=${body.phase}`);
}

export function listBalances(cred: PrivatCredential, since: number): Promise<PrivatBalance[]> {
  return allPages<PrivatBalance>(
    cred, "/api/statements/balance", { startDate: apiDate(since), limit: "100" }, "balances",
  );
}

export function listTransactions(
  cred: PrivatCredential, account: string, from: number, to: number,
): Promise<PrivatTransaction[]> {
  return allPages<PrivatTransaction>(
    cred,
    "/api/statements/transactions",
    { acc: account, startDate: apiDate(from), endDate: apiDate(to), limit: "100" },
    "transactions",
  );
}

/**
 * A balance row → a canonical account.
 *
 * `null` when the row carries no account number or no readable currency: an account whose
 * currency we had to guess would price everything it holds at the wrong rate.
 */
export function privatToAccount(b: PrivatBalance): CanonicalAccount | null {
  const currency = currencyNumeric(b.currency ?? null);
  if (!b.acc || currency == null) return null;
  return {
    id: `pb_${b.acc}`,
    type: "current",
    title: b.nameACC ?? null,
    currency_code: currency,
    balance: parseAmountMinor(b.balanceOut ?? "") ?? 0,
    credit_limit: 0,
    iban: b.acc,
  };
}

/**
 * A transaction → the canonical row. The ONE place PrivatBank's shape is interpreted.
 *
 * `null` means "do not store this", and it is returned for exactly two reasons:
 *   • the row is not money that moved — `PR_PR` is `t` (reversed) or `n` (rejected). Storing them
 *     would invent spending that never happened.
 *   • it cannot be read — no identity, no amount, or no date. A row we cannot identify cannot be
 *     de-duplicated either, so it would multiply on every re-fetch.
 *
 * ⚠️ **Known gap, deliberately left:** a row already stored while `p` (processing) that LATER
 * becomes reversed stays stored. Retracting a transaction is a verb this codebase does not have —
 * the canon has no "voided" state — and inventing one blind, for a bank nobody has linked yet,
 * would be a guess baked into the money rules. It belongs with the first real ФОП account.
 */
export function privatToCanonical(
  t: PrivatTransaction,
  accountId: string,
  accountCurrency: number,
): CanonicalTx | null {
  const state = (t.PR_PR ?? "r").toLowerCase();
  if (state === "t" || state === "n") return null;

  // The docs say uniqueness is REF + REFN; `ID` is the fallback for rows that carry one instead.
  const key = t.REF && t.REFN ? `${t.REF}_${t.REFN}` : (t.ID ?? t.TECHNICAL_TRANSACTION_ID ?? "");
  if (!key) return null;

  const magnitude = parseAmountMinor(t.SUM ?? "");
  if (magnitude == null) return null;
  // ⚠️ The sign is NOT in `SUM` — it is `TRANTYPE`. Reading the amount alone turns every
  // withdrawal into income, and the totals still look plausible.
  const amount = (t.TRANTYPE ?? "").toUpperCase() === "D" ? -Math.abs(magnitude) : Math.abs(magnitude);

  const time = parseStatementDate(t.DATE_TIME_DAT_OD_TIM_P ?? "") ?? parseStatementDate(t.DAT_OD ?? "");
  if (time == null) return null;

  return {
    // Namespaced: `transactions.id` is one key space across every bank, and an unprefixed
    // reference could collide with a monobank id.
    id: `pb_${key}`,
    account_id: accountId,
    time,
    amount,
    // The statement is per account, so `CCY` is that account's currency; the fallback keeps a row
    // readable when the field is missing rather than dropping money on the floor.
    currency_code: currencyNumeric(t.CCY ?? null) ?? accountCurrency,
    mcc: null, // AutoClient carries no MCC at all — see BANKS.md §2.2 for what that costs us
    // The counterparty is the closest thing to a merchant, and `merchant` falls back to the
    // description. The payment purpose goes to the comment, where the rule engine still matches
    // it (§RULES-UI: the haystack is description + comment).
    description: t.AUT_CNTR_NAM?.trim() || t.OSND?.trim() || null,
    comment: t.OSND?.trim() || null,
    balance_after: null, // balances are a separate endpoint; the row does not carry one
    hold: state === "p",
    raw: t,
  };
}
