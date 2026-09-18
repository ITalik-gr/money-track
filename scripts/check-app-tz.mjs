#!/usr/bin/env node
/**
 * C12 — §APP_TZ: the worker never reads a date PART from the runtime's own clock.
 *
 * THE BUG THIS EXISTS FOR (found 2026-08-01 on live data, written up in `lib/finance/time.ts`):
 * at 02:46 on 1 August in Kyiv the Statistics page showed JULY, whatever period was selected. The
 * worker runs in UTC, and `new Date(x).getMonth()` returns the part in the RUNTIME's zone — 1
 * August 02:46 Kyiv is still 31 July 23:46 UTC, so «this month» was honestly computed as July.
 * Every night between 00:00 and 03:00 the app was a day behind, and it looked like «statistics
 * broke», not like «a period boundary in another timezone».
 *
 * WHY A CHECK AND NOT A COMMENT. The rule is already written down twice — in `CLAUDE.md`'s hard
 * invariants and at the top of `time.ts` — and both are prose that a person has to remember to
 * re-read. The failure is silent, it only appears for three hours a night, and it renders a
 * perfectly plausible number the rest of the time. That is the same profile as C10, and it is the
 * moment the working rules call for a deterministic check instead of an instruction.
 *
 * WHAT IS ALLOWED: `getUTC*` (the parts of an instant, zone-free), and `Date.UTC(...)` arithmetic
 * over parts that are ALREADY local — which is what the helpers in `time.ts` are built from.
 *
 * The client is deliberately NOT scanned: in the browser the runtime's zone IS the reader's, so
 * `new Date().getMonth()` there is the right question asked the right way.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "worker";

/**
 * Exemptions, each citing a FACT — the same discipline `check-currency.mjs` keeps, and for the
 * same reason: an exemption outlives its reason silently unless the reason is written next to it.
 */
const OK = {
  // The module that OWNS the conversion. Its two-pass `localWallTime` has to read the parts of a
  // candidate instant to discover the offset; that is the whole mechanism this rule protects.
  "lib/finance/time.ts": "the §APP_TZ implementation itself",
};

/** Local date-part readers. `getUTC…` is excluded by the negative lookbehind on `UTC`. */
const RE = /\.get(?!UTC)(FullYear|Month|Date|Day|Hours|Minutes|Seconds)\s*\(\s*\)/g;

/**
 * THE OTHER HALF of the same rule: a date or month KEY built in UTC.
 *
 * `new Date(unix * 1000).toISOString().slice(0, 7)` is an honest calculation in the wrong
 * calendar, and it produced a live defect found on 2026-09-18: `/analytics/patterns` indexed a
 * matrix grouped by the KYIV month with a UTC month key, so between 00:00 and 03:00 on the first
 * of a month it reported the whole of LAST month as this month's spending (20 000 ₴ where the
 * answer was 150 ₴). Same shape as the August 2026 outage, three years of hindsight apart.
 *
 * ⚠️ MATCHED NARROWLY, on purpose. The error is a Date built from an INSTANT (`* 1000`, or `new
 * Date()` for «now»); calendar arithmetic over parts that are already local — `new
 * Date(Date.UTC(y, m, d))` in `tax.ts`, the date-string shifts in `nbu.ts` — is correct and is not
 * matched. A check that cried wolf here would be a delete button with a plausible explanation.
 */
const KEY_RE = [
  // A Date built from unix SECONDS — the shape every «key from a timestamp» takes here.
  /new Date\([^)]*\*\s*1000\s*\)\s*\.toISOString\s*\(\s*\)\s*\.slice/g,
  // …and «now», which is the same question with the timestamp left implicit.
  /new Date\(\s*\)\s*\.toISOString\s*\(\s*\)\s*\.slice/g,
];

/** Exemptions for the KEY rule — each names the fact it rests on, like every other one here. */
const KEY_OK = {
  "lib/finance/money.ts": "`rateDayKey` — the date a bank PUBLISHED a rate, not an event in the reader's day",
  "lib/finance/networth.ts": "the series point is built at a UTC month end and keyed the same way",
  "lib/ai/receipt.ts": "an R2 object prefix, read by nobody as a calendar",
};

function tsFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir || "."), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "test") out.push(...tsFiles(join(dir, e.name), rel)); }
    else if (/\.ts$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/** A getter named inside prose explaining the rule is not a violation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^\n"'`]*$/gm, "");
}

const problems = [];
for (const file of tsFiles("")) {
  const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
  if (!Object.hasOwn(KEY_OK, file)) {
    code.split("\n").forEach((line, i) => {
      for (const m of KEY_RE.flatMap((re) => [...line.matchAll(re)])) {
        problems.push(
          `${ROOT}/${file}:${i + 1}: builds a date KEY in UTC.\n` +
          `    §APP_TZ: use localYmd()/localYm() — a key compared against a Kyiv-grouped column is\n` +
          `    off by a day for the three hours after midnight, with no error anywhere.\n` +
          `    ${line.trim().slice(0, 110)}`,
        );
        void m;
      }
    });
  }
  if (Object.hasOwn(OK, file)) continue;
  code.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      problems.push(
        `${ROOT}/${file}:${i + 1}: reads ${m[0]} from the runtime clock.\n` +
        `    §APP_TZ: the worker runs in UTC. Use localParts/localYmd/localMonthStart (lib/finance/time.ts),\n` +
        `    or getUTC${m[1]}() when you genuinely mean the instant and not the calendar.\n` +
        `    ${line.trim().slice(0, 110)}`,
      );
    }
  });
}

if (problems.length) {
  console.error("✗ C12 §APP_TZ:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log(
  `✓ C12 §APP_TZ: no local date parts read and no UTC date keys in ${ROOT}/ ` +
  `(${Object.keys(OK).length + Object.keys(KEY_OK).length} exemptions, each with its reason in the script)`,
);
