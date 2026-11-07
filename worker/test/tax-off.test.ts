/**
 * §BIZ-SPLIT — switching the ФОП module off clears its unread deadline news.
 *
 * The owner has no ФОП and still had «ЄСВ overdue» in the feed (2026-11-07): the screen stops
 * showing the debt the moment the module is off, so the feed must stop claiming it too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readProfile, writeProfile } from "../lib/finance/tax.ts";
import { muteTaxNews } from "../lib/messaging/mute.ts";
import type { Env } from "../env.ts";
import { migratedDb, testEnv } from "./harness.ts";

test("§BIZ-SPLIT: turning the tax module off marks its deadline news read", async () => {
  const d = migratedDb();
  const add = (key: string, entity: string | null) => d.raw.prepare(
    `INSERT INTO notifications (kind, title, severity, entity_type, entity_id, dedup_key, created_at)
     VALUES ('deadline', 'x', 'urgent', ?, '1', ?, 0)`,
  ).run(entity, key);
  add("deadline:tax:social_contribution:2026-Q3:overdue", "tax_obligation");
  add("deadline:plan:7", "planned");

  const on = { ...(await readProfile(d)), enabled: true, business: true };
  await writeProfile(d, on);
  const unread = () => d.raw.prepare("SELECT entity_type AS e FROM notifications WHERE read_at IS NULL ORDER BY id").all() as { e: string }[];
  assert.equal(unread().length, 2, "switching ON leaves the feed alone");

  await writeProfile(d, { ...on, enabled: false });
  await muteTaxNews(testEnv(d) as unknown as Env); // what PUT /tax/profile does when `enabled` goes false
  assert.deepEqual(unread().map((r) => r.e), ["planned"], "only the tax news goes, other deadlines stay");
  assert.equal((await readProfile(d)).enabled, false);
});
