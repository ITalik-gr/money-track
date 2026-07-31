// One Durable Object per user: holds that user's entire finance database.
//
// WHY a DO instead of `user_id` columns (PLATFORM.md §2): isolation becomes physical rather
// than a filter every query has to remember. There is no `WHERE user_id` to forget, and the
// canonical SQL in `lib/stats.ts` — dozens of queries built on STATS_JOINS/SPEND_WHERE —
// stays byte-identical, reached through the D1-shaped facade in `lib/db-shim.ts`.
import { DurableObject } from "cloudflare:workers";
import { DoDatabase, type AppDb } from "../lib/platform/db-shim.ts";
import { runMigrations } from "./migrate.ts";
import { userApp } from "../user-app.ts";
import { getSecret } from "../lib/platform/secrets.ts";
import { OWNER_HEADER, USER_HEADER } from "../lib/platform/forward.ts";
import type { ImportReport } from "./import-legacy.ts";
import type { Env } from "../env.ts";

export class UserDO extends DurableObject<Env> {
  /** `env.DB` replacement for everything running inside this object. */
  readonly db: AppDb;
  private readonly raw: DoDatabase;
  private credentials: { MONO_TOKEN: string; ANTHROPIC_API_KEY: string } | null = null;
  /** null = not looked up yet in this isolate. See `rememberOwner`. */
  private ownerFlag: boolean | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.raw = new DoDatabase(ctx);
    this.db = this.raw;
    // Schema must exist before any request is served, and `blockConcurrencyWhile` is the
    // only thing that guarantees it: the DO can be created by a concurrent burst of
    // requests, and without the gate the second one would hit half-built tables.
    ctx.blockConcurrencyWhile(async () => {
      runMigrations(ctx.storage.sql);
    });
  }

  /**
   * Serves a forwarded API request against THIS user's database.
   *
   * The Worker authenticates, resolves `userId` and forwards the untouched Request here; the
   * application then runs with `env.DB` pointing at local SQLite, so no query crosses the
   * network. See `user-app.ts` for why the handlers live in here rather than in the Worker.
   */
  override async fetch(request: Request): Promise<Response> {
    // Hono wants an ExecutionContext; a DO has the equivalent on its state. `waitUntil` here
    // keeps the object alive until background work settles, which is what the callers assume.
    const execCtx = {
      waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    // Only the Worker can reach this object, and it overwrites both headers rather than merging
    // them, so neither the user id nor the owner flag can be spoofed by a client.
    const isOwner = request.headers.get(OWNER_HEADER) === "1";
    // Remember it: `alarm()` (the paced backfill) runs with no request and therefore no header,
    // but it needs the same credentials the request that started it had. Only this
    // Worker-authenticated path ever writes the flag.
    if (isOwner) await this.rememberOwner();
    const env = await this.appEnv(request.headers.get(USER_HEADER) ?? undefined, isOwner);
    return userApp.fetch(request, env, execCtx);
  }

  /**
   * Every binding the application expects, with the database and the credentials swapped for
   * this user's own.
   *
   * Swapping `env` rather than threading arguments through ~427 database call sites and ~40
   * API-key checks is what keeps the whole multi-user migration mechanical: not one handler
   * and not one SQL string had to be edited.
   */
  private async appEnv(userId?: string, isOwner = false): Promise<Env> {
    const creds = await this.userCredentials(isOwner);
    // Demo sandbox: run AI on the dedicated demo key (P4.3), and null out the mono token so a
    // sandbox can never reach the real bank even if a guard were ever missed (it also never has a
    // user of its own). The spend caps + forced-Haiku still apply on top (see lib/demo.ts).
    const isDemo = (userId ?? "").startsWith("demo:");
    if (isDemo && !this.env.DEMO_ANTHROPIC_KEY) {
      // Loud on purpose: without the dedicated key, strangers' demo AI is billed to the OWNER's
      // key, and the only thing between them and the invoice is lib/demo.ts's caps. The fallback
      // is kept (a demo with no AI at all shows less than the app does), but it must be visible.
      console.warn("[demo] DEMO_ANTHROPIC_KEY is not set — demo AI falls back to the platform key");
    }
    // The platform key is named explicitly here, not inherited from `creds`: a demo is never the
    // owner, so the owner-only fallback above gives it nothing. Keeping this fallback is a
    // deliberate product call — a demo with no AI shows less than the app does — and it is the
    // one place strangers can reach our billing, which is why lib/demo.ts caps it in dollars.
    const demoOverride = isDemo
      ? { ANTHROPIC_API_KEY: this.env.DEMO_ANTHROPIC_KEY || this.env.ANTHROPIC_API_KEY || "", MONO_TOKEN: "" }
      : {};
    return {
      ...this.env,
      DB: this.db,
      ...creds,
      ...demoOverride,
      USER_ID: userId,
      IS_OWNER: isOwner,
      onSecretsChanged: () => this.invalidateCredentials(),
      scheduleBackfillStep: (delayMs: number) => this.ctx.storage.setAlarm(Date.now() + delayMs),
    };
  }

  /**
   * Scheduled work for THIS user, driven by the Worker's cron fan-out (`lib/cron.ts`).
   *
   * Every branch is isolated: a thrown report generator must not stop notifications from being
   * written. That rule predates multi-user — it is why the old `scheduled()` wrapped each job
   * in its own try/catch — and the fan-out keeps it, returning the failures instead of
   * swallowing them so the cron log says which user's which job broke.
   *
   * `ratesJson` comes from the shared cache: rates are a fact about the world, so the Worker
   * fetches them once and every object copies the value into its own `app_state`.
   */
  /**
   * What this object can say about itself for the owner's admin screen (directory migration 0004).
   *
   * Volume only, never value. The owner administers accounts; they do not get to read other
   * people's money, and an RPC that returned balances would make that a one-line change away.
   * Cheap enough (three COUNTs) to run from the daily cron fan-out that already wakes the object.
   */
  async selfStats(): Promise<{ tx_count: number; accounts_count: number; has_mono_key: boolean; has_ai_key: boolean }> {
    const one = async (sql: string) => (await this.db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    return {
      tx_count: await one("SELECT COUNT(*) AS n FROM transactions"),
      accounts_count: await one("SELECT COUNT(*) AS n FROM accounts"),
      has_mono_key: (await one("SELECT COUNT(*) AS n FROM user_secrets WHERE name = 'MONO_TOKEN'")) > 0,
      has_ai_key: (await one("SELECT COUNT(*) AS n FROM user_secrets WHERE name = 'ANTHROPIC_API_KEY'")) > 0,
    };
  }

  async runCron(kind: "daily" | "weekly" | "monthly", ratesJson: string | null, isOwner = false): Promise<{ ran: string[]; failed: string[] }> {
    // `isOwner` comes from the directory row the fan-out already read — the deployment-wide
    // API keys are the owner's, so only the owner's cron may use them (see `userCredentials`).
    const env = await this.appEnv(undefined, isOwner || (await this.storedOwnerFlag()));
    const ran: string[] = [];
    const failed: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        ran.push(name);
      } catch (e) {
        failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    if (ratesJson) {
      await step("rates", async () => {
        const { setState } = await import("../lib/finance/repo.ts");
        await setState(this.db, "rates", ratesJson);
        // Snapshot the daily rate BEFORE anything reads it: the net-worth history recomputes
        // past points with the rate of their day, and one missed day is a permanent hole.
        const { snapshotRates } = await import("../lib/finance/finance.ts");
        await snapshotRates(this.db);
      });
    }

    if (kind === "daily") {
      await step("notifications", async () => {
        const { generateNotifications } = await import("../lib/messaging/notify.ts");
        await generateNotifications(env);
      });
    }

    // A report generated in THIS run must be announced in THIS run. The report crons fire at
    // 09:00 while the notification pass is the 06:00 daily one, so a freshly generated report
    // was only announced the NEXT morning — by which time the feed says "weekly report ready"
    // about a period that ended a day and a half ago, and the newest one looks missing.
    // `generateNotifications` is idempotent (UNIQUE dedup_key) and its AI branch has its own
    // once-a-day guard, so calling it a second time costs nothing.
    let reported = false;

    if (kind === "weekly") {
      if (env.ANTHROPIC_API_KEY) {
        await step("insight", async () => {
          const { buildAndStoreInsight } = await import("../lib/ai/insight.ts");
          await buildAndStoreInsight(env);
        });
        await step("weekly_report", async () => {
          const { generateAndStoreReport } = await import("../lib/ai/report.ts");
          await generateAndStoreReport(env, "week");
          reported = true;
        });
      }
      await step("tg_proactive", async () => {
        const { runWeeklyProactive } = await import("../lib/messaging/proactive.ts");
        await runWeeklyProactive(env);
      });
    }

    if (kind === "monthly" && env.ANTHROPIC_API_KEY) {
      await step("monthly_report", async () => {
        const { generateAndStoreReport } = await import("../lib/ai/report.ts");
        await generateAndStoreReport(env, "month"); // idempotent per period
        reported = true;
      });
    }

    if (reported) {
      await step("notifications", async () => {
        const { generateNotifications } = await import("../lib/messaging/notify.ts");
        await generateNotifications(env);
      });
    }

    return { ran, failed };
  }

  /**
   * Paces the ~90-day statement backfill: monobank allows one statement request per 60s.
   *
   * This is the one job that stays an alarm rather than joining the cron fan-out. It ticks
   * every minute and only for whoever is actually backfilling — as a global minute-cron it
   * would wake every user's object 1440 times a day to learn there is nothing to do.
   * The cursor lives in `app_state`, so a restart or an eviction mid-run resumes rather than
   * starting over.
   */
  /**
   * P4.2 — seed this object as an ephemeral DEMO sandbox and arm its 24h self-destruct alarm.
   *
   * Idempotent: a non-empty object is left untouched, so a returning demo cookie reuses its own
   * sandbox rather than doubling the data. The Worker addresses demo objects by the `demo:`-
   * prefixed name, which keeps them physically disjoint from real users' objects.
   */
  async seedDemo(nowSec: number): Promise<{ seeded: boolean; statements: number }> {
    const existing = await this.db.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) return { seeded: false, statements: 0 };

    const { buildDemoStatements } = await import("./demo-load.ts");
    const stmts = buildDemoStatements(nowSec);
    await this.db.batch(stmts.map((s) => this.db.prepare(s.sql).bind(...s.binds)));

    const { setState } = await import("../lib/finance/repo.ts");
    const expiresAt = nowSec + 24 * 3600;
    // The marker doubles as "this is a demo object" for `alarm()` — a real user never has it.
    await setState(this.db, "demo_expires_at", String(expiresAt));
    this.ctx.storage.setAlarm(expiresAt * 1000);
    return { seeded: true, statements: stmts.length };
  }

  override async alarm(): Promise<void> {
    // A demo sandbox's alarm is its 24h self-destruct, not a backfill tick (a demo has no mono
    // token to backfill). Distinguished by the marker `seedDemo` wrote; real users never have it.
    const { getState } = await import("../lib/finance/repo.ts");
    const demoExpires = await getState(this.db, "demo_expires_at");
    if (demoExpires != null) {
      if (Date.now() / 1000 >= Number(demoExpires)) await this.reset(); // wipe back to empty schema
      return;
    }

    const env = await this.appEnv(undefined, await this.storedOwnerFlag());
    try {
      const { stepBackfill } = await import("../lib/bank/backfill.ts");
      const res = await stepBackfill(env);
      // Reschedule while there is work left. `retry` means monobank rate-limited us, which is
      // expected pacing rather than an error — same 60s wait either way.
      if (res && !res.done) this.ctx.storage.setAlarm(Date.now() + 60_000);
    } catch {
      // Keep the chain alive: dropping the alarm on one bad step would silently abandon a
      // half-finished backfill, and nothing else would ever pick it up.
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  /**
   * This user's own monobank token and Anthropic key (PLATFORM.md §4), decrypted.
   *
   * Cached in memory for the object's lifetime: a Durable Object serves exactly one user, so
   * the values cannot change under it except through `invalidateCredentials()`, which the
   * endpoint that writes them calls. Without the cache every request would pay two AES-GCM
   * decrypts plus two queries for values that never change.
   *
   * ⚠️ The deployment-wide `MONO_TOKEN` / `ANTHROPIC_API_KEY` fallback is OWNER-ONLY (fixed
   * 2026-07-26, security review). Those secrets are the owner's personal credentials, so
   * applying them to every user was two live defects at once:
   *   - an invited user with no bank token of their own who pressed "sync accounts" would pull
   *     the OWNER'S accounts and statement into THEIR database — a cross-tenant data leak
   *     through a button in the normal UI, no attack required;
   *   - every invited user's AI ran on the owner's Anthropic key, unmetered (the spend caps in
   *     lib/demo.ts cover demo sandboxes only).
   * A non-owner with no key now simply has none: the endpoints already answer
   * "ANTHROPIC_API_KEY not set" / "MONO_TOKEN not set", which is the honest state.
   *
   * The cache is keyed on nothing, because a DO serves exactly one user and `isOwner` is a
   * property of that user — it cannot differ between two requests to the same object.
   */
  private async userCredentials(isOwner: boolean): Promise<{ MONO_TOKEN: string; ANTHROPIC_API_KEY: string }> {
    if (!this.credentials) {
      const master = this.env.SECRETS_MASTER_KEY;
      const [mono, anthropic] = await Promise.all([
        getSecret(this.db, master, "mono_token"),
        getSecret(this.db, master, "anthropic_api_key"),
      ]);
      this.credentials = {
        MONO_TOKEN: mono ?? (isOwner ? this.env.MONO_TOKEN ?? "" : ""),
        ANTHROPIC_API_KEY: anthropic ?? (isOwner ? this.env.ANTHROPIC_API_KEY ?? "" : ""),
      };
    }
    return this.credentials;
  }

  /** Drops the credential cache. Called by the endpoint that stores or clears a secret. */
  invalidateCredentials(): void {
    this.credentials = null;
  }

  /** Persist "this object belongs to the owner" so context-free entry points (`alarm`) can also
   *  decide whether the deployment-wide secrets apply. Written once, from the authenticated
   *  request path only — never from anything a client controls. */
  private async rememberOwner(): Promise<void> {
    if (this.ownerFlag === true) return; // already known in this isolate
    const { getState, setState } = await import("../lib/finance/repo.ts");
    this.ownerFlag = (await getState(this.db, "is_owner")) === "1";
    if (!this.ownerFlag) {
      await setState(this.db, "is_owner", "1");
      this.ownerFlag = true;
    }
  }

  /** Cached answer to "is this the owner's object", for the entry points without a request. */
  private async storedOwnerFlag(): Promise<boolean> {
    if (this.ownerFlag != null) return this.ownerFlag;
    const { getState } = await import("../lib/finance/repo.ts");
    this.ownerFlag = (await getState(this.db, "is_owner")) === "1";
    return this.ownerFlag;
  }

  /**
   * P0.7 — pulls the old single-user D1 into this object. Owner-only; the check lives in the
   * Worker, where the directory says who the owner is.
   *
   * `this.env.DB` is still the ORIGINAL D1 binding in here — `appEnv()` only swaps it for the
   * application. That is what makes this a local copy instead of a dump-and-upload dance.
   */
  async importLegacyData(): Promise<ImportReport> {
    const { importLegacy } = await import("./import-legacy.ts");
    return importLegacy(
      this.env.DB,
      this.db,
      (fn) => this.ctx.storage.transactionSync(fn),
      (sql, ...binds) => {
        this.ctx.storage.sql.exec(sql, ...(binds as SqlStorageValue[]));
      },
    );
  }


  /**
   * Wipes the object back to an empty schema (freshly migrated). Used by the demo lifecycle
   * (P4.2) to expire a sandbox — from the self-destruct `alarm()` and from the daily cron sweep
   * of evicted sandboxes.
   *
   * Two findings from the spike are baked in here:
   *   • the DO enforces foreign keys — `DROP TABLE categories` raised while `transactions`
   *     still referenced it — so drops run under `PRAGMA defer_foreign_keys` inside one
   *     transaction instead of requiring a topological sort of the FK graph;
   *   • `storage.deleteAll()` is NOT a usable reset here: it left the user tables in place
   *     while clearing the migration ledger, so the next run re-applied 0001 onto an
   *     existing schema ("table categories already exists").
   */
  async reset(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .toArray();
    this.ctx.storage.transactionSync(() => {
      // Deferring FK checks to commit time lets the drops happen in any order; by then no
      // table is left to violate anything.
      sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const t of tables) sql.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    });
    runMigrations(sql);
  }
}
