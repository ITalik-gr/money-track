/**
 * `/api/backups/*` — the copies of a user's data that live outside their Durable Object.
 *
 * WHY IN THE WORKER, not in `user-app.ts`: a backup spans two things only the Worker sees at once
 * — the object (where the rows are) and R2 (where the copy goes). The same reasoning that put
 * account erasure here. The object contributes exactly two RPCs, `exportDump` and `restoreBackup`;
 * everything about storage, retention and ownership is decided out here.
 *
 * OWNERSHIP IS THE KEY, not a check. Every object is addressed as `backups/<userId>/…` built from
 * the session's user id, so there is no path from this file to another user's copy — the same
 * property the receipts prefix has, and the reason it needs no separate rule to remember.
 */
import { Hono } from "hono";
import type { Env } from "../env.ts";
import {
  BACKUP_KEEP, BACKUP_NAME_RE, deleteBackup, inflate, listBackups, readBackup, storeBackup,
} from "../lib/platform/backup.ts";
import { localYmd } from "../lib/finance/stats.ts";
import type { BackupList, RestoreResult } from "../../shared/api/backups.ts";

export const backups = new Hono<{ Bindings: Env; Variables: { userId: string; isOwner: boolean } }>();

/**
 * No backups for a demo sandbox — not even the list.
 *
 * The DO-side demo blocklist (`user-app.ts`) cannot cover this: these routes never reach the
 * object. And the reason is not tidiness — `POST /run` writes a file into OUR bucket, and the
 * sandbox behind it is created by an unauthenticated GET. That is storage a stranger can spend
 * without an account, which is the same hole the `/ingest` block closed.
 *
 * A sandbox also has nothing to lose: it deletes itself in 24 hours by design.
 */
backups.use("*", async (c, next) => {
  if (c.get("userId").startsWith("demo:")) {
    return c.json({ error: "demo_readonly", detail: "Backups are disabled in the demo." }, 403);
  }
  await next();
});

/** A restore replaces everything. Typed, like erasure — a stray POST must not do this. */
const RESTORE_CONFIRM = "RESTORE";
/** An uploaded file this large is not one of ours, and parsing it would just burn the isolate. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

backups.get("/", async (c) => {
  const items = await listBackups(c.env.RECEIPTS, c.get("userId"));
  return c.json({ backups: items, keep: BACKUP_KEEP } satisfies BackupList);
});

/**
 * Make one now.
 *
 * ⚠️ Registered ABOVE `/:name` — Hono matches in registration order, so a literal below a
 * parameterised route of the same depth is unreachable (lint C7; bought with a real outage).
 */
backups.post("/run", async (c) => {
  const userId = c.get("userId");
  const ns = c.env.USER_DO;
  const json = await ns.get(ns.idFromName(userId)).exportDump();
  const { size } = await storeBackup(c.env.RECEIPTS, userId, json, localYmd(Math.floor(Date.now() / 1000)));
  return c.json({ ok: true, size });
});

/**
 * Put a backup back — from a stored copy (`name`) or from a file the user uploaded (the raw JSON
 * body). Both paths end in the same object RPC, so there is one implementation of the destructive
 * part and one place where it can be wrong.
 */
backups.post("/restore", async (c) => {
  const userId = c.get("userId");
  const url = new URL(c.req.url);
  if (url.searchParams.get("confirm") !== RESTORE_CONFIRM) {
    return c.json({ error: "confirmation_required" }, 400);
  }

  const name = url.searchParams.get("name");
  let json: string;
  if (name) {
    if (!BACKUP_NAME_RE.test(name)) return c.json({ error: "bad_name" }, 400);
    const obj = await readBackup(c.env.RECEIPTS, userId, name);
    if (!obj) return c.json({ error: "not_found" }, 404);
    json = await inflate(obj.body);
  } else {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);
    json = await c.req.text();
    if (!json.trim()) return c.json({ error: "empty_body" }, 400);
  }

  /**
   * A safety copy of what is about to be destroyed, taken FIRST and under its own name.
   *
   * Restoring the wrong file is the mistake this feature makes possible, and it is not undoable
   * by the feature itself — the daily copy would be overwritten by tonight's run of the restored
   * data. `pre-restore` sits outside the dated rotation, so there is always a way back to the
   * state immediately before the last restore.
   */
  const ns = c.env.USER_DO;
  const stub = ns.get(ns.idFromName(userId));
  try {
    const before = await stub.exportDump();
    await c.env.RECEIPTS.put(`backups/${userId}/pre-restore.json.gz`, await gzip(before), {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });
  } catch (e) {
    // Refuse rather than proceed: a restore with no way back is the one shape of this operation
    // nobody would agree to if asked.
    return c.json({ error: `could not take a safety copy first: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  const report = await stub.restoreBackup(json);
  return c.json(report satisfies RestoreResult);
});

backups.get("/:name", async (c) => {
  const name = c.req.param("name");
  const obj = await readBackup(c.env.RECEIPTS, c.get("userId"), name);
  if (!obj) return c.json({ error: "not_found" }, 404);
  // Served with `content-encoding: gzip` so the browser inflates it on the way to disk: the file
  // the user keeps is the same JSON `/export/all.json` hands them, not an archive they have to
  // know how to open.
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "content-disposition": `attachment; filename="money-track-${name.replace(/\.gz$/, "")}"`,
      "cache-control": "no-store",
    },
  });
});

backups.delete("/:name", async (c) => {
  await deleteBackup(c.env.RECEIPTS, c.get("userId"), c.req.param("name"));
  return c.json({ ok: true });
});

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Response(text).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
