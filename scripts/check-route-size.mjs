#!/usr/bin/env node
/**
 * C3 — no route or service file grows back into a landfill.
 *
 * WHY THIS EXISTS
 *
 * `api.ts` reached 3 331 lines, 179 inline queries and 26 domains not because anyone decided to
 * write a huge file, but because appending to the end of an existing file is always the smallest
 * possible diff. Splitting it once fixes nothing on its own; nothing stopped the same drift from
 * starting again the next morning. The rule that keeps it split has to be mechanical.
 *
 * THE RULE
 *
 * Every `.ts` file under `worker/routes/`, `worker/services/` and `worker/lib/` stays under CAP
 * lines. Files already above it are listed in EXCEPTIONS, and an exception may never RISE.
 *
 * `lib/` was added on 2026-08-07, after phase 5. It was left out at first on the theory that
 * domain logic legitimately runs longer than transport — but that is exactly the theory under
 * which `ai.ts` reached 1 335 lines carrying six unrelated jobs. The cap is the same everywhere;
 * what differs is how many exceptions a directory needs, and each one is a debt with a name.
 *
 * WHY NOT A STRICT TWO-DIRECTIONAL RATCHET LIKE C1
 *
 * `check-repo-layer.mjs` also fails when a count drops below its budget, and that is right there:
 * a query count moves in whole steps and rarely, so a drop means someone forgot to tighten it.
 * Line counts move on every edit, and a check that fails because a file got three lines shorter
 * trains people to edit the budget without reading it — which is exactly how a guard becomes
 * decoration. So this one only fails when the slack is large enough to be real drift (SLACK).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["worker/routes", "worker/services", "worker/lib"];
const CAP = 400;
/**
 * How far under its exception a file may sit before the allowance counts as stale.
 *
 * **40, lowered from 80 on 2026-09-04, and the reason is a near-miss worth recording.** The night
 * §ADVICE-LOOP landed, `advisor.ts` was split twice and fell to 695 lines while this table still
 * allowed 769 — 74 lines of headroom nobody granted, which is more than enough to undo one of
 * those splits for free with the lint green the whole way. It did not fire: 74 < 80, by six lines.
 *
 * ⚠️ **The number was not wrong so much as OLD.** C8 was written later (2026-09-02) for the same
 * mechanism and chose 40 after thinking about it properly; nobody went back and asked whether C3's
 * 80 still made sense. Two checks doing one job with two constants is a slow way to be wrong in
 * exactly one of them — and the one that is wrong is always the one nobody re-read.
 *
 * Still not zero, for the reason the header gives: line counts move on every edit, and a check
 * that goes red because a file lost three lines trains people to edit the number without reading
 * it. 40 is small enough that a real extraction cannot hide under it and large enough that
 * ordinary editing never trips it.
 */
const SLACK = 40;

/**
 * Files allowed above CAP. ONLY EVER GOES DOWN — delete the line once a file is under the cap.
 */
const EXCEPTIONS = {
  // 19 dense reporting handlers over one prefix. Splitting it further means splitting `/analytics`
  // itself into sub-domains, which is a design decision and not a mechanical move.
  // 2026-08-14 (§INCOME-PLAN): 720 → 687. Adding expected income pushed this file over, and the
  // answer was an extraction, not a bigger number — `cashflowMoves` + `safeToSpend` moved to
  // `lib/finance/cashflow.ts`, which is where "which money moves when" belonged anyway. The
  // exception ratchets down with the file so the slack cannot be spent twice.
  // 2026-08-14 (§CAT-PAGE): 687 → 655 — the category drill followed, into `category-drill.ts`.
  "worker/routes/api/analytics.ts": 670,
  // Predates the split: the Telegram bot's command surface, still holding 3 inline queries too.
  // 2026-09-02 (§TG-CSV): 320 → 315. Statement import needed a dispatch branch and a callback
  // branch, and the exception could not rise — so the FORMATTERS moved to `tg-format.ts`, which
  // owns bot presentation and is where `balanceText`/`lastTxText` belonged anyway. The ratchet
  // takes the slack so it cannot be spent twice.
  "worker/routes/telegram.ts": 315,
  // The AI adviser: the finance snapshot, the chat, the chat's tools, and the deterministic
  // fallback advice. The snapshot alone is the single source every AI screen reads, so splitting
  // it is a design decision — recorded rather than done.
  // 1120 → 1080 (2026-08-07): streaming pushed the file over its allowance, and instead of
  // raising the number the §A1 facts CRUD moved to `lib/ai/facts.ts` — where it belonged anyway,
  // since it is plain CRUD with no advice logic in it. Second time C3 has forced that call.
  // 2026-08-08: 1080 → 909 after the chat's TOOLS moved to `lib/ai/chat-tools.ts`. The ratchet
  // did its job — English prompts are longer than the Ukrainian they replaced, the file hit the
  // ceiling, and the answer was a seam rather than a bigger number.
  // 2026-09-04: 769 → 694. §ADVICE-LOOP added the suggestion ledger and pushed the file over; the
  // answer was two seams rather than a bigger number — the loop itself to `advice-actions.ts`, and
  // the DETERMINISTIC fallback to `advice-fallback.ts`. The second is the one worth naming: this
  // file is about the MODEL's answer, and the fallback is the answer given when there is no model.
  // ⚠️ **CORRECTED 2026-09-04 (second pass).** The note written here hours earlier claimed this
  // check «does not» enforce a downward ratchet and that the number had to be lowered by hand.
  // That was false — the `SLACK` branch below has always done it. What actually happened is that
  // the slack was 80 and the drift was 74, so it missed by six lines. The lesson is not the one
  // the first note drew: it is that C8 re-derived the same constant as 40 three days earlier and
  // nobody reconciled the two. `SLACK` is now 40 and this case would fire.
  "worker/lib/ai/advisor.ts": 695,
  // The notification centre: one drafting function per event kind, plus the Telegram push.
  // 2026-08-27: 1000 → 861. The three guards added after «Rent due in 11 days» (calendar, language,
  // repetition) pushed the file over, and the answer was a seam rather than a bigger number — the
  // AI branch moved to `drafts-ai.ts`, beside `drafts-budget`/`drafts-import`. Third time C3 has
  // forced that call and third time it named the right seam.
  // 2026-09-02: 861 → 817, §GOAL-PACE's drafter moved to `drafts-goals.ts` — fourth seam, and the
  // fourth time the file named it correctly.
  "worker/lib/messaging/notify.ts": 817,
  // The canon itself. Long ON PURPOSE — this is the file the whole project points at when it says
  // "one number, one home", and cutting it up would give that number two homes again.
  // 2026-08-27: 500 → 398, and the exception is kept only because the file is still over the cap.
  // §LEVEL-WINDOW pushed it over, and the seam was the same one `budgetStatus` took in August: the
  // SQL canon stays here, the JUDGEMENT about it over a window moved to `levels.ts` and is
  // re-exported. "One home" is about the definition, not about the file it is typed into.
  "worker/lib/finance/stats.ts": 398,
  // Categorisation, transfer review and text parsing — three model calls that share a taxonomy.
};

function tsFiles(dir, prefix = dir + "/") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), prefix + e.name + "/"));
    else if (e.name.endsWith(".ts")) out.push(prefix + e.name);
  }
  return out;
}

const problems = [];
let worst = 0;

for (const file of DIRS.flatMap((d) => tsFiles(d))) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  const allowed = EXCEPTIONS[file] ?? CAP;
  if (!EXCEPTIONS[file]) worst = Math.max(worst, lines);

  if (lines > allowed) {
    problems.push(
      EXCEPTIONS[file]
        ? `${file}: ${lines} lines, exception allows ${allowed}.\n` +
          `    An exception may never rise. Move handlers out instead.`
        : `${file}: ${lines} lines, the cap is ${CAP}.\n` +
          `    Split it by path prefix, the way routes/api/ is organised — do not raise the cap.`,
    );
  } else if (EXCEPTIONS[file] && lines < allowed - SLACK) {
    problems.push(
      `${file}: down to ${lines} lines (exception still says ${allowed}).\n` +
      `    Lower it in scripts/check-route-size.mjs, or delete the line if it is under ${CAP}.`,
    );
  }
}

if (problems.length) {
  console.error("✗ C3 file size:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}

console.log(
  `✓ C3 file size: largest un-excepted route/service file is ${worst} lines (cap ${CAP}, ` +
  `${Object.keys(EXCEPTIONS).length} exceptions)`,
);
