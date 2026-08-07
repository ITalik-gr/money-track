// Worker → Durable Object request forwarding.
//
// Lives in its own module rather than in `index.ts` because the Durable Object also needs it,
// and `index.ts` already imports the DO — putting it there would close an import cycle.

/**
 * Header that tells a Durable Object which user it is serving.
 *
 * A DO cannot recover its own name from `ctx.id` — `idFromName` is one-way — yet it needs the
 * id for anything that has to address the user from the outside, such as building this user's
 * monobank webhook URL.
 *
 * Security note: the header is SET, never merged. Whatever a client sent under this name is
 * overwritten, so only the Worker — after authenticating — gets to state who this is.
 */
export const USER_HEADER = "x-mt-user";

/**
 * Marks the request as belonging to the deployment OWNER.
 *
 * Needed because the deployment-wide `MONO_TOKEN` / `ANTHROPIC_API_KEY` secrets are the owner's
 * personal credentials, and only the owner may fall back to them (see `UserDO.appEnv`). The DO
 * cannot work this out for itself: ownership lives in the directory database, which is the
 * Worker's to read. Set — never merged — exactly like `USER_HEADER`.
 */
export const OWNER_HEADER = "x-mt-owner";

export function withUserHeader(req: Request, userId: string, isOwner = false): Request {
  const headers = new Headers(req.headers);
  headers.set(USER_HEADER, userId);
  // Always written, including the "0" case: a stale value from the client must not survive.
  headers.set(OWNER_HEADER, isOwner ? "1" : "0");
  return new Request(req, { headers });
}

/**
 * The language the READER is looking at, right now.
 *
 * Sent by the client on every API request, and unlike the two headers above it is NOT
 * authenticated — it says which language to answer in, which is the sender's own business.
 *
 * WHY A HEADER AND NOT THE STORED PREFERENCE. The server used to resolve language from
 * `app_state.locale` alone, and that column defaults to unset → Ukrainian, while the client
 * defaults to English. So every screen a stranger saw was English and every sentence the model
 * wrote back was Ukrainian — most visibly in the demo, where nothing ever writes that column.
 * The stored preference is still the fallback (cron, Telegram and the alarm have no request to
 * read a header from); it is no longer the only answer.
 */
export const LOCALE_HEADER = "x-mt-locale";

/** Narrow the header to the two locales we have, so an odd value cannot become a third one. */
export function localeFromHeader(req: Request): "uk" | "en" | undefined {
  const v = req.headers.get(LOCALE_HEADER);
  return v === "uk" || v === "en" ? v : undefined;
}
