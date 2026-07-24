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

export function withUserHeader(req: Request, userId: string): Request {
  const headers = new Headers(req.headers);
  headers.set(USER_HEADER, userId);
  return new Request(req, { headers });
}
