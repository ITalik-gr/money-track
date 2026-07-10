// Monobank webhook. Secret path segment guards against blind third-party POSTs (§9).
// Mono first does GET and requires a clean 200, then POSTs StatementItem events.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import type { MonoStatementItem } from "../lib/mono.ts";
import { upsertMonoTx } from "../lib/repo.ts";

interface WebhookEvent {
  type: string;
  data: {
    account: string;
    statementItem: MonoStatementItem;
  };
}

export const webhook = new Hono<{ Bindings: Env }>();

// Mono validation ping — must return a bare 200.
webhook.get("/:secret", (c) => {
  if (c.req.param("secret") !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  return c.text("ok", 200);
});

webhook.post("/:secret", async (c) => {
  if (c.req.param("secret") !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);

  let body: WebhookEvent;
  try {
    body = await c.req.json<WebhookEvent>();
  } catch {
    return c.text("bad json", 400);
  }

  if (body.type !== "StatementItem" || !body.data?.statementItem) {
    // Tolerate unknown event shapes; ack so mono doesn't retry forever.
    return c.text("ignored", 200);
  }

  const { account, statementItem } = body.data;
  await upsertMonoTx(c.env.DB, account, statementItem);

  // Keep the account balance fresh from the event's post-transaction balance.
  await c.env.DB.prepare(
    "UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?",
  )
    .bind(statementItem.balance, Math.floor(Date.now() / 1000), account)
    .run();

  // Pair this event with its counterpart if it's an internal card-to-card transfer.
  try {
    const { detectTransfers } = await import("../lib/transfers.ts");
    await detectTransfers(c.env);
  } catch {
    /* transfer detection is best-effort */
  }

  // Hybrid AI: only enrich when mcc/alias rules couldn't categorise it.
  try {
    if (c.env.ANTHROPIC_API_KEY) {
      const row = await c.env.DB.prepare(
        "SELECT category_id, ai_enriched, hold FROM transactions WHERE id = ?",
      ).bind(statementItem.id).first<{ category_id: number | null; ai_enriched: number; hold: number }>();
      // Enrich holds too — вони тепер рахуються як витрата (stats.ts), тож мають мати
      // категорію одразу, а не лише після сеттлменту. Опис у hold-події вже повний.
      if (row && row.category_id == null && !row.ai_enriched) {
        const { enrichOne } = await import("../lib/enrich.ts");
        await enrichOne(c.env, statementItem.id);
      }
    }
  } catch {
    /* enrichment is best-effort */
  }

  // §F2 крок 2: пер-транзакційний TG-алерт про вагому непояснену операцію / перевищений
  // бюджет. У waitUntil — щоб не тримати відповідь вебхука (Telegram/AI можуть бути повільні).
  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { maybeAlertTransaction } = await import("../lib/alert.ts");
        await maybeAlertTransaction(c.env, statementItem.id, origin);
      } catch {
        /* alert is best-effort */
      }
    })(),
  );

  return c.text("ok", 200);
});
