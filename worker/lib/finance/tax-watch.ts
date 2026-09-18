/**
 * §TAX-WATCH — watch the official sources; never become one (docs/TAX.md §0.2).
 *
 * THE ONE RULE. This module fetches a public page, reduces it to text, hashes it, and compares the
 * hash with last time. It does not read the page, does not extract a number from it, and does not
 * ask a model what it says. When the hash moves, the user gets the LINK and the date. The
 * requisites themselves are typed by the human and carry the date the human checked them.
 *
 * Why so strictly: the thing being watched is a payment requisite — a string that other people's
 * money travels along. A model that mis-copies one digit of an IBAN causes precisely the loss this
 * feature exists to prevent, and causes it with a confident tone. There is no version of «mostly
 * right» that is acceptable here, so the app is never the one saying it.
 *
 * ⚠️ PERIMETER. This is the only outbound request in the project to a third party that is not a
 * bank, the NBU or the model provider. It carries NOTHING: a bare GET of a public URL, no query
 * built from user data, no headers beyond a user agent, no body. Recorded in `docs/PERIMETER.md`.
 */
import type { AppDb } from "../platform/db-shim.ts";

/**
 * Is this a URL the watch may fetch? — the ONE definition, used both when a source is added and
 * again on whatever a redirect finally lands on.
 *
 * WHY IT IS NOT A REGEX ANY MORE. The route used to accept anything matching `^https://\S+$`,
 * which is true of `https://127.0.0.1/…`, of `https://[::1]/`, and of a public host that answers
 * 302 to either. Registration is OPEN, so that is an arbitrary stranger choosing a URL the worker
 * will GET every night from Cloudflare's network rather than from their own machine. Nothing of
 * the body is shown to them (this module only ever hashes it), so the exposure is status probing
 * rather than a content proxy — but «you cannot read the answer» is not a reason to make the
 * request (A3 audit, 2026-09-18).
 *
 * ⚠️ The REDIRECT is the half a check at insert time cannot cover, which is why `checkSource`
 * calls this again on `res.url`: the hop is chosen by the remote host, not by the person who
 * added the source, and it is the standard way past exactly this kind of validation.
 */
export function isWatchableUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  // An IP literal is never an official publication — a state body publishes on a name. Refusing
  // the whole shape is both simpler and safer than enumerating the reserved ranges, and covers
  // IPv6 (`new URL` keeps the brackets, and a bare `::1` has no dot either).
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (!host.includes(".")) return false; // `localhost`, a container name, a search-domain lookup
  return !/\.(localhost|local|internal|intranet|home\.arpa|onion)$/.test(host);
}

export interface RegSource {
  id: number;
  url: string;
  label: string;
  topic: string | null;
  region: string | null;
  content_hash: string | null;
  last_checked: number | null;
  last_changed: number | null;
  changes_in_row: number;
  noisy: number;
  last_error: string | null;
  is_active: number;
}

/** Changing on this many consecutive checks means the page is noisy, not that the law is. */
const NOISE_THRESHOLD = 3;

/**
 * Page → comparable text.
 *
 * Scripts and styles go first (they carry build ids and cache-busting query strings that change on
 * every deploy of someone else's site), then all tags, then whitespace is collapsed. What is left
 * is the visible prose, which is the only part a change in the rules would actually move.
 *
 * ⚠️ Deliberately NOT smarter than this. A selector or a readability heuristic would silently stop
 * matching the day the source redesigns, and a watch that quietly watches nothing is worse than no
 * watch at all — it reports «no changes» forever. Crude and loud beats clever and silent; the
 * false positives crude-ness produces are what the noise detector is for.
 */
export function normalizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listSources(db: AppDb): Promise<RegSource[]> {
  const res = await db.prepare(
    "SELECT * FROM reg_sources WHERE is_active = 1 ORDER BY topic, label",
  ).all<RegSource>();
  return res.results ?? [];
}

export interface CheckResult {
  id: number;
  label: string;
  url: string;
  /** The hash moved. */
  changed: boolean;
  /** The hash moved but the source is noisy, so no event was raised. */
  suppressed: boolean;
  error: string | null;
}

/**
 * Check one source.
 *
 * The FIRST check never counts as a change: there is nothing to compare against, and announcing
 * «the tax service page changed» the day someone adds a source would teach them that the alert
 * means nothing. It stores the baseline and stays quiet.
 */
export async function checkSource(db: AppDb, src: RegSource, now: number): Promise<CheckResult> {
  const base = { id: src.id, label: src.label, url: src.url };
  let text: string;
  try {
    if (!isWatchableUrl(src.url)) throw new Error("url is not watchable");
    const res = await fetch(src.url, {
      headers: { "user-agent": "money-track regulatory watch (+https://money.italik.dev)" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Re-checked AFTER the redirects: the destination is the remote host's choice, and a 302 into
    // a loopback or an IP literal is the ordinary way around a check made at insert time.
    // `res.url` is empty on a Response that was constructed rather than fetched, which is what a
    // stub in a test hands back — fall back to the URL we asked for, already checked above.
    if (!isWatchableUrl(res.url || src.url)) throw new Error("redirected somewhere not watchable");
    text = normalizeHtml(await res.text());
    // A page that reduces to almost nothing is a block page, a JS-only shell or an error dressed
    // as a 200. Hashing it would record a "change" and then a second one when the real page comes
    // back — two false alarms from one outage.
    if (text.length < 200) throw new Error("page has no readable text");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.prepare("UPDATE reg_sources SET last_checked = ?, last_error = ? WHERE id = ?")
      .bind(now, msg, src.id).run();
    return { ...base, changed: false, suppressed: false, error: msg };
  }

  const hash = await sha256(text);
  const first = !src.content_hash;
  const changed = !first && hash !== src.content_hash;
  const inRow = changed ? src.changes_in_row + 1 : 0;
  const noisy = inRow >= NOISE_THRESHOLD ? 1 : src.noisy;

  await db.prepare(
    `UPDATE reg_sources
        SET content_hash = ?, last_checked = ?, last_error = NULL,
            last_changed = CASE WHEN ? THEN ? ELSE last_changed END,
            changes_in_row = ?, noisy = ?
      WHERE id = ?`,
  ).bind(hash, now, changed ? 1 : 0, now, inRow, noisy, src.id).run();

  // A change on an already-noisy source is recorded (the date moves) but raises nothing.
  return { ...base, changed, suppressed: changed && !!src.noisy, error: null };
}

export async function checkAll(db: AppDb, now: number): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const src of await listSources(db)) out.push(await checkSource(db, src, now));
  return out;
}

export interface Requisite {
  id: number;
  kind: string;
  iban: string | null;
  recipient: string | null;
  edrpou: string | null;
  purpose: string | null;
  verified_at: number | null;
  source_id: number | null;
  /**
   * The watched source changed after the human last confirmed this. THE sentence the owner's
   * acquaintance never got to read — and the reason `verified_at` is a human act, not a fetch.
   */
  stale: boolean;
  /** When that happened, so the card can link the change rather than just assert it. */
  source_changed_at: number | null;
}

export async function listRequisites(db: AppDb): Promise<Requisite[]> {
  const res = await db.prepare(
    `SELECT r.id, r.kind, r.iban, r.recipient, r.edrpou, r.purpose, r.verified_at, r.source_id,
            s.last_changed AS source_changed_at
     FROM tax_requisites r
     LEFT JOIN reg_sources s ON s.id = r.source_id
     ORDER BY r.kind`,
  ).all<Omit<Requisite, "stale">>();
  return (res.results ?? []).map((r) => ({
    ...r,
    // Unverified is NOT stale: «you have never checked this» and «it changed since you checked»
    // are different sentences, and merging them would make the first one unfixable — confirming
    // would clear a warning that was never about confirmation.
    stale: !!(r.verified_at && r.source_changed_at && r.source_changed_at > r.verified_at),
  }));
}

export async function upsertRequisite(
  db: AppDb,
  r: { kind: string; iban?: string | null; recipient?: string | null; edrpou?: string | null;
       purpose?: string | null; source_id?: number | null; verified: boolean },
  now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO tax_requisites (kind, iban, recipient, edrpou, purpose, source_id, verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       iban = excluded.iban, recipient = excluded.recipient, edrpou = excluded.edrpou,
       purpose = excluded.purpose, source_id = excluded.source_id,
       verified_at = COALESCE(excluded.verified_at, tax_requisites.verified_at),
       updated_at = excluded.updated_at`,
  ).bind(r.kind, r.iban ?? null, r.recipient ?? null, r.edrpou ?? null, r.purpose ?? null,
         r.source_id ?? null, r.verified ? now : null, now).run();
}

export async function addSource(
  db: AppDb, s: { url: string; label: string; topic?: string | null; region?: string | null }, now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO reg_sources (url, label, topic, region, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET label = excluded.label, is_active = 1`,
  ).bind(s.url, s.label, s.topic ?? null, s.region ?? null, now).run();
}

/** Clear the noise flag — a human has looked and decided the source is worth watching again. */
export async function unmuteSource(db: AppDb, id: number): Promise<void> {
  await db.prepare("UPDATE reg_sources SET noisy = 0, changes_in_row = 0 WHERE id = ?").bind(id).run();
}

export async function removeSource(db: AppDb, id: number): Promise<void> {
  // Deactivated, not deleted: a requisite row points at it, and the date that source last changed
  // is the evidence behind a «check this» warning the user may still be acting on.
  await db.prepare("UPDATE reg_sources SET is_active = 0 WHERE id = ?").bind(id).run();
}
