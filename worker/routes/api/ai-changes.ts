/**
 * `/ai-changes/*` — §AI-AUDIT: what the model changed, and putting it back.
 *
 * The app lets AI rewrite a transaction's category, its transfer flag and its understanding, from
 * three different paths. Until migration 0041 none of it left a trace: a category could disagree
 * with what the bank or the person had put there, and nothing said who decided that or what it
 * used to be. "Why is this in Entertainment" had no answer.
 *
 * ⚠️ Revert restores the OLD value and MARKS the log row rather than deleting it. "The AI did this
 * and I undid it" is a more useful fact than an empty log — and it is what stops the screen
 * offering the same undo twice.
 */
import * as auditRepo from "../../repo/ai-changes.ts";
import { apiRoutes } from "./_shared.ts";
import { st } from "../../lib/platform/i18n.ts";
import type { AiChange } from "../../../shared/api/ai.ts";

export const aiChanges = apiRoutes();

/** The recent log across every operation — for a "what has the AI been doing" view. */
aiChanges.get("/ai-changes", async (c) => {
  const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get("limit") ?? 50), 1), 200);
  return c.json(await auditRepo.recent(c.env.DB, limit) satisfies AiChange[]);
});

aiChanges.post("/ai-changes/:id/revert", async (c) => {
  const change = await auditRepo.byId(c.env.DB, Number(c.req.param("id")));
  if (!change) return c.json({ error: "not_found" }, 404);
  // Reverting twice would write a stale value over whatever the user has since chosen — the log
  // records what WAS, not what is.
  if (change.reverted_at != null) return c.json({ ok: true, already: true });
  const out = await auditRepo.revert(c.env.DB, change, Math.floor(Date.now() / 1000));
  // The field has changed hands since — most often because the person corrected it themselves.
  // Saying so is the point: a silent no-op looks like a broken button, and a silent overwrite
  // looks like nothing at all until they notice their own edit is gone.
  if (!out.ok) return c.json({ error: st(c.get("locale"), "errRevertSuperseded") }, 409);
  return c.json({ ok: true });
});
