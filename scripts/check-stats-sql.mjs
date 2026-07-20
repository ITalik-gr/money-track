#!/usr/bin/env node
// Лінт канонічних SQL-запитів (`npm run check:sql`).
//
// ЧОМУ ЦЕ ІСНУЄ: після §SPLIT хелпери `amountSum/spendSum/incomeSum` і константи
// `EFF_AMOUNT/EFF_CAT_*/EFF_IMPORTANCE/SPEND_WHERE` посилаються на аліаси `sp`/`sc`/`scp`,
// які дає ЛИШЕ `STATS_JOINS`. Пʼять запитів забули джоїни → D1 кидав
// `no such column: sp.amount` → уся Статистика/Порадник/інсайт мовчки порожніли.
// Помилка не ловиться ні `tsc`, ні збіркою — SQL це рядок. Тому — окремий лінт.
//
// Правило: якщо шаблон запиту згадує канонічний хелпер і містить `FROM transactions`,
// він МУСИТЬ містити `STATS_JOINS`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["worker"];
const NEEDS_JOINS = /SPEND_WHERE|INCOME_WHERE|EFF_AMOUNT|EFF_CAT_|EFF_IMPORTANCE|spendSum\(|incomeSum\(|amountSum\(|SPEND_COUNT|INCOME_COUNT/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of ROOTS.flatMap((r) => walk(r))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/`([^`]*FROM transactions[^`]*)`/gs)) {
    const q = m[1];
    if (!NEEDS_JOINS.test(q)) continue;
    if (q.includes("STATS_JOINS")) continue;
    const line = src.slice(0, m.index).split("\n").length;
    problems.push({ file, line, snippet: q.trim().split("\n")[0].slice(0, 110) });
  }
}

if (problems.length) {
  console.error(`\n✘ SQL-лінт: ${problems.length} запит(ів) юзають канонічні хелпери БЕЗ STATS_JOINS.`);
  console.error("  Такий запит впаде в рантаймі: no such column: sp.amount\n");
  for (const p of problems) console.error(`  ${p.file}:${p.line}\n    ${p.snippet}…`);
  console.error("");
  process.exit(1);
}
console.log("✓ SQL-лінт: усі канонічні запити мають STATS_JOINS.");
