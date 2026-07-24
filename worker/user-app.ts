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

export const userApp = new Hono<{ Bindings: Env }>();

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
