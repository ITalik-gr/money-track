// Money Track Worker: serves the API/webhook/ingest and falls back to the SPA assets.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "./env.ts";
import { auth } from "./routes/auth.ts";
import { admin } from "./routes/admin.ts";
import { backups } from "./routes/backups.ts";
import { account } from "./routes/account.ts";
import {
  SESSION_COOKIE, CLEAR_COOKIE_OPTS, verifySession, verifyWebhookToken,
  DEMO_COOKIE, createDemoToken, verifyDemoToken, newDemoId, timingSafeEqual,
} from "./lib/platform/auth.ts";
import { withUserHeader } from "./lib/platform/forward.ts";
import { ensureOwner, findUserById, registerDemoSession } from "./lib/platform/directory.ts";

// Resolve who a request belongs to: a real signed-in user, or an ephemeral demo sandbox. Demo
// objects live under a `demo:`-prefixed DO name, physically disjoint from real users (bare hex),
// so the two cookie types can never cross-resolve. A real session wins if both are present.
async function resolveRequestUser(env: Env, cookieHeader: {
  session: string | undefined; demo: string | undefined;
}): Promise<{ userId: string; isDemo: boolean; tokenVersion: number } | null> {
  const sess = await verifySession(env, cookieHeader.session);
  // ⚠️ A verified signature is not yet an admitted user: `tokenVersion` still has to match the
  // directory (see `userAccess`). Resolving and admitting are separate on purpose — a demo
  // sandbox has no directory row at all, so it can never carry a real generation number.
  if (sess) return { userId: sess.userId, isDemo: false, tokenVersion: sess.tokenVersion };
  const demoId = await verifyDemoToken(env, cookieHeader.demo);
  if (demoId) return { userId: `demo:${demoId}`, isDemo: true, tokenVersion: 0 };
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
interface Access { ok: boolean; isOwner: boolean; tokenVersion: number }
const accessCache = new Map<string, Access & { at: number }>();
async function userAccess(env: Env, userId: string): Promise<Access> {
  const hit = accessCache.get(userId);
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return { ok: hit.ok, isOwner: hit.isOwner, tokenVersion: hit.tokenVersion };
  const user = await findUserById(env.DIRECTORY, userId);
  const val: Access = {
    ok: !!user && user.status !== "disabled",
    isOwner: user?.is_owner === 1,
    // Generation the user's cookies must carry to still count (migration 0005).
    tokenVersion: user?.token_version ?? 0,
  };
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
  setCookie(c, SESSION_COOKIE, "", CLEAR_COOKIE_OPTS);
  setCookie(c, DEMO_COOKIE, "", { ...CLEAR_COOKIE_OPTS, httpOnly: true });
  return c.json({ ok: true });
});

// ---- demo sandbox entry (P4.2, PLATFORM.md §11) -----------------------------
// Open by design — no invite, no key: a stranger clicks "Try the demo" and gets their OWN
// ephemeral Durable Object, seeded with the fixed dataset and armed to self-destruct in 24h.
// Two tabs = two independent sandboxes (two random ids). A returning valid cookie reuses its own.
//
// Two response shapes, one route (B1). Seeding ~350 transactions takes seconds, and as a plain
// navigation that time is a blank white page — the visitor's very first impression is a browser
// that looks hung. So the landing calls `?json=1` from a click handler, keeps its own progress
// state, and navigates itself once the sandbox exists. The redirect form stays the default and
// still works without JS (and is what a shared `/demo` link hits directly).
app.get("/demo", async (c) => {
  const wantsJson = c.req.query("json") === "1";
  const done = (status: 200 | 429 | 503, body: Record<string, unknown>, headers?: Record<string, string>) =>
    wantsJson ? c.json(body, status, headers) : c.redirect("/", 302);

  const existing = await verifyDemoToken(c.env, getCookie(c, DEMO_COOKIE));
  if (existing) return done(200, { ok: true, reused: true });

  // Creating a sandbox is unauthenticated and writes a seeded Durable Object, so it needs its
  // own daily ceiling — see `demoSandboxAllowed`. Checked BEFORE the object is created.
  const { demoSandboxAllowed } = await import("./lib/platform/demo.ts");
  if (!(await demoSandboxAllowed(c.env))) {
    // `reason` is what the client branches on; `error` carries the human text for the plain
    // navigation case and for any client that doesn't know the reason codes.
    const msg = "The demo has reached today's limit of new sandboxes. Please try again tomorrow.";
    if (wantsJson) return c.json({ error: msg, reason: "daily_limit" }, 429, { "retry-after": "3600" });
    return c.text(msg, 429, { "retry-after": "3600" });
  }

  const demoId = newDemoId();
  const nowSec = Math.floor(Date.now() / 1000);
  const stub = c.env.USER_DO.get(c.env.USER_DO.idFromName(`demo:${demoId}`));
  try {
    // The object cannot derive its own name (`idFromName` is one-way), so it is told: the alarm
    // needs it to identify itself as a demo when no request is there to say so.
    await stub.seedDemo(nowSec, `demo:${demoId}`);
  } catch (e) {
    // Seeding is the one slow, failure-prone step. Report it as such instead of letting it
    // surface as an empty 500 — a visitor who gets a blank page reads it as "the app is broken",
    // which is exactly the conclusion the demo exists to prevent.
    console.error("[demo] seed failed:", e instanceof Error ? e.message : e);
    const msg = "Could not prepare the demo sandbox. Please try again.";
    if (wantsJson) return c.json({ error: msg, reason: "seed_failed" }, 503);
    return c.text(msg, 503);
  }

  // Register for the daily orphan sweep (backstop for sandboxes whose 24h alarm never fires after
  // an eviction). Best-effort: if the directory table isn't migrated yet, the alarm still cleans
  // up the common case, so a missing registry must not break the demo entry.
  try {
    await registerDemoSession(c.env.DIRECTORY, demoId, nowSec + 24 * 60 * 60);
  } catch (e) {
    console.error("[demo] registerDemoSession failed:", e instanceof Error ? e.message : e);
  }

  // One line in the daily tally (migrations-directory/0007). Here, and not at the gate above:
  // the gate counts attempts including refused ones, and it runs before the seed that can fail.
  // A visitor who never saw the demo is not a visit.
  const { recordDemoVisit } = await import("./lib/platform/feedback.ts");
  await recordDemoVisit(c.env);

  setCookie(c, DEMO_COOKIE, await createDemoToken(c.env, demoId), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24,
  });
  return done(200, { ok: true });
});

// Guard everything registered below (all of /api and /ingest). The auth + health
// routes above are already registered, so the guard never applies to them. The
// webhook stays open — it's guarded by its own secret path segment.
//
// The guard also publishes `userId` on the context: from here on, "authenticated" and
// "whose database" are the same fact, and P0.3 resolves the Durable Object from it.

/**
 * Per-user rate limit for authenticated traffic (security review tail, 2026-08-01).
 *
 * Demo sandboxes already had spend caps; real users had nothing, so one runaway `useEffect` or
 * a copied cookie in a loop could hammer the API — and on the AI paths that is a bill, not just
 * load. Two buckets, because the two costs differ by three orders of magnitude:
 *   • general `/api/*` — generous, only a brake on obvious loops;
 *   • AI endpoints — tight, because every call is money at Anthropic.
 *
 * ⚠️ Honest limits, so nobody reads this as more than it is:
 *   • the window lives in ISOLATE MEMORY, like `accessCache`. Cloudflare runs many isolates, so
 *     the effective ceiling is per-isolate, not global. That is fine for the threat this exists
 *     for (a loop, a script, an accident); a genuinely distributed flood is the WAF's job, and
 *     a WAF rule on `/api/*` is still the right ops-side complement.
 *   • counting in D1 instead would put a write in front of every request — the exact cost this
 *     whole guard is built to avoid.
 */
const RL_WINDOW_MS = 60_000;
const RL_GENERAL = 240;   // ~4 req/s sustained — far above any real screen
const RL_AI = 20;         // an AI call takes 30-60s; 20/min is already unreachable by hand
/** Paths whose cost is a model call rather than a query. */
const AI_PATHS = /^\/api\/(jobs|advisor\/(generate|chat)|reports\/generate|budgets\/(propose|chat)|transactions\/[^/]+\/chat|events\/[^/]+\/ai|ingest|enrich|receipt)/;

const rlBuckets = new Map<string, { until: number; n: number }>();
function rateLimited(key: string, cap: number): number | null {
  const now = Date.now();
  const b = rlBuckets.get(key);
  if (!b || now >= b.until) {
    rlBuckets.set(key, { until: now + RL_WINDOW_MS, n: 1 });
    // Cheap eviction: the map only grows while a window is open, and one pass on rollover keeps
    // it from accumulating entries for users who left hours ago.
    if (rlBuckets.size > 5000) for (const [k, v] of rlBuckets) if (now >= v.until) rlBuckets.delete(k);
    return null;
  }
  b.n++;
  return b.n > cap ? Math.ceil((b.until - now) / 1000) : null;
}

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
    // …nor is one from a REVOKED generation (migration 0005). This is the half that
    // `verifySession` cannot do: the signature proves the number was not tampered with, and
    // only the directory knows whether it is still the current one.
    if (resolved.tokenVersion !== access.tokenVersion) return c.json({ error: "unauthorized" }, 401);
    isOwner = access.isOwner;
    // "Last seen", for the owner's admin screen. `last_login_at` cannot answer it: a 30-day
    // session means someone can use the app every day for a month without logging in again.
    // `touchSeen` no-ops unless an hour has passed, and it runs AFTER the response is sent —
    // an activity counter must never add latency to, or fail, a real request.
    c.executionCtx.waitUntil(
      import("./lib/platform/directory.ts")
        .then((m) => m.touchSeen(c.env.DIRECTORY, resolved.userId))
        .catch(() => { /* best-effort: the directory may not carry 0004 yet */ }),
    );
  }
  // Rate limit AFTER identity is settled, so the bucket is per USER rather than per IP — two
  // people behind one NAT must not throttle each other, and a signed-out request never gets here.
  const path = new URL(c.req.url).pathname;
  // Лише не-GET: `GET /api/jobs` — це поллінг чіпа (раз на 4с, поки задача йде), він нічого не
  // коштує й не має ділити стелю з самими викликами моделі.
  const ai = c.req.method !== "GET" && AI_PATHS.test(path);
  const retry = rateLimited(`${ai ? "ai" : "gen"}:${resolved.userId}`, ai ? RL_AI : RL_GENERAL);
  if (retry != null) {
    return c.json({ error: "rate_limited", detail: `too many requests, retry in ${retry}s` }, 429, {
      "retry-after": String(retry),
    });
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
  // Constant-time: `===` on a secret leaks its prefix through response timing, and this one is
  // long-lived (the bank keeps the URL for years, so there is time to measure).
  if (env.WEBHOOK_SECRET && timingSafeEqual(token, env.WEBHOOK_SECRET)) {
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

/**
 * Telegram webhook — open like the mono webhook; guarded by its own secret path segment +
 * secret-token header + a chat_id allowlist inside the object (see routes/telegram.ts).
 *
 * WHICH object it goes to is decided here, because only the Worker can address one:
 *
 *   • `/start <token>` — the §D1 linking deep link. The token is a signed user id, so the
 *     update goes to THAT user's object, which records the chat as its own. This is the only
 *     branch that runs for a chat nobody has claimed yet, and its whole security rests on the
 *     signature: no signature, no routing, and the update falls through to the owner below.
 *   • everything else — the owner's object, as before. Inbound bot COMMANDS still assume one
 *     chat, because routing them needs a chat_id → user index in the directory, and that is a
 *     separate feature. Outbound pushes are already per-user (`tgTarget`).
 *
 * The body is read here and re-sent: a Request body can only be consumed once, and the parsed
 * copy is the only way to see the token before choosing a destination.
 */
app.all("/tg/*", async (c) => {
  const ns = c.env.USER_DO;
  let raw = c.req.raw;
  let target: { id: string; isOwner: boolean } | null = null;

  if (c.req.method === "POST") {
    const body = await c.req.raw.clone().text();
    // Re-issue the request with the body we already consumed, so the object sees it untouched.
    raw = new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body });
    try {
      const update = JSON.parse(body) as { message?: { text?: string } };
      const payload = update.message?.text?.match(/^\/start\s+(\S+)/)?.[1];
      if (payload) {
        const { verifyTelegramLinkToken } = await import("./lib/platform/auth.ts");
        const userId = await verifyTelegramLinkToken(c.env, payload);
        if (userId) {
          const { isOwner } = await userAccess(c.env, userId);
          target = { id: userId, isOwner };
        }
      }
    } catch { /* not JSON, or no token — fall through to the owner */ }
  }

  if (!target) {
    const owner = await ensureOwner(c.env.DIRECTORY, c.env.OWNER_EMAIL || "owner@localhost");
    target = { id: owner.id, isOwner: true };
  }
  return ns.get(ns.idFromName(target.id)).fetch(withUserHeader(raw, target.id, target.isOwner));
});
// Owner-only whitelist management; behind the guard above, so `c.var.userId` is set.
app.route("/api/admin", admin);
// Self-service account actions (erasure). Worker-side because deleting an account spans BOTH
// databases — the user's Durable Object and the shared directory.
app.route("/api/account", account);
// Backups: Worker-side because a copy spans the user's object AND R2, and only the Worker sees
// both (same reason as `/api/account`). Registered before the catch-all forward below.
app.route("/api/backups", backups);

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

/**
 * Share-target fallback (§PUSH).
 *
 * `POST /share-receipt` is meant to be handled by the SERVICE WORKER, which parks the file and
 * redirects to `/add?shared=receipt` — a POST share target is delivered there and nowhere else.
 * This exists for the window where the SW is updating or has been unregistered: without it the
 * POST reaches the static-asset router, which answers 405, and the photo someone just shared is
 * gone with no explanation. A redirect at least lands them on the screen that takes receipts.
 */
app.post("/share-receipt", (c) => c.redirect("/add", 303));

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
            // Piggyback on the pass that already woke this object: the admin screen needs to know
            // whether an account is actually in use, and asking every object on page load would
            // get slower exactly as the number being measured grows. Best-effort — a directory
            // that will not take counters must never fail somebody's scheduled report.
            if (kind === "daily") {
              try {
                const { saveUserStats } = await import("./lib/platform/directory.ts");
                await saveUserStats(env.DIRECTORY, u.id, await stub.selfStats());
              } catch (e) {
                console.error(`[cron] stats ${u.id}:`, e instanceof Error ? e.message : e);
              }
              /**
               * The nightly copy into R2 (`lib/platform/backup.ts`).
               *
               * Here rather than inside `runCron`, because a backup needs three things and the
               * object only has one of them: the rows are in the object, but the bucket and — the
               * part that decides the key — the USER ID are the Worker's. A Durable Object cannot
               * recover its own name (`idFromName` is one-way), so a backup written from inside
               * would have to be told where to put itself anyway.
               *
               * Best-effort, and logged loudly: a bucket that will not take a copy must not stop
               * the rest of this user's scheduled work, but "backups quietly stopped" is the exact
               * failure this whole feature exists to prevent, so it cannot be silent either.
               */
              try {
                const { storeBackup } = await import("./lib/platform/backup.ts");
                const { localYmd } = await import("./lib/finance/stats.ts");
                await storeBackup(env.RECEIPTS, u.id, await stub.exportDump(), localYmd(Math.floor(Date.now() / 1000)));
              } catch (e) {
                console.error(`[cron] backup ${u.id} FAILED:`, e instanceof Error ? e.message : e);
              }
            }
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
