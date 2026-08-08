// Спільна логіка розбору чека (§6.1): зберегти оригінал у R2, розпізнати через Haiku,
// причепити до наявної mono-транзакції за сумою+датою (±2 дні) або створити готівкову.
// Викликається з HTTP-інгесту (routes/ingest.ts) і Telegram-бота (routes/telegram.ts).
import type { Env } from "../../env.ts";
// The OCR call itself now lives HERE, not in `ai.ts` (phase 5, L6). It used to sit in the
// transport file even though this feature file already existed — the anomaly that smeared one
// feature across two files and let the next person append to whichever they had open.
import { callHaikuJson } from "./json.ts";
import { buildSystemPrefix } from "./prompt.ts";
import type { AnthropicUsage } from "./cost.ts";
import { briefUsage, type AiUsageBrief } from "./cost.ts";
import { ensureCashAccount } from "../finance/finance.ts";

// 6.1 Receipt photo -> line items.
export interface ReceiptResult {
  store: string | null;
  purchased_at: string | null;
  currency: string;
  total: number;
  items: { name: string; qty: number; price: number }[];
}

export async function readReceipt(
  env: Env,
  imageBase64: string,
  mediaType: string,
): Promise<{ result: ReceiptResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "read a receipt from a photo and return JSON {store, purchased_at (ISO), currency, total, items:[{name, qty, price}]}",
  );
  return callHaikuJson<ReceiptResult>(env, system, [
    { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
    { type: "text", text: "Read this receipt. Return JSON only." },
  ]);
}

const toMinor = (major: number): number => Math.round(major * 100);

// Chunked base64 — spreading a whole image array into fromCharCode overflows the stack.
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface IngestReceiptResult {
  receiptId: number;
  transactionId: string | null;
  matched: boolean;
  result: ReceiptResult;
  usage: AiUsageBrief;
}

export async function ingestReceipt(
  env: Env, bytes: Uint8Array, mediaType: string,
): Promise<IngestReceiptResult> {
  // Namespaced per user (2026-07-26, security review). One bucket holds everyone's receipt
  // images, and nothing serves them today — but the day a "view receipt" route is added, a flat
  // key space makes "check this object belongs to the caller" an extra thing to remember, and
  // forgetting it leaks another user's receipt. With the prefix the ownership check is the path.
  // Existing objects keep their old keys; nothing reads them by pattern.
  const owner = (env.USER_ID ?? "unknown").replace(/[^a-zA-Z0-9:_-]/g, "");
  const key = `receipts/${owner}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
  await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: mediaType } });

  const base64 = toBase64(bytes);
  const { result, usage } = await readReceipt(env, base64, mediaType);
  const now = Math.floor(Date.now() / 1000);
  const purchasedAt = result.purchased_at ? Math.floor(Date.parse(result.purchased_at) / 1000) : now;
  const totalMinor = toMinor(result.total);
  const currencyCode = result.currency === "USD" ? 840 : result.currency === "EUR" ? 978 : 980;

  // Try to attach to a mono tx with matching amount within ±2 days.
  const match = await env.DB.prepare(
    `SELECT id FROM transactions WHERE source = 'mono' AND ABS(amount) = ? AND ABS(time - ?) < 172800 AND receipt_id IS NULL LIMIT 1`,
  ).bind(totalMinor, purchasedAt).first<{ id: string }>();

  const receipt = await env.DB.prepare(
    `INSERT INTO receipts (transaction_id, image_key, store, purchased_at, total, currency_code, ai_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(match?.id ?? null, key, result.store, purchasedAt, totalMinor, currencyCode, JSON.stringify(result), now).run();
  const receiptId = receipt.meta.last_row_id as number;

  for (const it of result.items) {
    await env.DB.prepare(
      `INSERT INTO receipt_items (receipt_id, name, qty, price) VALUES (?, ?, ?, ?)`,
    ).bind(receiptId, it.name, it.qty, toMinor(it.price)).run();
  }

  let txId = match?.id ?? null;
  if (match) {
    await env.DB.prepare("UPDATE transactions SET receipt_id = ? WHERE id = ?").bind(receiptId, match.id).run();
  } else {
    // No mono match -> record as cash (creating the cash account if needed).
    const accountId = await ensureCashAccount(env.DB, currencyCode);
    txId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, receipt_id, created_at)
       VALUES (?, ?, 'cash', ?, ?, ?, ?, ?, ?)`,
    ).bind(txId, accountId, purchasedAt, -totalMinor, currencyCode, result.store, receiptId, now).run();
  }

  return { receiptId, transactionId: txId, matched: !!match, result, usage: briefUsage(usage) };
}
