/**
 * Free text → a money record. «кава 45 аромакава», «отримав 12000 зарплата».
 *
 * Split out of `enrich.ts` on 2026-08-21 under the C3 ceiling, and the seam holds on its own:
 * enrichment READS a transaction the bank already sent and decides what it was, while this turns
 * a sentence a person typed into a transaction that does not exist yet. Different input, different
 * failure mode — a wrong enrichment mislabels a real payment, a wrong parse invents one — and only
 * this one is shown to the user for confirmation before anything is written.
 *
 * Two callers: the Telegram quick entry and `POST /ingest/text`.
 */
import type { Env } from "../../env.ts";
import { callHaikuJson } from "./json.ts";
import { buildSystemPrefix } from "./prompt.ts";
import type { AnthropicUsage } from "./cost.ts";

// 6.2 Quick text entry -> structured record.
export interface TextResult {
  merchant: string;
  amount: number;
  currency: string;
  category_guess: number | null;
  note: string | null;
  /**
   * Which DIRECTION the money moved. Added 2026-08-21 for the Telegram quick entry, which until
   * then could only ever write an expense — so «отримав 5000 за фріланс» was stored as a 5 000 ₴
   * outflow, i.e. the arithmetic inverted on the one entry a person is most pleased about.
   *
   * ⚠️ Deliberately only two values. A TRANSFER needs two accounts, and a free-text guess about
   * which two would write two rows and a pair id off a sentence like «переказав 500» — wrong in a
   * way that takes real work to undo. Absent is better than guessed there.
   */
  kind?: "expense" | "income";
}

export async function parseText(
  env: Env,
  input: string,
): Promise<{ result: TextResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "parse a quick free-text money note into JSON {merchant, amount, currency, category_guess (id or null), note, kind}. "
    + "`amount` is always POSITIVE; `kind` is \"income\" when the text says money came IN (received, salary, "
    + "refund, sold, paid me) and \"expense\" otherwise. When it is not clear, answer \"expense\" — that is "
    + "what a note about money almost always is, and the user confirms before anything is saved.",
  );
  return callHaikuJson<TextResult>(env, system, [{ type: "text", text: input }]);
}

