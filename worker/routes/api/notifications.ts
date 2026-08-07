// `/notifications/*` plus the two manual triggers for outbound signals (`/tg/proactive`,
// `/alerts/scan`) — everything that speaks to the user unprompted.
//
// The Telegram recipient is PERSONAL and comes only from `tgTarget()` (§D1); the deployment
// secret is a fallback for the owner alone.
import { apiRoutes } from "./_shared.ts";
import type { NotifPrefs } from "../../../shared/api/platform.ts";

export const notifications = apiRoutes();

// ---- Центр сповіщень (ROADMAP §Черга 2, v1 in-app) ---------------------------
// Стрічка того, що система «хоче сказати». Уся логіка — `lib/notify.ts` (ЄДИНЕ джерело),
// тут лише транспорт. Генерація йде добовим кроном; `/notifications/generate` — ручний прогін.
notifications.get("/notifications", async (c) => {
  const url = new URL(c.req.url);
  const { listNotifications } = await import("../../lib/messaging/notify.ts");
  return c.json(await listNotifications(c.env, {
    limit: Number(url.searchParams.get("limit") ?? 60),
    kind: url.searchParams.get("kind"),
    unreadOnly: url.searchParams.get("unread") === "1",
  }));
});

notifications.post("/notifications/read", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>().catch(() => ({ ids: [] }));
  const ids = (body.ids ?? []).map(Number).filter(Number.isFinite);
  const { markRead, unreadCount } = await import("../../lib/messaging/notify.ts");
  await markRead(c.env, ids);
  return c.json({ ok: true, unread: await unreadCount(c.env) });
});

notifications.post("/notifications/read-all", async (c) => {
  const { markAllRead } = await import("../../lib/messaging/notify.ts");
  await markAllRead(c.env);
  return c.json({ ok: true, unread: 0 });
});

notifications.delete("/notifications", async (c) => {
  const { clearNotifications } = await import("../../lib/messaging/notify.ts");
  await clearNotifications(c.env);
  return c.json({ ok: true });
});

notifications.post("/notifications/generate", async (c) => {
  const { generateNotifications } = await import("../../lib/messaging/notify.ts");
  return c.json(await generateNotifications(c.env));
});

notifications.get("/notifications/prefs", async (c) => {
  const { getPrefs } = await import("../../lib/messaging/notify.ts");
  return c.json(await getPrefs(c.env) satisfies NotifPrefs);
});

notifications.put("/notifications/prefs", async (c) => {
  const body = await c.req.json<Record<string, boolean>>().catch(() => ({}));
  const { setPrefs } = await import("../../lib/messaging/notify.ts");
  return c.json(await setPrefs(c.env, body) satisfies NotifPrefs);
});

// Ручний тригер проактивного TG-пушу (тест без очікування тижневого крону).
notifications.post("/tg/proactive", async (c) => {
  const { runWeeklyProactive } = await import("../../lib/messaging/proactive.ts");
  try {
    return c.json(await runWeeklyProactive(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §F2 крок 2: скан вагомих непояснених операцій за 14 днів → TG-алерти (ручний тест/фолбек).
notifications.post("/alerts/scan", async (c) => {
  const { scanAlerts } = await import("../../lib/messaging/alert.ts");
  try {
    return c.json(await scanAlerts(c.env, new URL(c.req.url).origin));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});
