// Money Track Worker: serves the API/webhook/ingest and falls back to the SPA assets.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "./env.ts";
import { spike } from "./routes/spike.ts";
import { auth } from "./routes/auth.ts";
import { admin } from "./routes/admin.ts";
import { createSession, SESSION_COOKIE, verifySession, verifyWebhookToken } from "./lib/auth.ts";
import { withUserHeader } from "./lib/forward.ts";
import { ensureOwner, findUserById, touchLogin } from "./lib/directory.ts";

// One Durable Object per user (PLATFORM.md §2). Must be exported from the worker entry for
// the runtime to find the class named in wrangler.jsonc.
export { UserDO } from "./do/UserDO.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// Google OAuth — the real door (PLATFORM.md §3). Open by design: it IS the login.
app.route("/auth", auth);

// ---- auth: transitional single-password gate --------------------------------
// Kept alive on purpose through P0. Cutting it the moment OAuth exists would lock the only
// real user out of a working app the first time a Google Cloud setting is wrong — and this
// is a live personal finance tracker, not a greenfield project. It logs in as the OWNER
// user, so it goes through exactly the same session/userId path as OAuth does.
app.post("/api/login", async (c) => {
  if (!c.env.APP_PASSWORD) return c.json({ error: "APP_PASSWORD not set on worker" }, 503);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || password !== c.env.APP_PASSWORD) return c.json({ error: "wrong_password" }, 401);
  const owner = await ensureOwner(c.env.DIRECTORY, c.env.OWNER_EMAIL || "owner@localhost");
  await touchLogin(c.env.DIRECTORY, owner.id);
  setCookie(c, SESSION_COOKIE, await createSession(c.env, owner.id), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const userId = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!userId) return c.json({ authenticated: false });
  const user = await findUserById(c.env.DIRECTORY, userId);
  // A valid signature for a user that no longer exists means the row was deleted while the
  // cookie lived on. Treat it as signed out rather than half-authenticated.
  if (!user || user.status === "disabled") return c.json({ authenticated: false });
  return c.json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      is_owner: user.is_owner === 1,
    },
  });
});

app.post("/api/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// Guard everything registered below (all of /api and /ingest). The auth + health
// routes above are already registered, so the guard never applies to them. The
// webhook stays open — it's guarded by its own secret path segment.
//
// The guard also publishes `userId` on the context: from here on, "authenticated" and
// "whose database" are the same fact, and P0.3 resolves the Durable Object from it.
const guard = createMiddleware<{ Bindings: Env; Variables: { userId: string } }>(async (c, next) => {
  const userId = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.use("/api/*", guard);
app.use("/ingest/*", guard);

// ---- monobank webhook: authenticate here, execute in the user's Durable Object ----------
// Stays outside the session guard — it is called by the bank, not by a browser. Its own
// signed path segment is the credential.
//
// `WEBHOOK_SECRET` (the single-user path) is still accepted and mapped to the owner. Dropping
// it the day the per-user path shipped would silently break the URL monobank ALREADY has
// registered: events would 403 until someone thought to press "register webhook" again, and
// the transactions in between would simply never arrive.
async function webhookUserId(env: Env, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  if (env.WEBHOOK_SECRET && token === env.WEBHOOK_SECRET) {
    const owner = await ensureOwner(env.DIRECTORY, env.OWNER_EMAIL || "owner@localhost");
    return owner.id;
  }
  return verifyWebhookToken(env, token);
}

// Validation ping. Answered here, without waking the Durable Object: monobank requires a bare
// 200 and there is nothing user-specific to do.
app.get("/webhook/:token", async (c) => {
  const userId = await webhookUserId(c.env, c.req.param("token"));
  return userId ? c.text("ok", 200) : c.text("forbidden", 403);
});

app.post("/webhook/:token", async (c) => {
  const userId = await webhookUserId(c.env, c.req.param("token"));
  if (!userId) return c.text("forbidden", 403);
  const ns = c.env.USER_DO;
  return ns.get(ns.idFromName(userId)).fetch(withUserHeader(c.req.raw, userId));
});

// Telegram webhook — open like the mono webhook; guarded by its own secret path
// segment + secret-token header + chat_id allowlist (see routes/telegram.ts).
//
// Routed to the OWNER's object: the bot is configured with one global `TG_CHAT_ID`, so it can
// only ever be the owner's. Per-user bots are a separate tail (PLATFORM.md §10) — but leaving
// this on the old global D1 after P0.3 would mean the bot quietly writing into a database
// nobody reads.
app.all("/tg/*", async (c) => {
  const owner = await ensureOwner(c.env.DIRECTORY, c.env.OWNER_EMAIL || "owner@localhost");
  const ns = c.env.USER_DO;
  return ns.get(ns.idFromName(owner.id)).fetch(withUserHeader(c.req.raw, owner.id));
});
// Owner-only whitelist management; behind the guard above, so `c.var.userId` is set.
app.route("/api/admin", admin);
// P0.0 spike — temporary; removed once the DO shim conclusion lands in PLATFORM.md §10.
app.route("/api/__spike", spike);

// ---- everything that touches finances runs INSIDE the user's Durable Object -------------
// Registered last among the /api routes, so the Worker-local ones above (health, login,
// /me, admin) still win: Hono matches in registration order.
//
// The whole Request is forwarded untouched, and the handlers execute next to the data —
// see `user-app.ts` for why that beats handing a remote `db` proxy to a Worker-side handler.
const toUserDo = createMiddleware<{ Bindings: Env; Variables: { userId: string } }>(async (c) => {
  const ns = c.env.USER_DO;
  const userId = c.get("userId");
  return ns.get(ns.idFromName(userId)).fetch(withUserHeader(c.req.raw, userId));
});
app.all("/api/*", toUserDo);
app.all("/ingest/*", toUserDo);

// Everything else -> static SPA assets (index.html fallback via not_found_handling).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Глобальний обробник помилок. Без нього будь-який неспійманий throw (напр. SQL-помилка D1)
// повертав порожній 500 text/plain → клієнт показував «[object Object]». Тепер завжди JSON
// `{ error, detail }`, який `errText()` на клієнті вміє розгорнути в людський текст.
// Лише для /api та /ingest — статика має віддавати свої помилки як є.
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith("/api") && !path.startsWith("/ingest")) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${c.req.method} ${path} failed:`, msg, err instanceof Error ? err.stack : "");
  return c.json({ error: msg || "internal_error", detail: `${c.req.method} ${path}` }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Cron: fan out scheduled work to every active user's Durable Object.
   *
   * Rates are fetched ONCE here rather than inside each object — they are a fact about the
   * world, not about a person, and monobank rate-limits that endpoint hard. Every object then
   * copies the shared value into its own `app_state.rates`, so `getRates()` and the canonical
   * ₴ conversion stay exactly as they were.
   *
   * The per-minute backfill cron is gone: pacing now lives in each object's `alarm()`, which
   * only ticks for whoever is actually backfilling (see `UserDO.alarm`).
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const kind: "daily" | "weekly" | "monthly" =
      event.cron === "0 6 * * *" ? "daily" : event.cron === "0 9 1 * *" ? "monthly" : "weekly";

    ctx.waitUntil(
      (async () => {
        // Rates first: the daily snapshot feeds the net-worth history, and a missed day is a
        // permanent hole in that series — it is only ever written forward.
        let ratesJson: string | null = null;
        try {
          const { refreshSharedRates, readSharedRates } = await import("./lib/cron.ts");
          await refreshSharedRates(env);
          ratesJson = await readSharedRates(env);
        } catch (e) {
          console.error("[cron] shared rates refresh failed:", e instanceof Error ? e.message : e);
          try {
            const { readSharedRates } = await import("./lib/cron.ts");
            ratesJson = await readSharedRates(env); // stale beats nothing
          } catch {
            /* directory migration may not be applied yet */
          }
        }

        const { listUsers } = await import("./lib/directory.ts");
        const users = (await listUsers(env.DIRECTORY)).filter((u) => u.status !== "disabled");
        for (const u of users) {
          // Sequential on purpose. With ~10-50 users this costs seconds once a day, and it
          // keeps one slow or failing object from being lost in a Promise.all rejection.
          try {
            const stub = env.USER_DO.get(env.USER_DO.idFromName(u.id));
            const res = await stub.runCron(kind, ratesJson);
            if (res.failed.length) console.error(`[cron] ${kind} ${u.id}:`, res.failed.join(" | "));
          } catch (e) {
            console.error(`[cron] ${kind} ${u.id} unreachable:`, e instanceof Error ? e.message : e);
          }
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
