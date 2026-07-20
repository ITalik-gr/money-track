// Money Track Worker: serves the API/webhook/ingest and falls back to the SPA assets.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "./env.ts";
import { api } from "./routes/api.ts";
import { webhook } from "./routes/webhook.ts";
import { setup } from "./routes/setup.ts";
import { ingest } from "./routes/ingest.ts";
import { telegram } from "./routes/telegram.ts";
import { createSession, SESSION_COOKIE, verifySession } from "./lib/auth.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// ---- auth: single-password gate --------------------------------------------
app.post("/api/login", async (c) => {
  if (!c.env.APP_PASSWORD) return c.json({ error: "APP_PASSWORD not set on worker" }, 503);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || password !== c.env.APP_PASSWORD) return c.json({ error: "wrong_password" }, 401);
  setCookie(c, SESSION_COOKIE, await createSession(c.env), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const authed = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  return c.json({ authenticated: authed });
});

app.post("/api/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// Guard everything registered below (all of /api and /ingest). The auth + health
// routes above are already registered, so the guard never applies to them. The
// webhook stays open — it's guarded by its own secret path segment.
const guard = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!(await verifySession(c.env, getCookie(c, SESSION_COOKIE)))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/api/*", guard);
app.use("/ingest/*", guard);

app.route("/webhook", webhook);
// Telegram webhook — open like the mono webhook; guarded by its own secret path
// segment + secret-token header + chat_id allowlist (see routes/telegram.ts).
app.route("/tg", telegram);
app.route("/ingest", ingest);
app.route("/api/setup", setup);
app.route("/api", api);

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

  // Crons: minute-cron advances a backfill; Mon 09:00 refreshes rates + weekly
  // insight + weekly AI report; 1st 09:00 builds the monthly AI report (§Аналітика 2.0).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            const { stepBackfill } = await import("./lib/backfill.ts");
            await stepBackfill(env); // no-ops when no backfill is active
          } catch {
            /* best-effort; next minute retries */
          }
        })(),
      );
      return;
    }

    // Місячний репорт (1 число). Окремий крон — не робимо тижневих задач.
    if (event.cron === "0 9 1 * *") {
      ctx.waitUntil(
        (async () => {
          try {
            if (env.ANTHROPIC_API_KEY) {
              const { generateAndStoreReport } = await import("./lib/report.ts");
              await generateAndStoreReport(env, "month"); // ідемпотентно по періоду
            }
          } catch {
            /* report is best-effort; наступний крон повторить */
          }
        })(),
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        // Keep the FX cache fresh for the summary conversion.
        try {
          const { getCurrencyRates } = await import("./lib/mono.ts");
          const { setState } = await import("./lib/repo.ts");
          const rates = await getCurrencyRates();
          const map: Record<string, number> = {};
          for (const r of rates) {
            if (r.currencyCodeB === 980 && (r.rateSell || r.rateCross)) {
              map[String(r.currencyCodeA)] = (r.rateSell ?? r.rateCross)!;
            }
          }
          await setState(env.DB, "rates", JSON.stringify(map));
        } catch {
          /* rate refresh is best-effort */
        }
        // §6.6 weekly insight — coverage window taken from the saved setting.
        try {
          if (env.ANTHROPIC_API_KEY) {
            const { buildAndStoreInsight } = await import("./lib/insight.ts");
            await buildAndStoreInsight(env);
          }
        } catch {
          /* insight is best-effort */
        }
        // §Аналітика 2.0 — тижневий AI-репорт (за минулий повний тиждень, ідемпотентно).
        try {
          if (env.ANTHROPIC_API_KEY) {
            const { generateAndStoreReport } = await import("./lib/report.ts");
            await generateAndStoreReport(env, "week");
          }
        } catch {
          /* report is best-effort */
        }
        // TG Фаза 3: пуш тижневого інсайту + попередження про бюджети (гейт — TG-секрети).
        try {
          const { runWeeklyProactive } = await import("./lib/proactive.ts");
          await runWeeklyProactive(env);
        } catch {
          /* proactive push is best-effort */
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
