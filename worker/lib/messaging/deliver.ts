/**
 * DELIVERING the notification feed to the channels outside the app.
 *
 * Split out of `notify.ts` on 2026-08-08, and by a check rather than by taste: adding web push
 * pushed that file past its 1000-line exception, and C3's rule is "move handlers out instead of
 * raising the number". The seam it forced is the right one — `notify.ts` DECIDES what is worth
 * saying (it reads budgets, runway, subscriptions and writes rows); this file only takes what has
 * already been decided and gets it to a phone.
 *
 * Two channels, and they are deliberately independent:
 *   • Telegram — better on a phone that has it, needs no permission prompt, but needs a bound chat;
 *   • Web push — needs a permission, works with no Telegram at all.
 * Each has its OWN "already sent" column (`pushed_tg_at`, `pushed_web_at`). With one shared flag
 * whichever channel ran first would consume the notification and the other would find nothing —
 * they would silently take turns.
 *
 * Both are capped at `severity >= warn`. If everything is pushed, notifications get ignored, and
 * then the one that mattered is ignored with them.
 */
import type { Env } from "../../env.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { renderNotif, type NotifParams, type NotifTemplateKey } from "../../../shared/notif-i18n.ts";
import type { Severity } from "./notify.ts";

// Language is resolved at SEND time rather than at creation: the stored title/body is only a
// fallback for rows without a template, and a user who switched language yesterday should not get
// yesterday's language tonight. `resolveLocale` is the single answer (reader first, stored second).

// `notif_params` is a JSON string; a malformed one must degrade to {} (the template then shows its
// defaults) rather than throw and drop the whole batch.
function safeParse(json: string | null): NotifParams {
  if (!json) return {};
  try { return JSON.parse(json) as NotifParams; } catch { return {}; }
}

const TG_ICON: Record<Severity, string> = { info: "•", warn: "🟠", urgent: "🔴" };
const tgEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Пуш у Telegram — ЛИШЕ важливе (`severity >= warn`). Решта живе тільки в застосунку:
 * якщо слати все, сповіщення почнуть ігнорувати, і важливе загубиться разом з рештою.
 * `pushed_tg_at` захищає від повторів (крон ганяється щодня по тій самій таблиці).
 */
export async function pushPendingToTelegram(env: Env): Promise<{ sent: number; reason?: string }> {
  // §D1 — the addressee is this user's OWN linked chat. What this replaces: `TG_CHAT_ID` is ONE
  // global chat (the owner's), and every user's Durable Object runs this same cron branch, so an
  // invited friend's notifications ("ти витратив 3 400 ₴ на Продукти") were delivered to the
  // OWNER's Telegram — their data, someone else's phone. The stop-gap was an owner-only gate,
  // i.e. the feature off for everyone else; now each user binds their own chat and the global
  // secret stays a fallback for the owner alone (`tgTarget`).
  const { tgTarget } = await import("./tg-target.ts");
  const target = await tgTarget(env);
  if (!target) return { sent: 0, reason: "no Telegram chat linked" };
  const { token, chatId } = target;

  const rows = await env.DB.prepare(
    `SELECT id, kind, title, body, notif_key, notif_params, severity FROM notifications
     WHERE pushed_tg_at IS NULL AND severity IN ('warn','urgent')
     ORDER BY created_at ASC LIMIT 10`,
  ).all<{ id: number; kind: string; title: string; body: string | null; notif_key: NotifTemplateKey | null; notif_params: string | null; severity: Severity }>();
  const items = rows.results ?? [];
  if (!items.length) return { sent: 0 };

  // Render in the owner's CURRENT locale at send time (§12.3), not the locale stored at
  // creation — the stored title/body is only a fallback for rows without a template.
  const locale = await resolveLocale(env);
  const { sendMessage } = await import("./telegram.ts");
  const lines = items.map((n) => {
    let title = n.title, body = n.body;
    if (n.notif_key) {
      const r = renderNotif(locale, n.notif_key, safeParse(n.notif_params));
      title = r.title; body = r.body;
    }
    return `${TG_ICON[n.severity]} <b>${tgEsc(title)}</b>${body ? `\n${tgEsc(body)}` : ""}`;
  });
  await sendMessage(token, chatId, `🔔 Money Track\n\n${lines.join("\n\n")}`);

  const now = Math.floor(Date.now() / 1000);
  const holes = items.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE notifications SET pushed_tg_at = ? WHERE id IN (${holes})`)
    .bind(now, ...items.map((n) => n.id)).run();
  return { sent: items.length };
}


/**
 * Both channels, once. The caller (the daily notification run) needs neither to know the other
 * exists, and neither may hide the other's failure — a Telegram outage must not mean nobody's
 * browser rings.
 */
export async function deliverPending(env: Env): Promise<{ telegram: number; web: number; failed: string[] }> {
  const failed: string[] = [];
  let telegram = 0;
  try { telegram = (await pushPendingToTelegram(env)).sent; }
  catch (e) { failed.push(`telegram: ${e instanceof Error ? e.message : String(e)}`); }
  let web = 0;
  try {
    const { pushPendingToWeb } = await import("./webpush.ts");
    web = (await pushPendingToWeb(env)).sent;
  } catch (e) { failed.push(`webpush: ${e instanceof Error ? e.message : String(e)}`); }
  return { telegram, web, failed };
}
