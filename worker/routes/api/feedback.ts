// `POST /feedback` — the way back to the developer.
//
// Open to demo visitors as well as signed-in users, deliberately: the person most likely to hit
// something confusing is the one seeing the app for the first time, and a report channel that
// only opens after you have an account collects reports from people who already got past the
// part that was broken.
//
// The row goes to the shared directory database rather than to the sender's own object — the
// owner has to be able to read it, and a demo sandbox is deleted the next day (see
// `migrations-directory/0006`).
import { apiRoutes } from "./_shared.ts";
import { st } from "../../lib/platform/i18n.ts";
import { FEEDBACK_DAILY_LIMIT, FEEDBACK_MAX_CHARS, addFeedback, feedbackToday } from "../../lib/platform/feedback.ts";
import type { FeedbackContact } from "../../../shared/api/feedback.ts";

export const feedback = apiRoutes();

/**
 * The address to write to when the form is not the right shape for what someone wants to say.
 *
 * Read from the deployment secret instead of shipped in the client bundle: this repository is
 * public, and an address committed to it cannot be un-committed. A deployment without
 * `OWNER_EMAIL` simply shows the form and no mail line.
 */
feedback.get("/feedback/contact", (c) =>
  c.json({ email: c.env.OWNER_EMAIL ?? null } satisfies FeedbackContact));

feedback.post("/feedback", async (c) => {
  const b = await c.req.json<{ kind?: string; message?: string; email?: string; page?: string }>()
    .catch(() => ({} as { kind?: string; message?: string; email?: string; page?: string }));
  const message = (b.message ?? "").trim();
  if (message.length < 3) return c.json({ error: st(c.get("locale"), "errFeedbackEmpty") }, 400);

  // `USER_ID` is set by the worker from the session, never by the client, so a sender cannot file
  // a report under someone else's account. A demo sandbox has one too (`demo:<random>`), but it
  // is not an account: storing it would tie the message to an object that is deleted tomorrow.
  const { isDemoEnv } = await import("../../lib/platform/demo.ts");
  const userId = isDemoEnv(c.env) ? null : (c.env.USER_ID ?? null);

  if (await feedbackToday(c.env.DIRECTORY, userId) >= FEEDBACK_DAILY_LIMIT) {
    return c.json({ error: st(c.get("locale"), "errFeedbackTooMany") }, 429);
  }

  // For a signed-in user the address comes from the DIRECTORY, not from the form: it is how the
  // owner replies, and a typo (or someone else's address) in that field would send the answer to
  // the wrong person. A demo visitor has no directory row, so there the typed value is all there is.
  let email: string | null = null;
  if (userId) {
    const { findUserById } = await import("../../lib/platform/directory.ts");
    email = (await findUserById(c.env.DIRECTORY, userId))?.email ?? null;
  } else {
    const typed = (b.email ?? "").trim().slice(0, 200);
    email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed) ? typed : null;
  }

  await addFeedback(c.env.DIRECTORY, {
    userId,
    email,
    kind: b.kind ?? "other",
    message: message.slice(0, FEEDBACK_MAX_CHARS),
    page: b.page ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });

  return c.json({ ok: true });
});
