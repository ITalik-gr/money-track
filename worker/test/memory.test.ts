import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../env.ts";
import { migratedDb, testEnv } from "./harness.ts";
import { addUserMemory, applyMemoryOps, archiveDue, isStorable, memoryContext, memoryList, patchMemory, situationForAi, sweepMemory } from "../lib/ai/memory.ts";

const DAY = 86400;
const NOW = 1_800_000_000;
const env = () => testEnv(migratedDb()) as unknown as Env;
const add = (topic: string, text: string, extra: Record<string, unknown> = {}) => ({ op: "add", topic, text, kind: "work", horizon: "months", importance: 2, ...extra });

test("one current truth per topic: a new statement replaces the old and keeps it in the archive", async () => {
  const e = env();
  await applyMemoryOps(e, [add("job", "Looking for a job")], NOW);
  await applyMemoryOps(e, [add("job", "Started a new job at the office")], NOW + DAY);
  const { active, archived } = await memoryList(e);
  assert.deepEqual(active.map((m) => m.text), ["Started a new job at the office"]);
  assert.equal(archived[0].archive_reason, "replaced");
  assert.equal(archived[0].replaced_by, active[0].id);
});

test("a stated end is respected at once, before any sweep", async () => {
  const e = env();
  await applyMemoryOps(e, [add("rent_date", "Rent moved to the 27th", { horizon: "days", valid_until: "2027-01-27" })], NOW);
  const until = (await memoryList(e)).active[0].valid_until as number;
  assert.ok((await memoryContext(e, until - 10)).memory);
  assert.deepEqual(await memoryContext(e, until + 1), {});
  await sweepMemory(e, until + 1);
  assert.equal((await memoryList(e)).archived[0].archive_reason, "expired");
});

test("silence ages a memory: first flagged, then archived, later for what matters more", () => {
  const base = { pinned: 0, valid_until: null, review_at: NOW, horizon: "weeks" as const };
  assert.equal(archiveDue({ ...base, importance: 1 }, NOW), "stale");
  assert.equal(archiveDue({ ...base, importance: 2 }, NOW), null);
  assert.equal(archiveDue({ ...base, importance: 2 }, NOW + 14 * DAY), "stale");
  assert.equal(archiveDue({ ...base, importance: 3 }, NOW + 14 * DAY), null);
  assert.equal(archiveDue({ ...base, importance: 1, pinned: 1 }, NOW + 9999 * DAY), null);
});

test("a confirmation restarts the clock; retire ends it", async () => {
  const e = env();
  await applyMemoryOps(e, [add("plan", "Plans to move")], NOW);
  const id = (await memoryList(e)).active[0].id;
  await applyMemoryOps(e, [{ op: "confirm", id }], NOW + 30 * DAY);
  assert.equal((await memoryList(e)).active[0].review_at, NOW + 90 * DAY);
  await applyMemoryOps(e, [{ op: "retire", id }], NOW + 31 * DAY);
  assert.equal((await memoryList(e)).active.length, 0);
});

test("the model cannot overwrite or retire what the user pinned", async () => {
  const e = env();
  await applyMemoryOps(e, [add("goal", "Saving for a car")], NOW);
  const id = (await memoryList(e)).active[0].id;
  await patchMemory(e, id, { pinned: true });
  await applyMemoryOps(e, [add("goal", "No longer saving"), { op: "replace", id, text: "Changed text" }, { op: "retire", id }], NOW + DAY);
  const { active } = await memoryList(e);
  assert.deepEqual(active.map((m) => m.text), ["Saving for a car"]);
});

test("only a lasting manual entry is pinned; a temporary one can fade or be updated", async () => {
  const e = env();
  await addUserMemory(e, { text: "Lasting note", horizon: "lasting" });
  await addUserMemory(e, { text: "Note for some weeks", horizon: "weeks" });
  await addUserMemory(e, { text: "Lasting until a date", horizon: "lasting", valid_until: "2099-01-01" });
  const pinned = Object.fromEntries((await memoryList(e)).active.map((m) => [m.text, m.pinned]));
  assert.deepEqual(pinned, { "Lasting note": 1, "Note for some weeks": 0, "Lasting until a date": 0 });
});

test("a pin outlasts silence but not a stated end", async () => {
  const base = { pinned: 1, review_at: NOW, horizon: "weeks" as const, importance: 1 };
  assert.equal(archiveDue({ ...base, valid_until: NOW + DAY }, NOW), null);
  assert.equal(archiveDue({ ...base, valid_until: NOW + DAY }, NOW + DAY), "expired");
  const e = env();
  await applyMemoryOps(e, [add("trip", "Away until the date", { valid_until: "2027-01-27" })], NOW);
  const { id, valid_until } = (await memoryList(e)).active[0];
  await patchMemory(e, id, { pinned: true });
  await sweepMemory(e, (valid_until as number) + 1);
  const { active, archived } = await memoryList(e);
  assert.equal(active.length, 0);
  assert.equal(archived[0].archive_reason, "expired");
});

test("credentials and card numbers are never stored; bad model output is ignored", async () => {
  assert.equal(isStorable("Card 4441 1111 2222 3333"), false);
  assert.equal(isStorable("Мій пароль від банку 1234"), false);
  assert.equal(isStorable("Rent is 12 500 a month"), true);
  const e = env();
  assert.equal(await applyMemoryOps(e, "nonsense", NOW), 0);
  assert.equal(await applyMemoryOps(e, [{ op: "delete_all" }, { op: "retire", id: 99 }, add("x", "Card 4441111122223333")], NOW), 0);
});

test("every profile reader gets memory after the profile, marked as newer", async () => {
  const e = env();
  await applyMemoryOps(e, [add("job", "Works at an office now")], Math.floor(Date.now() / 1000));
  const s = await situationForAi(e);
  assert.ok(s?.includes("override"));
  assert.ok(s?.includes("Works at an office now"));
});

test("the shared snapshot carries memory and the data the model used to miss", async () => {
  const { seed } = await import("./fixture.ts");
  const { collectFinanceSnapshot } = await import("../lib/ai/advisor.ts");
  const db = migratedDb();
  seed(db);
  const e = testEnv(db) as unknown as Env;
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO savings_goals (name, target_amount, current_amount, is_active, created_at) VALUES ('Trip', 100000, 25000, 1, ?)").bind(now).run();
  await applyMemoryOps(e, [add("job", "Works at an office now")], now);
  const { context } = await collectFinanceSnapshot(e);
  assert.equal((context.memory as { text: string }[])[0].text, "Works at an office now");
  assert.deepEqual((context.goals as { saved_uah: number; target_uah: number }[]).find((g) => g.target_uah === 1000)?.saved_uah, 250);
});

test("learning stores only what the model proposes from the user's turn, and survives a failure", async () => {
  const { learnFromTurn } = await import("../lib/ai/memory-learn.ts");
  const e = { ...(testEnv(migratedDb()) as object), ANTHROPIC_API_KEY: "test" } as unknown as Env;
  const real = globalThis.fetch;
  let sent = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return Response.json({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ ops: [add("rent_day", "Rent is due on the 20th")] }) }] });
  }) as unknown as typeof fetch;
  try {
    await learnFromTurn(e, "Я плачу за квартиру 20 числа [img:00000000-0000-0000-0000-000000000000]", "ok");
    assert.equal((await memoryList(e)).active[0].text, "Rent is due on the 20th");
    assert.ok(!sent.includes("[img:"));
    sent = "";
    await learnFromTurn(e, "ок", "ok");
    assert.equal(sent, "", "a trivial message costs no call");
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    await learnFromTurn(e, "Це довге повідомлення про мої плани", "ok");
    assert.equal((await memoryList(e)).active.length, 1);
  } finally { globalThis.fetch = real; }
});
