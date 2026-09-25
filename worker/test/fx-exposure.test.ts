/**
 * §FX-EXPOSURE — reconciled against the canon it reads, and the what-if is exactly what it says.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { FxExposure } from "../../shared/api/insights.ts";

async function get<T>(db: MemDb, path: string): Promise<T> {
  const res = await api.request(path, { method: "GET" }, testEnv(db));
  assert.equal(res.status, 200);
  return await res.json() as T;
}

test("§FX-EXPOSURE: assets add up to the summary total, and +10% moves exactly the foreign part", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    // A dollar account, so there is something foreign to move.
    db.raw.prepare(
      `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
       VALUES ('usd1', 'black', 'USD', 840, 100000, 0, 1, 0)`,
    ).run();
    const [fx, summary] = await Promise.all([
      get<FxExposure>(db, "/insights/fx-exposure"),
      get<{ totalUAH: number }>(db, "/summary"),
    ]);
    const sum = fx.assets.reduce((s, a) => s + a.amount, 0);
    assert.ok(Math.abs(sum - summary.totalUAH) <= fx.assets.length, `${sum} vs ${summary.totalUAH}`);
    const foreign = fx.assets.filter((a) => a.currency_code !== fx.base_currency).reduce((s, a) => s + a.amount, 0);
    assert.ok(foreign !== 0, "the dollar account is foreign to a hryvnia reader");
    assert.equal(fx.assets_delta, Math.round(foreign * 0.1));
    const spendShare = fx.spend.reduce((s, r) => s + r.share, 0);
    if (fx.spend.length) assert.ok(Math.abs(spendShare - 1) < 1e-9);
  } finally { restore(); }
});

test("§FX-EXPOSURE: a single-currency ledger has nothing to move", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    db.raw.prepare(
      `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
       VALUES ('a', 'black', 'UAH', 980, 500000, 0, 1, 0)`,
    ).run();
    const fx = await get<FxExposure>(db, "/insights/fx-exposure");
    assert.equal(fx.assets_delta, 0);
    assert.equal(fx.spend_delta_monthly, 0);
  } finally { restore(); }
});
