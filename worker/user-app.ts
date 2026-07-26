// The half of the application that reads and writes ONE user's finances.
//
// It is mounted inside that user's Durable Object, not in the Worker. That placement is the
// whole design decision of P0.3, and it is worth stating plainly:
//
//   The naive alternative is to keep every handler in the Worker and hand it a `db` object
//   that talks to the DO over RPC. It type-checks, it looks like a one-line change — and it
//   turns each `prepare().all()` into a network round-trip to whichever colo the DO lives in.
//   A single Statistics endpoint issues dozens of queries; the page would get slower by an
//   order of magnitude, and the cause would be invisible in the code.
//
// Running the handlers inside the DO instead means `env.DB` is a LOCAL synchronous SQLite
// facade (`lib/db-shim.ts`), the canonical SQL of `lib/stats.ts` is untouched, and one HTTP
// request costs exactly one hop.
//
// What stays in the Worker: anything that must work WITHOUT knowing whose data it is —
// health, login/OAuth, `/me`, the owner-only directory admin, and the static assets.
import { Hono } from "hono";
import type { Env } from "./env.ts";
import { api } from "./routes/api.ts";
import { setup } from "./routes/setup.ts";
import { ingest } from "./routes/ingest.ts";
import { credentials } from "./routes/credentials.ts";
import { importRoutes } from "./routes/import.ts";
import { webhook } from "./routes/webhook.ts";
import { telegram } from "./routes/telegram.ts";
import { checkRate, isAiPath } from "./lib/platform/ratelimit.ts";

export const userApp = new Hono<{ Bindings: Env }>();

// Demo sandbox guard (P4.2, PLATFORM.md §11.4). The object learns it is a demo from its OWN
// `demo:`-prefixed name (`env.USER_ID`), not from anything the client sends. The rule lives in
// ONE place here rather than as scattered `if (isDemo)` checks: block the writes that reach
// OUTSIDE the sandbox or touch secrets — connecting a bank, storing API keys, importing legacy
// data, owner admin — while leaving every read open so the demo's Settings page still renders.
// (AI cost caps are a separate concern handled in P4.3.)
//
// `/ingest` added 2026-07-26 after an audit: it was open to demo visitors, and it is the only
// route that writes a stranger's FILE into our R2 bucket (receipt image, no size limit) before
// any AI cap can apply. Storage abuse and hosting unknown uploads are not risks a sandbox needs
// to carry — the demo already ships pre-baked receipts to show the feature.
const DEMO_BLOCKED_PREFIXES = ["/api/credentials", "/api/setup", "/api/import", "/api/admin", "/ingest"];
userApp.use("*", async (c, next) => {
  const isDemo = (c.env.USER_ID ?? "").startsWith("demo:");
  if (isDemo && c.req.method !== "GET") {
    const path = new URL(c.req.url).pathname;
    if (DEMO_BLOCKED_PREFIXES.some((p) => path.startsWith(p))) {
      return c.json({ error: "demo_readonly", detail: "This action is disabled in the demo." }, 403);
    }
  }
  await next();
});

// Per-user request ceilings (C1). Placed here, in front of the routing table, because it must
// hold for every route including ones added later — a limiter opted into per-handler is a
// limiter that the next endpoint forgets.
//
// Webhook and Telegram callbacks are exempt: they are authenticated by a signed path segment or
// a bot secret rather than by a session, their rate is set by monobank and Telegram rather than
// by anyone we are defending against, and dropping a bank event as "too many requests" would
// silently lose a transaction — the one failure this app must never have.
userApp.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/webhook") || path.startsWith("/tg")) return next();

  const bucket = isAiPath(path) ? "ai" : "general";
  const verdict = checkRate(bucket);
  if (!verdict.ok) {
    // Same `{error, detail}` shape as every other failure, so `errText()` shows a real sentence
    // instead of "[object Object]" (CLAUDE.md §Обробка помилок).
    return c.json(
      {
        error: "rate_limited",
        detail: bucket === "ai"
          ? `Too many AI requests. Try again in ${verdict.retryAfter}s.`
          : `Too many requests. Try again in ${verdict.retryAfter}s.`,
      },
      429,
      { "retry-after": String(verdict.retryAfter) },
    );
  }
  await next();
});

// Paths are the ORIGINAL absolute ones: the Worker forwards the untouched Request, so the
// routing table in here must match what the browser asked for.
userApp.route("/api/setup", setup);
// Per-user keys live in the user's own DO, so this route can only exist in here.
userApp.route("/api/credentials", credentials);
// CSV statement import (P1.2) — needs the user's own accounts, so it lives in here too.
userApp.route("/api/import", importRoutes);
userApp.route("/ingest", ingest);
// Bank + Telegram callbacks. The Worker authenticated them (signed path segment / bot secret)
// and resolved whose data they belong to; the work itself must happen next to that data.
userApp.route("/webhook", webhook);
userApp.route("/tg", telegram);
userApp.route("/api", api);

userApp.all("*", (c) => c.json({ error: "not_found", detail: new URL(c.req.url).pathname }, 404));

// Same JSON error contract as the Worker (CLAUDE.md §Обробка помилок). It has to be repeated
// here rather than inherited: an uncaught throw inside the DO would otherwise surface to the
// browser as an opaque 500 with no body, which is exactly the failure mode `errText()` was
// written to end.
userApp.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[user-do] ${c.req.method} ${path} failed:`, msg, err instanceof Error ? err.stack : "");
  return c.json({ error: msg || "internal_error", detail: `${c.req.method} ${path}` }, 500);
});
