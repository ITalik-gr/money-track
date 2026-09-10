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

  /**
   * §ENRICH-GATE — hybrid AI: ask about what is genuinely unknown, and only that.
   *
   * The gate used to be `category_id IS NULL`, i.e. «did the rules file this». It let an Apple
   * subscription through as an ordinary purchase for months: MCC said «Сервіси, SaaS продукти»,
   * which is correct and complete as a category and says nothing about the charge REPEATING —
   * and `ai_recurring`, the flag the subscription icon and §SUB-DETECT read, is written by
   * enrichment alone. Pressing «Розпізнати» by hand fixed it every time, which is the app asking
   * the person to do the one part it was built to do.
   *
   * `enrichVerdict` now answers «is there anything left to learn» instead, and answers it without
   * a model: own-money movements and the everyday MCCs are skipped, a merchant already enriched
   * has its verdict COPIED, and only a genuinely new charge is paid for. See that file for why
   * each class is in the list it is in.
   *
   * Enrich holds too — вони тепер рахуються як витрата (stats.ts), тож мають мати категорію
   * одразу, а не лише після сеттлменту. Опис у hold-події вже повний.
   */
  try {
    if (c.env.ANTHROPIC_API_KEY) {
      const { gateRow, enrichVerdict, applyCarry } = await import("../lib/ai/enrich-gate.ts");
      const row = await gateRow(c.env, statementItem.id);
      const v = row ? await enrichVerdict(c.env, row) : { verdict: "skip" as const, why: "no row" };
      if (v.verdict === "ask") {
        const { enrichOne } = await import("../lib/ai/enrich.ts");
        await enrichOne(c.env, statementItem.id);
      } else if (v.verdict === "carry") {
        await applyCarry(c.env, statementItem.id, v.recurring);
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
