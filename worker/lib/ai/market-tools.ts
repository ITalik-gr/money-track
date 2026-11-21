/**
 * §MARKET — live crypto quotes for the chat. Outbound data is a list of public tickers only:
 * never a quantity, a balance or anything else that says what this user holds.
 *
 * CoinGecko's keyless tier shares a small per-IP allowance, so responses are edge-cached for a
 * minute. A failure is returned as `error`, so the model says the price is unavailable instead of
 * quoting one from memory.
 */
import type { Env } from "../../env.ts";
import { getRates } from "../finance/money.ts";
import type { ChatTool } from "./ai.ts";

/**
 * The app's own rates, for the chat. Without them the model estimated a rate per answer, so one
 * dollar sum took several values across a conversation and was once read as hryvnia outright.
 */
export async function fxRatesFor(env: Env): Promise<Record<string, number>> {
  const r = await getRates(env);
  const out: Record<string, number> = {};
  for (const [code, name] of [["840", "USD"], ["978", "EUR"]]) if (r[code] > 0 && r[code] !== 1) out[name] = Math.round(r[code] * 100) / 100;
  return out;
}

const COINS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", USDC: "usd-coin", BNB: "binancecoin", SOL: "solana",
  XRP: "ripple", TON: "the-open-network", ADA: "cardano", DOGE: "dogecoin", TRX: "tron", AVAX: "avalanche-2",
  DOT: "polkadot", LINK: "chainlink", MATIC: "matic-network", POL: "polygon-ecosystem-token", LTC: "litecoin",
  ATOM: "cosmos", NEAR: "near", APT: "aptos", ARB: "arbitrum", OP: "optimism", SUI: "sui", UNI: "uniswap",
  AAVE: "aave", PEPE: "pepe", SHIB: "shiba-inu", BCH: "bitcoin-cash", XLM: "stellar", ETC: "ethereum-classic",
};

export const CRYPTO_PRICES_TOOL: ChatTool = {
  name: "get_crypto_prices",
  description: "Current USD price and 24h change for crypto tickers. Use it to value holdings the user showed or told you (quantity × price) and to check a screenshot's figures against the market. Send tickers only, never quantities.",
  input_schema: {
    type: "object",
    properties: { symbols: { type: "array", items: { type: "string" }, description: "Tickers, e.g. [\"BTC\",\"ETH\"]. Max 20." } },
    required: ["symbols"],
  },
};

export async function cryptoPrices(input: Record<string, unknown>): Promise<unknown> {
  const asked = (Array.isArray(input.symbols) ? input.symbols : [])
    .filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()).slice(0, 20);
  const known = [...new Set(asked)].filter((s) => COINS[s]);
  const unknown = asked.filter((s) => !COINS[s]);
  if (!known.length) return { error: "no supported tickers", unknown };
  const ids = known.map((s) => COINS[s]).sort().join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
  const res = await fetch(url, { headers: { accept: "application/json" }, cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) return { error: `price source answered ${res.status}; say the live price is unavailable` };
  const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number; last_updated_at?: number }>;
  return {
    currency: "USD",
    note: "Market quotes in USD, the one exception to the display-currency rule. Label them $.",
    prices: known.flatMap((symbol) => {
      const q = data[COINS[symbol]];
      if (q?.usd == null) return [];
      return [{
        symbol, price_usd: q.usd,
        change_24h_pct: q.usd_24h_change == null ? null : Math.round(q.usd_24h_change * 100) / 100,
        as_of: q.last_updated_at ? new Date(q.last_updated_at * 1000).toISOString() : null,
      }];
    }),
    ...(unknown.length ? { unknown } : {}),
  };
}
