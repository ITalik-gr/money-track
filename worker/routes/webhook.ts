// Monobank webhook — the handler half. Runs INSIDE the user's Durable Object.
//
// Authentication happened in the Worker, which verified the signed path segment and resolved
// which user it belongs to before forwarding the request here (see `index.ts`). By the time
// this file runs, `c.env.DB` is already the right person's database, so there is nothing left
// to check: re-checking a secret here would be checking it against the wrong thing anyway,
// since the secret is per-user and this object holds no notion of "the" secret.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import type { MonoStatementItem } from "../lib/bank/mono.ts";
import { upsertMonoTx } from "../lib/finance/repo.ts";
import { applyEventBalance } from "../repo/accounts.ts";
import { enrichStatusOf } from "../repo/transactions.ts";

interface WebhookEvent {
  type: string;
  data: {
    account: string;
    statementItem: MonoStatementItem;
  };
}

export const webhook = new Hono<{ Bindings: Env }>();

// Mono validation ping — must return a bare 200. Answered by the Worker without waking the
// Durable Object; this route exists only so a stray GET here is not a 404.
webhook.get("/:token", (c) => c.text("ok", 200));

webhook.post("/:token", async (c) => {
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
  await applyEventBalance(c.env.DB, account, statementItem.balance, Math.floor(Date.now() / 1000));

  // Pair this event with its counterpart if it's an internal card-to-card transfer.
  try {
    const { detectTransfers } = await import("../lib/finance/transfers.ts");
    await detectTransfers(c.env);
  } catch {
    /* transfer detection is best-effort */
  }

  // Hybrid AI: only enrich when mcc/alias rules couldn't categorise it.
  try {
    if (c.env.ANTHROPIC_API_KEY) {
      const row = await enrichStatusOf(c.env.DB, statementItem.id);
      // Enrich holds too — вони тепер рахуються як витрата (stats.ts), тож мають мати
      // категорію одразу, а не лише після сеттлменту. Опис у hold-події вже повний.
      if (row && row.category_id == null && !row.ai_enriched) {
        const { enrichOne } = await import("../lib/ai/enrich.ts");
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
        const { maybeAlertTransaction } = await import("../lib/messaging/alert.ts");
        await maybeAlertTransaction(c.env, statementItem.id, origin);
      } catch {
        /* alert is best-effort */
      }
    })(),
  );

  return c.text("ok", 200);
});
