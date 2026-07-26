// Money Track Worker: serves the API/webhook/ingest and falls back to the SPA assets.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "./env.ts";
import { auth } from "./routes/auth.ts";
import { admin } from "./routes/admin.ts";
import {
  SESSION_COOKIE, verifySession, verifyWebhookToken,
  DEMO_COOKIE, createDemoToken, verifyDemoToken, newDemoId,
} from "./lib/platform/auth.ts";
import { withUserHeader } from "./lib/platform/forward.ts";
import { ensureOwner, findUserById, registerDemoSession } from "./lib/platform/directory.ts";

// Resolve who a request belongs to: a real signed-in user, or an ephemeral demo sandbox. Demo
// objects live under a `demo:`-prefixed DO name, physically disjoint from real users (bare hex),
// so the two cookie types can never cross-resolve. A real session wins if both are present.
async function resolveRequestUser(env: Env, cookieHeader: {
  session: string | undefined; demo: string | undefined;
}): Promise<{ userId: string; isDemo: boolean } | null> {
  const sess = await verifySession(env, cookieHeader.session);
  if (sess) return { userId: sess, isDemo: false };
  const demoId = await verifyDemoToken(env, cookieHeader.demo);
  if (demoId) return { userId: `demo:${demoId}`, isDemo: true };
  return null;
}

// Directory facts the request path needs on EVERY call: is this account still allowed in, and is
// it the owner (see `UserDO.userCredentials` — the deployment-wide API keys are the owner's).
//
// Cached per isolate for a minute rather than read per request. A signed cookie alone used to be
// enough to pass the guard, which meant `status='disabled'` did nothing for the 30-day life of
// the cookie: the UI signed the user out (`/api/me` does check) while the API kept serving them.
// A 60s window between "disable" and "locked out" is the price of not putting a D1 read in front
// of every single API call; an outright revocation still needs the cookie to expire, which is the
// known trade-off of stateless sessions.
const ACCESS_TTL_MS = 60_000;
const accessCache = new Map<string, { at: number; ok: boolean; isOwner: boolean }>();
async function userAccess(env: Env, userId: string): Promise<{ ok: boolean; isOwner: boolean }> {
  const hit = accessCache.get(userId);
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return { ok: hit.ok, isOwner: hit.isOwner };
  const user = await findUserById(env.DIRECTORY, userId);
  const val = { ok: !!user && user.status !== "disabled", isOwner: user?.is_owner === 1 };
  accessCache.set(userId, { at: Date.now(), ...val });
  return val;
}

// One Durable Object per user (PLATFORM.md §2). Must be exported from the worker entry for
// the runtime to find the class named in wrangler.jsonc.
export { UserDO } from "./do/UserDO.ts";

const app = new Hono<{ Bindings: Env }>();

// ---- security response headers (added 2026-07-26, security review) ----------------------
//
// The app had none. It renders model-authored text and bank data in the same document as a
// session cookie, so the two that matter most are:
//   - `frame-ancestors 'none'` — nothing may embed this page, which is what makes clickjacking
//     ("click here" over an invisible Money Track button) impossible;
//   - a real CSP — even if a future component ever renders unescaped HTML, an injected script
//     has no origin it is allowed to run from and nowhere to send what it stole.
//
// `script-src 'self'` with NO 'unsafe-inline' is only viable because the one inline script
// (theme-before-paint) moved to `/theme.js`. Keep it that way: adding an inline <script> back
// silently breaks the page under this policy.
// `style-src` does need 'unsafe-inline' — React writes `style` attributes all over the app
// (chart geometry, bar widths), and those are inline styles as far as CSP is concerned.
// `connect-src 'self'`: the client talks to its own API only; Anthropic is called server-side.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  // Stops a response typed `text/plain` from being sniffed into script/HTML.
  "x-content-type-options": "nosniff",
  // Legacy twin of frame-ancestors, for anything that predates CSP level 2.
  "x-frame-options": "DENY",
  // Full URLs of an app whose paths carry transaction ids are nobody else's business.
  "referrer-policy": "strict-origin-when-cross-origin",
  // Features this app never uses. Camera is deliberately NOT blocked: the receipt input uses
  // `capture`, and browsers that gate that on Permissions-Policy would break photo upload.
  "permissions-policy": "geolocation=(), microphone=(), payment=(), usb=()",
};

// Applied to EVERY response, including the API and the DO's, so a JSON endpoint opened
// directly in a tab is covered by the same rules as the app shell.
app.use("*", async (c, next) => {
  await next();
  // `ASSETS.fetch` returns an immutable response; `c.res = new Response(...)` is how Hono
  // hands back a copy whose headers can be written.
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  // CSP is skipped on localhost: `npm run dev` serves Vite's own inline preamble and HMR client,
  // which `script-src 'self'` would block — the dev server would come up blank and the cause
  // would look like a build error. The header still ships everywhere that is not localhost,
  // which is every deployed environment.
  const host = new URL(c.req.url).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    res.headers.delete("content-security-policy");
  }
  c.res = res;
});


app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// Google OAuth — the real door (PLATFORM.md §3). Open by design: it IS the login.
app.route("/auth", auth);

// The transitional single-password gate (`POST /api/login`) is GONE (user decision, 2026-07-26).
// Google is now the only door. Its one real job besides logging in — creating the owner row —
// moved into the OAuth callback, which seeds it for OWNER_EMAIL on first sign-in; without that
// move, removing this would have made a fresh install impossible to log into at all.
// `APP_PASSWORD` survives only as a legacy fallback signing key in lib/auth.ts.

app.get("/api/me", async (c) => {
  const resolved = await resolveRequestUser(c.env, { session: getCookie(c, SESSION_COOKIE), demo: getCookie(c, DEMO_COOKIE) });
  if (!resolved) return c.json({ authenticated: false });
  // A demo visitor has no directory row — synthesize a read-only identity so the client can show
  // the demo banner (P4.4) and hide account-bound actions.
  if (resolved.isDemo) {
    // The cookie is `demo.<id>.<exp>.<hmac>`; surface its expiry so the banner can count down.
    const exp = Number(getCookie(c, DEMO_COOKIE)?.split(".")[2] ?? 0) || null;
    return c.json({
      authenticated: true,
      demo: true,
      demo_expires_at: exp,
      user: { id: resolved.userId, email: null, name: "Demo", picture: null, is_owner: false },
    });
  }
  const userId = resolved.userId;
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
  setCookie(c, DEMO_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// ---- demo sandbox entry (P4.2, PLATFORM.md §11) -----------------------------
// Open by design — no invite, no key: a stranger clicks "Try the demo" and gets their OWN
// ephemeral Durable Object, seeded with the fixed dataset and armed to self-destruct in 24h.
// Two tabs = two independent sandboxes (two random ids). A returning valid cookie reuses its own.
app.get("/demo", async (c) => {
  const existing = await verifyDemoToken(c.env, getCookie(c, DEMO_COOKIE));
  if (existing) return c.redirect("/", 302);

  // Creating a sandbox is unauthenticated and writes a seeded Durable Object, so it needs its
  // own daily ceiling — see `demoSandboxAllowed`. Checked BEFORE the object is created.
  const { demoSandboxAllowed } = await import("./lib/platform/demo.ts");
  if (!(await demoSandboxAllowed(c.env))) {
    return c.text(
      "The demo has reached today's limit of new sandboxes. Please try again tomorrow.",
      429,
      { "retry-after": "3600" },
    );
  }

  const demoId = newDemoId();
  const nowSec = Math.floor(Date.now() / 1000);
  const stub = c.env.USER_DO.get(c.env.USER_DO.idFromName(`demo:${demoId}`));
  await stub.seedDemo(nowSec);

  // Register for the daily orphan sweep (backstop for sandboxes whose 24h alarm never fires after
  // an eviction). Best-effort: if the directory table isn't migrated yet, the alarm still cleans
  // up the common case, so a missing registry must not break the demo entry.
  try {
    await registerDemoSession(c.env.DIRECTORY, demoId, nowSec + 24 * 60 * 60);
  } catch (e) {
    console.error("[demo] registerDemoSession failed:", e instanceof Error ? e.message : e);
  }

  setCookie(c, DEMO_COOKIE, await createDemoToken(c.env, demoId), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24,
  });
  return c.redirect("/", 302);
});

// Guard everything registered below (all of /api and /ingest). The auth + health
// routes above are already registered, so the guard never applies to them. The
// webhook stays open — it's guarded by its own secret path segment.
//
// The guard also publishes `userId` on the context: from here on, "authenticated" and
// "whose database" are the same fact, and P0.3 resolves the Durable Object from it.
const guard = createMiddleware<{ Bindings: Env; Variables: { userId: string; isOwner: boolean } }>(async (c, next) => {
  const resolved = await resolveRequestUser(c.env, { session: getCookie(c, SESSION_COOKIE), demo: getCookie(c, DEMO_COOKIE) });
  if (!resolved) return c.json({ error: "unauthorized" }, 401);
  // Both real and demo users flow through the same forward path; the DO learns it is a demo from
  // its own `demo:`-prefixed name (see user-app's demo guard), so nothing extra rides along here.
  // A demo has no directory row, so the access check applies to real sessions only.
  let isOwner = false;
  if (!resolved.isDemo) {
    const access = await userAccess(c.env, resolved.userId);
    // A valid signature for a disabled or deleted account is not an authenticated request.
    if (!access.ok) return c.json({ error: "unauthorized" }, 401);
    isOwner = access.isOwner;
  }
  c.set("userId", resolved.userId);
  c.set("isOwner", isOwner);
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
  // Bank callbacks need the account's own bank credentials; only the owner may fall back to the
  // deployment-wide token, so pass the real answer rather than assuming either way.
  const { isOwner } = await userAccess(c.env, userId);
  return ns.get(ns.idFromName(userId)).fetch(withUserHeader(c.req.raw, userId, isOwner));
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
  return ns.get(ns.idFromName(owner.id)).fetch(withUserHeader(c.req.raw, owner.id, true));
});
// Owner-only whitelist management; behind the guard above, so `c.var.userId` is set.
app.route("/api/admin", admin);

// ---- everything that touches finances runs INSIDE the user's Durable Object -------------
// Registered last among the /api routes, so the Worker-local ones above (health, login,
// /me, admin) still win: Hono matches in registration order.
//
// The whole Request is forwarded untouched, and the handlers execute next to the data —
// see `user-app.ts` for why that beats handing a remote `db` proxy to a Worker-side handler.
const toUserDo = createMiddleware<{ Bindings: Env; Variables: { userId: string; isOwner: boolean } }>(async (c) => {
  const ns = c.env.USER_DO;
  const userId = c.get("userId");
  // The owner flag rides along because the deployment-wide MONO_TOKEN / ANTHROPIC_API_KEY are
  // the OWNER's personal credentials — see `UserDO.userCredentials` for what went wrong without it.
  return ns.get(ns.idFromName(userId)).fetch(withUserHeader(c.req.raw, userId, c.get("isOwner")));
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
          const { refreshSharedRates, readSharedRates } = await import("./lib/platform/cron.ts");
          await refreshSharedRates(env);
          ratesJson = await readSharedRates(env);
        } catch (e) {
          console.error("[cron] shared rates refresh failed:", e instanceof Error ? e.message : e);
          try {
            const { readSharedRates } = await import("./lib/platform/cron.ts");
            ratesJson = await readSharedRates(env); // stale beats nothing
          } catch {
            /* directory migration may not be applied yet */
          }
        }

        const { listUsers } = await import("./lib/platform/directory.ts");
        const users = (await listUsers(env.DIRECTORY)).filter((u) => u.status !== "disabled");
        for (const u of users) {
          // Sequential on purpose. With ~10-50 users this costs seconds once a day, and it
          // keeps one slow or failing object from being lost in a Promise.all rejection.
          try {
            const stub = env.USER_DO.get(env.USER_DO.idFromName(u.id));
            const res = await stub.runCron(kind, ratesJson, u.is_owner === 1);
            if (res.failed.length) console.error(`[cron] ${kind} ${u.id}:`, res.failed.join(" | "));
          } catch (e) {
            console.error(`[cron] ${kind} ${u.id} unreachable:`, e instanceof Error ? e.message : e);
          }
        }

        // Demo orphan sweep (P4.2): each demo object self-destructs on its own 24h alarm, but an
        // eviction can drop that alarm, so once a day we wipe any sandbox already past expiry.
        if (kind === "daily") {
          try {
            const { listExpiredDemoSessions, deleteDemoSession } = await import("./lib/platform/directory.ts");
            for (const demoId of await listExpiredDemoSessions(env.DIRECTORY)) {
              try {
                await env.USER_DO.get(env.USER_DO.idFromName(`demo:${demoId}`)).reset();
              } catch (e) {
                console.error(`[cron] demo wipe ${demoId} failed:`, e instanceof Error ? e.message : e);
              }
              await deleteDemoSession(env.DIRECTORY, demoId);
            }
          } catch (e) {
            console.error("[cron] demo sweep skipped:", e instanceof Error ? e.message : e);
          }
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
