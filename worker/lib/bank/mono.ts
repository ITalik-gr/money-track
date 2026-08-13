// Monobank personal API client (read-only). Base https://api.monobank.ua, auth via
// X-Token header. Rate limit: client-info & statement max 1 req / 60s — callers pace
// backfill; the webhook keeps us live so we rarely poll. Docs: api.monobank.ua/docs

import type { CanonicalTx } from "./providers/provider.ts";

const BASE = "https://api.monobank.ua";

export interface MonoAccount {
  id: string;
  balance: number; // minor units, includes credit limit for credit cards
  creditLimit: number;
  type: string; // black | white | platinum | fop | ...
  currencyCode: number;
  iban?: string;
  maskedPan?: string[];
}

export interface MonoJar {
  id: string;
  title: string;
  currencyCode: number;
  balance: number;
  goal?: number;
}

export interface MonoClientInfo {
  name: string;
  accounts: MonoAccount[];
  jars?: MonoJar[];
}

export interface MonoStatementItem {
  id: string;
  time: number;
  description: string;
  mcc: number;
  originalMcc?: number;
  amount: number;
  operationAmount?: number;
  currencyCode: number;
  commissionRate?: number;
  cashbackAmount?: number;
  balance: number;
  hold: boolean;
  comment?: string;
}

/**
 * A statement item → the canonical row (§R2-CUR1). The ONE place monobank's shape is interpreted.
 *
 * Both paths that receive monobank data — the webhook (`repo.upsertMonoTx`) and the paced
 * statement fetch (`monoProvider.statement`) — go through this. They used to be two copies of the
 * same decisions, which is precisely how a provider ends up disagreeing with itself about what a
 * number means, months later and in one currency only.
 *
 * `amount` is in the ACCOUNT's currency, so that is what `currency_code` holds; `operationAmount`
 * + `currencyCode` describe the operation's own currency and become `original_*` — but ONLY when
 * they actually differ, or every domestic purchase would carry a redundant copy of itself.
 */
export function monoToCanonical(
  item: MonoStatementItem,
  accountId: string,
  accountCurrency: number,
): CanonicalTx {
  const hasOriginal = item.operationAmount != null && item.currencyCode !== accountCurrency;
  return {
    id: item.id,
    account_id: accountId,
    time: item.time,
    amount: item.amount,
    currency_code: accountCurrency,
    original_amount: hasOriginal ? item.operationAmount! : null,
    original_currency: hasOriginal ? item.currencyCode : null,
    mcc: item.mcc ?? null,
    description: item.description ?? null,
    comment: item.comment ?? null,
    balance_after: item.balance,
    cashback: item.cashbackAmount ?? null,
    hold: item.hold,
    raw: item,
  };
}

async function monoGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { "X-Token": token } });
  if (res.status === 429) throw new MonoRateLimit();
  if (!res.ok) {
    throw new Error(`mono ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export class MonoRateLimit extends Error {
  constructor() {
    super("monobank rate limit (1 req / 60s)");
    this.name = "MonoRateLimit";
  }
}

export function getClientInfo(token: string): Promise<MonoClientInfo> {
  return monoGet<MonoClientInfo>(token, "/personal/client-info");
}

/** One request covers max ~31 days / 500 items. from,to = unix seconds. */
export function getStatement(
  token: string,
  account: string,
  from: number,
  to: number,
): Promise<MonoStatementItem[]> {
  return monoGet<MonoStatementItem[]>(
    token,
    `/personal/statement/${account}/${from}/${to}`,
  );
}

export async function setWebhook(token: string, webHookUrl: string): Promise<void> {
  const res = await fetch(`${BASE}/personal/webhook`, {
    method: "POST",
    headers: { "X-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ webHookUrl }),
  });
  if (!res.ok) throw new Error(`set webhook -> ${res.status}: ${await res.text()}`);
}

export interface MonoRate {
  currencyCodeA: number;
  currencyCodeB: number;
  date: number;
  rateSell?: number;
  rateBuy?: number;
  rateCross?: number;
}

/** Public endpoint, no token, 1 req / 60s. Cached in app_state, refreshed daily. */
export function getCurrencyRates(): Promise<MonoRate[]> {
  return fetch(`${BASE}/bank/currency`).then((r) => {
    if (!r.ok) throw new Error(`mono currency -> ${r.status}`);
    return r.json() as Promise<MonoRate[]>;
  });
}
