/**
 * §SUB-MONTH — місячний тягар планів і розклад їхніх списань.
 *
 * Чому саме це: «підписок на місяць» рахувалось як `SUM(period_amount)` по активних планах,
 * тобто сума СВОГО періоду в кожного. Квартальний план важив повну суму щомісяця, тижневий —
 * лише один тиждень, і цифра в Пораднику не збігалась зі сторінкою Підписок, яка ділила на
 * `period_count` правильно (скарга користувача: «підписок ~3к/міс, а він рахує інше»).
 * Формула тут — та сама, що описана в міграції 0011; тест тримає її на місці.
 *
 * Run: `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { monthlyPlannedUAH, sumMonthlyPlannedUAH, chargesBetween, type PlanLike } from "./subscriptions.ts";

const RATES = { "840": 41.5 };
const DAY = 86400;
// 1 січня 2026, 00:00 UTC — усі дати нижче рахуються від нього, щоб їх можна було звірити руками.
const JAN1 = Math.floor(Date.UTC(2026, 0, 1) / 1000);

const plan = (p: Partial<PlanLike>): PlanLike => ({
  period_amount: 10000, currency_code: 980, period: "month", period_count: 1, start_date: JAN1, ...p,
});

test("§SUB-MONTH: місячний план — сам за себе, квартальний — третина", () => {
  assert.equal(monthlyPlannedUAH(plan({ period_amount: 30000 }), RATES, JAN1), 30000);
  // Квартальна підписка (`month` × 3): 300 ₴ раз на квартал = 100 ₴/міс, а не 300.
  assert.equal(monthlyPlannedUAH(plan({ period_amount: 30000, period_count: 3 }), RATES, JAN1), 10000);
});

test("§SUB-MONTH: тижневий план важить ~4.3 списання на місяць", () => {
  const m = monthlyPlannedUAH(plan({ period_amount: 10000, period: "week" }), RATES, JAN1);
  assert.equal(m, Math.round(10000 * (365.25 / 12 / 7)));
  // Головне, що він БІЛЬШИЙ за одне списання: стара сума брала рівно 100 ₴ і занижувала вчетверо.
  assert.ok(m > 40000);
});

test("§CUR-PLAN тримається: валюта плану зводиться в ₴ перед усередненням", () => {
  // $5/міс за курсом 41.5 = 207.50 ₴, а не 5 ₴.
  assert.equal(monthlyPlannedUAH(plan({ period_amount: 500, currency_code: 840 }), RATES, JAN1), 20750);
});

test("§SUB-MONTH: завершена розстрочка в місячний тягар не входить", () => {
  const finished = plan({ end_date: JAN1 - DAY });
  assert.equal(monthlyPlannedUAH(finished, RATES, JAN1), 0);
  assert.equal(sumMonthlyPlannedUAH([finished, plan({})], RATES, JAN1), 10000);
});

test("chargesBetween: тижневий план дає КІЛЬКА списань у вікні, місячний — одне", () => {
  const weekly = plan({ period: "week", period_amount: 5000 });
  const monthly = plan({ period_amount: 20000 });
  const charges = chargesBetween([weekly, monthly], RATES, JAN1, JAN1 + 27 * DAY);
  // Саме це ламало «залишок підписок» і прогноз: обидва мали власний цикл, який брав РІВНО
  // одне наступне списання на план, тож тижнева підписка в залишку місяця важила один раз.
  const weeklyCharges = charges.filter((ch) => ch.plan === weekly);
  assert.deepEqual(weeklyCharges.map((ch) => ch.at - JAN1), [0, 7 * DAY, 14 * DAY, 21 * DAY]);
  assert.equal(charges.filter((ch) => ch.plan === monthly).length, 1);
  // Розклад відсортований за часом — на нього спирається проєкція подушки (провал ліквідності).
  assert.deepEqual([...charges].sort((a, b) => a.at - b.at), charges);
});

test("chargesBetween: розстрочка обривається на end_date", () => {
  const installment = plan({ period_amount: 10000, end_date: JAN1 + 40 * DAY });
  const charges = chargesBetween([installment], RATES, JAN1, JAN1 + 200 * DAY);
  // 1 січня і 1 лютого — так; 1 березня вже за end_date, і далі цикл не йде.
  assert.deepEqual(charges.map((ch) => ch.at), [JAN1, chargesBetween([installment], RATES, JAN1 + DAY, JAN1 + 40 * DAY)[0]!.at]);
  assert.equal(charges.length, 2);
});
