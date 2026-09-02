/**
 * §FLOOR — what it costs this person to simply exist, and how long the cushion covers THAT.
 *
 * The owner's complaint that produced §BURN-SHAPE was «порадник каже я 44к в місяць витрачаю, але
 * такого і близько немає». The split answered it — 44 784 = 28 707 recurring + 16 077 lumpy — and
 * then went almost nowhere: it reaches the model in full, and the screen shows one parenthetical
 * line under the burn metric. The number he recognised as his life is still not a number the app
 * puts in front of him.
 *
 * It matters more than a caption, because runway is computed against the FULL burn. That is the
 * right default — a quarterly tax is real money and a runway that forgets it lies in the dangerous
 * direction — but it is not the only honest question. «Скільки я протягну, якщо не станеться
 * нічого разового» is a different number, always larger, and it is the one that decides whether
 * next month is survivable. Showing both, side by side and labelled, is the answer; showing either
 * one alone is a claim.
 *
 * ⚠️ **Nothing is recomputed.** The floor IS `burnShape(levels).recurring` and the total IS
 * `sumLevels` — the same `categoryMonthlyLevels` the burn metric, the budgets and the Advisor all
 * read. A second definition of "what repeats" would let this card and the metric above it disagree
 * about the same money, which is the failure §CUR-PLAN and §HEALTH are named after.
 *
 * ⚠️ **The floor is not a target and must not read as one.** It is what happens with no decisions
 * at all, so the categories behind it are listed: a floor nobody can see the parts of is a number
 * to be either believed or dismissed, and neither is useful.
 *
 * ⚠️ **`lumpy` is not "avoidable".** A quarterly tax is lumpy and unavoidable; a month of buying
 * electronics is lumpy and was a choice. The split is about RHYTHM, not about freedom, and the
 * wording says so — calling the lumpy half "optional" would be the app inventing permission.
 * §EFF_IMPORTANCE is where avoidability lives, and it is a different axis.
 */
import type { Env } from "../../env.ts";
import { categoryMonthlyLevels, sumLevels, burnShape } from "./levels.ts";
import { valueMode } from "./stats.ts";
import { catNameSql } from "./categories-i18n.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { ownFundsMinor } from "./own-funds.ts";
import { toBaseMinor, type Rates } from "./money.ts";
import type { FloorPart, SpendFloor } from "../../../shared/api/insights.ts";

/** Categories named under the floor. Enough to recognise the shape of a month, not a second list. */
const NAMED = 6;


export async function spendFloor(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<SpendFloor> {
  const loc = await resolveLocale(env);
  const { mult } = valueMode(rates, null);
  const levels = await categoryMonthlyLevels(env, mult, { now });
  const shape = burnShape(levels);

  // Names for the recurring categories, resolved in the reader's language like every other screen
  // (§LANG-ARCH — `catNameSql`, never the raw stored name).
  const ids = [...levels.entries()].filter(([, v]) => !v.lumpy && v.level > 0).map(([id]) => id);
  const named = new Map<number, { name: string; color: string | null }>();
  if (ids.length) {
    const r = await env.DB.prepare(
      `SELECT id, ${catNameSql(loc, "name")} AS name, color FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<{ id: number; name: string; color: string | null }>();
    for (const row of r.results ?? []) named.set(row.id, { name: row.name, color: row.color });
  }

  const parts: FloorPart[] = ids
    .map((id) => ({
      category_id: id,
      name: named.get(id)?.name ?? "",
      color: named.get(id)?.color ?? null,
      level: levels.get(id)!.level,
    }))
    .sort((a, b) => b.level - a.level)
    .slice(0, NAMED);

  // The cushion is §R3's — liquid accounts only, investments excluded, credit limit never merged
  // with own money. `ownFundsMinor` is the one place that knows those rules.
  const accounts = await env.DB.prepare(
    "SELECT balance, credit_limit, currency_code FROM accounts WHERE is_active = 1 AND COALESCE(role, 'liquid') = 'liquid'",
  ).all<{ balance: number; credit_limit: number; currency_code: number }>();
  let cushion = 0;
  for (const a of accounts.results ?? []) {
    const own = toBaseMinor(ownFundsMinor(a.balance, a.credit_limit), a.currency_code, rates);
    if (own > 0) cushion += own;   // a card in debt is not cushion; §R3 keeps the two apart
  }

  const months = (denominator: number) =>
    denominator > 0 ? Math.round((cushion / denominator) * 10) / 10 : null;

  return {
    floor: shape.recurring,
    burn: sumLevels(levels),
    lumpy: shape.lumpy,
    cushion,
    runway_months: months(shape.total),
    floor_months: months(shape.recurring),
    parts,
  };
}
