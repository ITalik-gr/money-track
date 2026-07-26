// Monobank personal API client (read-only). Base https://api.monobank.ua, auth via
// X-Token header. Rate limit: client-info & statement max 1 req / 60s — callers pace
// backfill; the webhook keeps us live so we rarely poll. Docs: api.monobank.ua/docs

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
