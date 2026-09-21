# §AI-EVAL — the dataset

`cases.json` is what `scripts/eval-ai.mjs` runs. Everything else in the project pins a NUMBER;
this pins a VERDICT — what the model concluded about a transaction it had never seen.

    npm run eval            # run, report, diff against the baseline
    npm run eval -- --dry   # gate only: no network, no cost
    npm run eval -- --group subs --concurrency 2
    npm run eval -- --record   # write baseline.json (deliberate, reviewed changes only)
    npm run eval -- --judge jev   # enrichment answered by Jev (docs/JEV.md); own baseline.jev.json

The run needs `ANTHROPIC_API_KEY` in `.dev.vars` or the environment. It is NOT part of
`npm run check`: it costs money and it is not deterministic, so it is a tool you reach for
around a change, not a gate on every commit.

## What one case looks like

```json
{ "id": "netflix", "group": "subs", "desc": "NETFLIX.COM", "mcc": 4899, "amount": -41900,
  "expect": { "gate": "ask", "root": 6, "recurring": 1 },
  "why": "§SUBS-CAT: streaming is entertainment since migration 0047" }
```

| field | meaning |
|---|---|
| `desc` | the RAW bank description, exactly as a bank would send it — noise, terminal numbers and all |
| `mcc` | the code, or `null` for the paths that have none (CSV import, cash, quick-add) |
| `amount` | minor units, signed: negative is an expense |
| `currency` | ISO numeric, default 980 |
| `comment` / `note` | the counterparty's text / the user's own `user_note` |
| `is_transfer`, `ai_enriched` | pre-set flags, for cases about the gate rather than the model |
| `context` | rows that existed BEFORE this one — merchant history, a previous verdict to carry |
| `expect` | only what this case is about: `gate`, `root`, `category`, `recurring`, `transfer` |
| `why` | one line: what breaks if this case goes red |

An expectation nobody wrote is not scored. A case that declares only `gate` is a statement about
§ENRICH-GATE and costs nothing to run.

## Rules for adding a case

1. **A case must pin something that could plausibly go wrong.** A dataset of well-formed
   supermarket charges goes green through every regression it is supposed to catch — the same
   selection rule as `fixture.ts`.
2. **Expectations are what a HUMAN would say, not what the model said.** Writing down the current
   answer turns the eval into a mirror. If a case is genuinely ambiguous (a bookshop, a
   kindergarten), declare only `gate` and leave the category unscored, or state the ambiguity in
   `why` and pick the defensible answer.
3. **Score at the ROOT.** Sub-categories roll up into their parent everywhere else in this
   project, so «Кава» for an expected «Кафе і ресторани» is right. Use `category` for an exact id
   only when the leaf itself is the point.
4. **Real descriptions only.** Invented merchant strings measure an invented problem. Take them
   from the demo fixture or from an export, with names anonymised.
5. **When the taxonomy moves, the dataset moves with it.** The first run of this harness reported
   eight failures in the `subs` group; every one of them was the DATASET being wrong — category 12
   «Підписки» had been retired by migration 0047 (§SUBS-CAT) and the model knew it. Check the
   migrations before blaming the model.

## The groups (131 cases, 2026-09-18)

`grocery` `cafe` `transport` `health` `subs` `utility` `transfer` `income` `note` `fx` `tricky`
`carry` — and two added by audit A4:

- **`fop`** — the ФОП slice: the rails a sole trader is actually paid through (Payoneer, Deel, an
  invoice-worded UAH transfer), the platform's cut, the bank's service fee, the work tools that
  bill on a schedule, and the tax payments themselves. It exists because `docs/TAX.md` made
  «business income» a property of an operation, and nothing measured whether the model can see one.
- **`csv`** — the import path, which has **no MCC at all** (§CSV-PREAMBLE). Two thirds of the
  model's difficulty lives here: the same chain spelled Latin and Cyrillic, a multimarket that
  sells three roots at once, a utility named by the month it is for.

⚠️ **A `--dry` run scores the GATE only.** It is free and it verifies the one expectation that is
deterministic code rather than a model's opinion — all 60 cases added on 2026-09-18 were written
against §ENRICH-GATE and confirmed that way (60/60; the one gate miss in the file is the
long-standing red `note-says-salary`). `root` and `recurring` in those cases are still UNSCORED
until somebody runs a paid eval: a dry run has no model verdict to record, so **never `--record`
after `--dry`** — it would write `null` over the real baseline.

⚠️ **Rule 4 («real descriptions only») is the ceiling on this dataset.** A4 asked for 150–200
cases; 131 is where honest ones ran out. Getting further needs an anonymised export of real bank
descriptions — inventing another seventy merchant strings would measure an invented problem. The
OCR group A4 also asked for cannot live here at all: this harness runs
`categorize() → enrichVerdict() → enrichOne()` over a transaction row, and a receipt photo enters
through `receipt.ts`, which is a different ladder and needs its own harness.

## The baseline

`baseline.json` holds the last recorded verdict per case. A normal run prints only the movement:
what passed and now fails, what failed and now passes, and what changed category while still
passing. Re-record ONLY for a change you meant to make — never to turn a red run green. Same
contract as `__golden__`, one level up: golden files pin what the app computed, this pins what the
model concluded.

`last-run.json` is the full detail of the most recent run (gitignored). A run costs money; losing
it to a scrolled-off terminal means paying twice for the same answer.
