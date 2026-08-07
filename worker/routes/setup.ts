// Setup & sync: pull mono accounts, register the webhook, and run the paced ~90-day
// backfill (§5). Statement is limited to 1 req / 60s, so backfill is a cursor of
// (account, window) pairs stepped one request at a time; the client drives the 60s
// spacing and shows progress. Cursor lives in app_state so it survives interruption.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { MonoRateLimit } from "../lib/bank/mono.ts";
import { getState, setState } from "../lib/finance/repo.ts";
import { rowCounts } from "../repo/state.ts";
import { type Cursor, CURSOR_KEY, startBackfill, stepBackfill } from "../lib/bank/backfill.ts";

export const setup = new Hono<{ Bindings: Env }>();

setup.post("/sync-accounts", async (c) => {
  if (!c.env.MONO_TOKEN) return c.json({ error: "MONO_TOKEN not set" }, 400);
  try {
    // Through the registry rather than calling mono directly: the day a second bank exists,
    // this endpoint must not be the place that still knows one bank's name (PLATFORM.md §5).
    const { getProvider } = await import("../lib/bank/providers/index.ts");
    const provider = getProvider("mono")!;
    const res = await provider.syncAccounts!(c.env.DB, c.env.MONO_TOKEN);
    return c.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof MonoRateLimit) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
    return c.json({ error: String(e) }, 502);
  }
});

setup.post("/register-webhook", async (c) => {
  if (!c.env.MONO_TOKEN) return c.json({ error: "MONO_TOKEN not set" }, 400);
  const origin = new URL(c.req.url).origin;
  // Per-user webhook path (PLATFORM.md §5). `USER_ID` is injected by the Durable Object from
  // the header the Worker set; the fallback to the deployment-wide secret keeps this working
  // for the single-user deployment until the owner re-registers.
  const { webhookToken } = await import("../lib/platform/auth.ts");
  const segment = c.env.USER_ID
    ? await webhookToken(c.env, c.env.USER_ID)
    : c.env.WEBHOOK_SECRET;
  const url = `${origin}/webhook/${segment}`;
  try {
    const { getProvider } = await import("../lib/bank/providers/index.ts");
    await getProvider("mono")!.registerWebhook!(c.env.MONO_TOKEN, url);
    await setState(c.env.DB, "webhook_url", url);
    return c.json({ ok: true, url });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Register the Telegram webhook once: points TG at /tg/<TG_SECRET> and sets the
// secret_token so incoming updates carry X-Telegram-Bot-Api-Secret-Token = TG_SECRET.
setup.post("/register-telegram", async (c) => {
  // Owner-only: the bot is ONE global installation, so this button reconfigures a resource that
  // is not the caller's. Everything else in this file acts on the caller's own bank credentials.
  if (!c.env.IS_OWNER) return c.json({ error: "owner_only" }, 403);
  if (!c.env.TG_BOT_TOKEN || !c.env.TG_SECRET) return c.json({ error: "TG_BOT_TOKEN / TG_SECRET not set" }, 400);
  const { setWebhook } = await import("../lib/messaging/telegram.ts");
  const origin = new URL(c.req.url).origin;
  const url = `${origin}/tg/${c.env.TG_SECRET}`;
  try {
    await setWebhook(c.env.TG_BOT_TOKEN, url, c.env.TG_SECRET);
    await setState(c.env.DB, "tg_webhook_url", url);
    return c.json({ ok: true, url });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ---- §D1: кожен юзер підключає СВІЙ Telegram-чат ----------------------------
//
// Бот лишається один (це deployment-ресурс власника), змінюється адресат. Привʼязка йде
// deep-link'ом `t.me/<bot>?start=<підписаний токен>`, а не ручним введенням chat_id: свій
// chat_id людина не знає, а якби ми просили його ввести — будь-хто міг би вписати ЧУЖИЙ і
// перенаправити собі чужі сповіщення. У deep-link підтвердження робить сам Telegram: у
// вебхук приходить той chat, з якого справді натиснули кнопку.

setup.get("/telegram", async (c) => {
  const { tgLinkedChat } = await import("../lib/messaging/tg-target.ts");
  const chat = await tgLinkedChat(c.env);
  return c.json({
    configured: !!c.env.TG_BOT_TOKEN,
    linked: !!chat,
    // Сам chat_id назад НЕ віддаємо: показувати нема чого, а в логах/скріншотах це зайве.
    // Власнику окремо кажемо, що в нього є глобальний фолбек — інакше «не привʼязано» виглядало б
    // як «пуші не працюють», хоча вони працюють.
    owner_fallback: !!c.env.IS_OWNER && !!c.env.TG_CHAT_ID,
  });
});

setup.post("/telegram/link", async (c) => {
  if (!c.env.TG_BOT_TOKEN) {
    const { st } = await import("../lib/platform/i18n.ts");
    const { ownerLocale } = await import("../lib/finance/categories-i18n.ts");
    return c.json({ error: st(await ownerLocale(c.env.DB), "tgNotConfigured") }, 400);
  }
  const userId = c.env.USER_ID;
  if (!userId) return c.json({ error: "no user" }, 400);
  // Демо не привʼязується: пісочниця самознищується через 24 год, тож людина привʼязала б
  // реальний Telegram до обʼєкта, якого завтра не буде, і мовчки перестала б отримувати пуші.
  // (Технічно воно й так не спрацювало б — id пісочниці не hex, і токен не пройшов би звірку;
  // але «кнопка нічого не робить» — гірша відповідь, ніж «у демо недоступно».)
  const { isDemoEnv } = await import("../lib/platform/demo.ts");
  if (isDemoEnv(c.env)) {
    const { st } = await import("../lib/platform/i18n.ts");
    const { ownerLocale } = await import("../lib/finance/categories-i18n.ts");
    return c.json({ error: st(await ownerLocale(c.env.DB), "tgDemoUnavailable") }, 403);
  }
  const { telegramLinkToken } = await import("../lib/platform/auth.ts");
  const { getBotUsername } = await import("../lib/messaging/telegram.ts");
  try {
    const [bot, token] = await Promise.all([getBotUsername(c.env.TG_BOT_TOKEN), telegramLinkToken(c.env, userId)]);
    return c.json({ url: `https://t.me/${bot}?start=${token}` });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

setup.post("/telegram/unlink", async (c) => {
  const { unlinkTgChat } = await import("../lib/messaging/tg-target.ts");
  await unlinkTgChat(c.env);
  return c.json({ ok: true });
});

// Build the cursor over all mono accounts × monthly windows for ~90 days.
// The minute-cron also advances it, so it finishes even if the tab is closed.
setup.post("/backfill/start", async (c) => {
  const cursor = await startBackfill(c.env);
  // Hand the pacing to the object's alarm so the run finishes even with the tab closed. The
  // client still steps it too, for immediate feedback — both paths advance the same cursor,
  // and a step that arrives while monobank is rate-limiting simply reports `retry`.
  c.env.scheduleBackfillStep?.(60_000);
  return c.json({ ok: true, total: cursor.total, estimateMinutes: cursor.total });
});

// Perform exactly one statement request and advance. Client calls every 60s.
setup.post("/backfill/step", async (c) => {
  try {
    const r = await stepBackfill(c.env);
    if (!r) return c.json({ error: "no_backfill_in_progress" }, 400);
    return c.json(r);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ROADMAP L5: names the model transliterated before the prompt forbade it («Сільпо» over a
// `SILPO` statement line) split one merchant's history in two. GET previews, POST applies —
// a rename across hundreds of rows is not something to fire blind. Deterministic, no AI:
// the Latin original is already in `raw_json.description`. Details in lib/merchants.ts.
setup.get("/merchants/translit", async (c) => {
  const { planTranslitFixes } = await import("../lib/finance/merchants.ts");
  return c.json({ fixes: await planTranslitFixes(c.env) });
});

setup.post("/merchants/translit", async (c) => {
  const { applyTranslitFixes } = await import("../lib/finance/merchants.ts");
  return c.json({ ok: true, ...(await applyTranslitFixes(c.env)) });
});

setup.get("/status", async (c) => {
  const webhook = await getState(c.env.DB, "webhook_url");
  const raw = await getState(c.env.DB, CURSOR_KEY);
  const counts = await rowCounts(c.env.DB);
  const cursor: Cursor | null = raw ? JSON.parse(raw) : null;
  // How many foreign-currency rates are cached. The first-run checklist needs to know whether the
  // "refresh rates" step has ever succeeded, and `app_state` stores no timestamps — presence of
  // the cache is the fact that matters anyway (an empty one means no ₴ conversion is possible).
  const ratesRaw = await getState(c.env.DB, "rates");
  let rates = 0;
  try { rates = ratesRaw ? Object.keys(JSON.parse(ratesRaw) as Record<string, number>).length : 0; } catch { rates = 0; }
  return c.json({
    webhookRegistered: !!webhook,
    accounts: counts.accounts,
    transactions: counts.transactions,
    rates,
    backfill: cursor ? { progress: cursor.idx, total: cursor.total, done: cursor.idx >= cursor.total } : null,
  });
});
