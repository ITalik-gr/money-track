/**
 * §ADVICE-LOOP — the adviser's suggestions, with a state a person can set and it keeps.
 *
 * Split from `advisor.ts` for the same reason `advice-history.ts` was (C3, and a real seam): that
 * file ANSWERS «how is the user doing» out of one snapshot, this one only remembers what was said
 * and what came of it. The import runs one way — `advisor.ts` calls in, this calls nothing back.
 *
 * **What was wrong before.** `pushAdviceHistory` stored the summary and the numbers and dropped
 * the suggestions entirely, so «what did the adviser tell me last month, and did it work» had no
 * answer in the data — not a hard one, none. The adviser could therefore repeat a suggestion the
 * user had already rejected, indefinitely, with no way for anyone to notice: §NOVELTY keeps the
 * FEED from repeating itself and nothing did the same for advice.
 *
 * Stored as one JSON object in `app_state`, keyed by suggestion key — capped, read whole, never
 * joined, exactly like the history array beside it. A table would buy nothing: there is no query
 * here that is not «give me all of it».
 */
import type { Env } from "../../env.ts";
import type { AdviceSuggestion, SuggestionState } from "../../../shared/api/ai.ts";
import { getState, setState } from "../finance/repo.ts";

const KEY = "advisor_suggestions";
/**
 * How many decisions are remembered. Generous on purpose: the cost is bytes, and the thing this
 * store exists to prevent — re-proposing something that was refused — gets worse the further back
 * the refusal is, because that is exactly when the user has stopped expecting to see it again.
 */
const CAP = 120;

/** What is remembered per suggestion. The text is kept so the model can be shown what it said. */
export interface SuggestionRecord {
  key: string;
  title: string;
  state: SuggestionState;
  state_at: number;
  metric?: AdviceSuggestion["metric"];
  outcome?: AdviceSuggestion["outcome"];
}

/**
 * The identity of a suggestion: a normalised title.
 *
 * ⚠️ **Never the array index.** Advice is regenerated wholesale, so an index means the state the
 * user set on the second suggestion lands on whatever the model happens to put second next time —
 * silently, and looking entirely correct.
 *
 * Normalisation is deliberately blunt (lower-case, letters and digits only, collapsed, clipped):
 * it has to survive a stray comma or a changed dash, and it must NOT try to survive a rewrite. A
 * fuzzy key that merges two genuinely different suggestions would hide the second one forever,
 * which is a worse failure than showing a rephrase twice — and the rephrase has its own guard,
 * because the previous titles go into the payload (§NOVELTY).
 */
export function suggestionKey(title: string): string {
  return title.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

export async function getSuggestionRecords(env: Env): Promise<Map<string, SuggestionRecord>> {
  const raw = await getState(env.DB, KEY);
  if (!raw) return new Map();
  try {
    const rows = JSON.parse(raw) as SuggestionRecord[];
    return new Map(rows.map((r) => [r.key, r]));
  } catch {
    // A store that cannot be parsed is a store with nothing in it. Throwing here would take down
    // the adviser — the feature this exists to improve — over a bookkeeping detail.
    return new Map();
  }
}

async function write(env: Env, rows: Map<string, SuggestionRecord>): Promise<void> {
  const list = [...rows.values()].sort((a, b) => b.state_at - a.state_at).slice(0, CAP);
  await setState(env.DB, KEY, JSON.stringify(list));
}

/**
 * Record a decision. Returns false when the key is unknown to the caller's advice — the route
 * turns that into a 404 rather than writing a state for a suggestion nobody made.
 */
export async function setSuggestionState(
  env: Env, key: string, state: SuggestionState,
  meta: { title?: string; metric?: AdviceSuggestion["metric"] } = {},
  now = Math.floor(Date.now() / 1000),
): Promise<SuggestionRecord> {
  const rows = await getSuggestionRecords(env);
  const prev = rows.get(key);
  const rec: SuggestionRecord = {
    key,
    title: meta.title ?? prev?.title ?? key,
    state,
    state_at: now,
    // The metric is captured ONCE, when the suggestion is first recorded. Re-capturing it on every
    // state change would reset the baseline to the day the user pressed «done», against which any
    // improvement is zero by construction — the measurement would always agree with itself.
    metric: prev?.metric ?? meta.metric ?? null,
    outcome: prev?.outcome ?? null,
  };
  rows.set(key, rec);
  await write(env, rows);
  return rec;
}

/**
 * Record the outcome of a taken suggestion — computed by the caller from the canon.
 *
 * ⚠️ The number never comes from the model. This is the same rule `numbersAreGrounded` enforces
 * for notifications, and it matters more here: «delivery is down 15%» is precisely the kind of
 * encouraging sentence a model will produce whether or not it is true.
 */
export async function setSuggestionOutcome(
  env: Env, key: string, outcome: NonNullable<AdviceSuggestion["outcome"]>,
): Promise<void> {
  const rows = await getSuggestionRecords(env);
  const rec = rows.get(key);
  if (!rec) return;
  rows.set(key, { ...rec, outcome });
  await write(env, rows);
}

/**
 * Merge what is remembered onto freshly generated suggestions, and tolerate advice written before
 * this existed (no `key`, no `state`).
 *
 * ⚠️ Done on the way OUT rather than at generation time, so a decision the user makes now shows on
 * advice that was generated an hour ago — the stored advice blob is not rewritten on every tap.
 */
export function normaliseSuggestions(
  raw: { title: string; detail: string; action?: AdviceSuggestion["action"] }[] | undefined,
  records: Map<string, SuggestionRecord>,
): AdviceSuggestion[] {
  return (raw ?? []).map((s) => {
    const key = suggestionKey(s.title);
    const rec = records.get(key);
    return {
      key,
      title: s.title,
      detail: s.detail,
      action: s.action ?? null,
      state: rec?.state ?? "open",
      state_at: rec?.state_at ?? null,
      metric: rec?.metric ?? null,
      outcome: rec?.outcome ?? null,
    };
  });
}

/**
 * §NOVELTY for advice — what the model is told it has already said.
 *
 * The feed's rule, applied to the adviser: repetition is cured by an EXPLICIT list of what was
 * already said, never by asking the model to «be interesting». A dismissed suggestion is the
 * sharpest case — the user has actively refused it, and offering it again unchanged is the app
 * arguing with a decision it recorded itself.
 */
export function alreadySuggested(records: Map<string, SuggestionRecord>, limit = 25): {
  title: string; state: SuggestionState; outcome_delta_pct?: number | null;
}[] {
  return [...records.values()]
    .sort((a, b) => b.state_at - a.state_at)
    .slice(0, limit)
    .map((r) => ({ title: r.title, state: r.state, outcome_delta_pct: r.outcome?.delta_pct ?? null }));
}

/**
 * Record suggestions the adviser has just made, WITHOUT touching decisions already taken.
 *
 * ⚠️ The insert-only rule is the whole point. `setSuggestionState` overwrites, and calling it here
 * would reset every dismissed suggestion to `open` on each generation — the app quietly undoing
 * the user's refusals and then re-offering what they refused, which is the exact behaviour this
 * store was added to stop.
 */
export async function rememberSuggestions(
  env: Env,
  items: { key: string; title: string; metric?: AdviceSuggestion["metric"] }[],
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const rows = await getSuggestionRecords(env);
  let added = 0;
  for (const it of items) {
    if (rows.has(it.key)) continue;
    rows.set(it.key, { key: it.key, title: it.title, state: "open", state_at: now, metric: it.metric ?? null, outcome: null });
    added++;
  }
  if (added) await write(env, rows);
}

/** A suggestion is not scored until a month has passed — anything sooner is noise, not an outcome. */
const SCORE_AFTER_DAYS = 25;

/**
 * §ADVICE-LOOP — score suggestions the user acted on, from the ledger.
 *
 * `levels` is the canon (`categoryMonthlyLevels`), handed in rather than fetched: the caller has
 * already computed it for the advice itself, and a second computation here could disagree with the
 * numbers in the very advice the score appears beside.
 *
 * ⚠️ Only `taken` and `done` are scored. Scoring a dismissed suggestion would be the app grading a
 * person on a plan they declined, and scoring an untouched one measures nothing at all.
 * ⚠️ The delta is signed the way a reader expects: NEGATIVE means the category costs less than
 * when the advice was written, i.e. the suggestion appears to have worked.
 */
export async function scoreTakenSuggestions(
  env: Env,
  levels: Map<number, { level: number }>,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const rows = await getSuggestionRecords(env);
  let changed = false;
  for (const rec of rows.values()) {
    if (rec.state !== "taken" && rec.state !== "done") continue;
    const m = rec.metric;
    if (!m || m.kind !== "category_month" || m.baseline <= 0) continue;
    if (now - m.at < SCORE_AFTER_DAYS * 86400) continue;
    const current = levels.get(m.category_id)?.level;
    if (current == null) continue;
    rows.set(rec.key, {
      ...rec,
      outcome: {
        delta_pct: Math.round(((current - m.baseline) / m.baseline) * 100),
        current,
        measured_at: now,
      },
    });
    changed = true;
  }
  if (changed) await write(env, rows);
}

/**
 * §ADVICE-LOOP — one round of the loop: remember what was said, then score what was acted on.
 *
 * Moved out of `advisor.ts` (C3, 2026-09-04) and the seam is the same one that put this file here:
 * that file answers «how is the user doing» out of one snapshot; this one keeps the ledger of what
 * the answer WAS and what came of it. `levels` is passed in rather than fetched — the outcome
 * printed beside a suggestion has to be measured against the same canon as the advice above it.
 *
 * ⚠️ **The category on a metric is validated against that canon before it is stored.** The model
 * supplies the id, and an id nothing matches would give a baseline that can never be compared to
 * anything. Same rule as `numbersAreGrounded`: the model may NAME a thing, code decides whether
 * it exists.
 * ⚠️ Scored AFTER the new ones are recorded, so a suggestion made a month ago gets its outcome on
 * the same pass that shows it — rather than one generation later, by which time the person has
 * stopped wondering.
 */
export async function recordAdviceRound(
  env: Env,
  suggestions: { title: string; action?: AdviceSuggestion["action"] }[],
  levels: Map<number, { level: number }>,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const fresh = suggestions.map((sg) => {
    const catId = sg.action?.category_id ?? null;
    const lv = catId != null ? levels.get(catId) : undefined;
    return {
      key: suggestionKey(sg.title),
      title: sg.title,
      metric: lv
        ? {
            kind: "category_month" as const,
            category_id: catId!,
            category_name: sg.action?.category_name ?? "",
            baseline: lv.level,
            at: now,
          }
        : null,
    };
  });
  await rememberSuggestions(env, fresh, now);
  await scoreTakenSuggestions(env, levels, now);
}
