import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import {
  useBackfillStartMutation,
  useBackfillStepMutation,
  useGetCredentialsQuery,
  useGetSetupStatusQuery,
  useRefreshRatesMutation,
  useRegisterWebhookMutation,
  useSyncAccountsMutation,
  type SetupStatus,
} from "../../store/api.ts";

/**
 * First run — the things that have to happen once before the app has anything to show.
 *
 * What was wrong before (user feedback, 2026-07-26): four unlabelled buttons in a card, which a
 * new user had to guess they must press, IN ORDER. Skip one and the account simply stays empty —
 * indistinguishable from a broken product. Nothing said what a step did, and nothing said whether
 * it had already been done. That was fixed by naming the steps and deriving "done" from state.
 *
 * What was still wrong (2026-08-08, once registration opened): the list assumed monobank. Three of
 * its four steps call the bank, and with no token they all failed with a raw API error — the first
 * thing a stranger saw after signing up was four red toasts. And the list could never be
 * finished by someone who has no monobank at all, so the dashboard nagged them forever about a
 * setup that was, for them, already as complete as it gets.
 *
 * So the list now models the two facts it was ignoring:
 *
 *   1. **A step can be BLOCKED.** The bank steps need a token; without one they are disabled and
 *      say so, pointing at the card that takes it. A button that is going to fail should not be a
 *      button — that is a promise the product cannot keep.
 *   2. **A step can be NOT APPLICABLE.** Someone whose data arrived by CSV import or by hand has
 *      no bank to sync, no webhook to register and nothing to backfill. Those steps are struck
 *      out and excluded from the count, so the checklist can honestly reach the end.
 *
 * The other two rules from before still hold, and are why this is trustworthy at all:
 * **completed steps are read from observable state** (accounts exist, rates are cached, the
 * profile is non-empty) rather than from a "we ran it" flag that keeps claiming success after the
 * thing it describes stopped being true; and **each step says what it does and what it costs**,
 * since two touch an external bank and one spends real money on AI.
 *
 * Backfill is the reason this orchestration lives on the client rather than in one server call:
 * monobank allows one statement request per 60 seconds, so it is a sequence of ticks spread over
 * minutes, not a request. The chain therefore starts it and returns; the ticking continues here.
 */
/** Fallback only. The real gap belongs to the BANK and comes back on the response (`next_in_ms`). */
const STEP_INTERVAL_MS = 60_000;

type StepId = "accounts" | "webhook" | "backfill" | "rates" | "profile";
type StepState = "done" | "todo" | "blocked" | "skipped";
type RunState = { active: StepId | null; failed: StepId | null };

export function FirstRun() {
  const t = useT();
  const { data: status } = useGetSetupStatusQuery(undefined, { pollingInterval: 5000 });
  const { data: creds } = useGetCredentialsQuery();
  const [syncAccounts] = useSyncAccountsMutation();
  const [registerWebhook] = useRegisterWebhookMutation();
  const [refreshRates] = useRefreshRatesMutation();
  const [backfillStart] = useBackfillStartMutation();
  const [backfillStep] = useBackfillStepMutation();

  const [run, setRun] = useState<RunState>({ active: null, failed: null });
  const [chaining, setChaining] = useState(false);
  const [progress, setProgress] = useState<{ progress: number; total: number } | null>(null);
  const timer = useRef<number | null>(null);
  // The bank's own pacing, learned from the first response. A ref rather than state: changing it
  // must not re-render, and the interval reads it once when it is created.
  const gap = useRef<number>(STEP_INTERVAL_MS);

  // `available`, not `set`: the owner's token comes from the deployment secrets and writes no
  // `user_secrets` row, so gating on `set` would tell them to add a key that already works.
  const bank = creds?.secrets.find((s) => s.name === "mono_token")?.available === true;
  const state = stepStates(status, bank, creds != null);
  const applicable = STEPS.filter((s) => state[s.id] !== "skipped");
  const doneCount = applicable.filter((s) => state[s.id] === "done").length;
  const allDone = doneCount === applicable.length;
  const busy = run.active !== null;

  /**
   * Backfill: start, then tick on the rhythm the SERVER reports (`next_in_ms`) — one statement a
   * minute is monobank's limit, not a universal one, and the client cannot know which bank it is
   * reading. Resolves as soon as the FIRST page is in
   * — the chain must not block for the minutes the rest takes, and the remaining pages keep
   * arriving in the background while the user reads the next step.
   */
  async function runBackfill() {
    const started = await backfillStart().unwrap();
    gap.current = started.next_in_ms ?? STEP_INTERVAL_MS;
    setProgress({ progress: 0, total: started.total });
    const tick = async () => {
      try {
        const r = await backfillStep().unwrap();
        setProgress({ progress: r.progress, total: r.total });
        if (r.done && timer.current) { window.clearInterval(timer.current); timer.current = null; }
      } catch (e) {
        // A failed tick must stop the interval, or it retries forever against a broken token.
        if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
        toast.error(errText(e));
      }
    };
    await tick();
    if (timer.current == null) timer.current = window.setInterval(tick, gap.current);
  }

  const RUNNERS: Record<StepId, () => Promise<unknown>> = {
    accounts: () => syncAccounts().unwrap(),
    webhook: () => registerWebhook().unwrap(),
    backfill: runBackfill,
    rates: () => refreshRates().unwrap(),
    // Nothing to run: the profile is written by a human in the field above. The step exists to
    // say it is there at all — it was the one setup step nothing on any screen mentioned.
    profile: async () => {},
  };

  async function runStep(id: StepId): Promise<boolean> {
    setRun({ active: id, failed: null });
    try {
      await RUNNERS[id]();
      setRun({ active: null, failed: null });
      return true;
    } catch (e) {
      setRun({ active: null, failed: id });
      toast.error(errText(e));
      return false;
    }
  }

  /** The whole chain, skipping what is done, not applicable, or blocked. Stops at the first
   *  failure — every later step depends on an earlier one, so continuing past a break just
   *  produces more errors. */
  async function runAll() {
    setChaining(true);
    for (const s of STEPS) {
      if (state[s.id] !== "todo" || !s.runnable) continue;
      const ok = await runStep(s.id);
      if (!ok) break;
    }
    setChaining(false);
  }

  const runnableTodo = STEPS.some((s) => s.runnable && state[s.id] === "todo");

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="repeat" size={16} />{t("setup.firstRun")}</div>
      <p className="set-card-sub">{allDone ? t("setup.firstRunAllDone") : t("setup.firstRunSub")}</p>

      {/* Прогрес як ЧИСЛО й смуга. «Три кроки з п'яти» — це відповідь на питання «мені ще довго?»,
          на яке список галочок відповідає лише після того, як його перерахують очима. */}
      <div className="fr-progress">
        <div className="fr-progress-bar"><span style={{ width: `${(doneCount / Math.max(1, applicable.length)) * 100}%` }} /></div>
        <span className="fr-progress-n">{t("setup.progressOf", { done: doneCount, total: applicable.length })}</span>
      </div>

      {!allDone && runnableTodo && (
        <button className="btn primary fr-run-all" onClick={runAll} disabled={busy || chaining}>
          <Icon name="spark" size={15} />
          {chaining ? t("setup.firstRunRunning") : t("setup.firstRunRunAll")}
        </button>
      )}

      <ol className="fr-list">
        {STEPS.map((s, i) => {
          const st = state[s.id];
          const isActive = run.active === s.id;
          return (
            <li key={s.id} className={`fr-step ${st}${run.failed === s.id ? " failed" : ""}`}>
              <span className="fr-mark" aria-hidden="true">
                {st === "done" ? <Icon name="check" size={13} /> : st === "skipped" ? "–" : i + 1}
              </span>
              <div className="fr-body">
                <span className="fr-title">{t(s.titleKey)}</span>
                <span className="fr-desc">{t(s.descKey)}</span>
                {/* Чому крок недоступний — на самому кроці, а не тостом після кліку. */}
                {st === "blocked" && (
                  <span className="fr-note">{t("setup.needsBankKey")}</span>
                )}
                {st === "skipped" && <span className="fr-note">{t("setup.notApplicable")}</span>}
                {s.id === "backfill" && progress && progress.progress < progress.total && (
                  <span className="fr-desc">{t("setup.backfillNote")} — {progress.progress}/{progress.total}</span>
                )}
              </div>
              <span className="fr-action">
                {st === "done" && s.runnable && (
                  <button className="btn ghost sm" disabled={busy} onClick={() => void runStep(s.id)}>{t("setup.stepRepeat")}</button>
                )}
                {st === "todo" && s.runnable && (
                  <button className="btn sm" disabled={busy} onClick={() => void runStep(s.id)}>{isActive ? "…" : t("setup.stepRun")}</button>
                )}
                {/* Крок без кнопки веде туди, де його роблять руками — інакше він лише констатує. */}
                {st === "todo" && !s.runnable && s.to && (
                  <Link className="btn sm" to={s.to}>{t("setup.stepOpen")}</Link>
                )}
                {st === "blocked" && (
                  <Link className="btn ghost sm" to="/setup?tab=data">{t("setup.addKey")}</Link>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STEPS: { id: StepId; titleKey: TitleKey; descKey: DescKey; runnable: boolean; needsBank?: boolean; to?: string }[] = [
  { id: "accounts", titleKey: "setup.step1", descKey: "setup.step1Desc", runnable: true, needsBank: true },
  { id: "webhook", titleKey: "setup.step2", descKey: "setup.step2Desc", runnable: true, needsBank: true },
  { id: "backfill", titleKey: "setup.step3", descKey: "setup.step3Desc", runnable: true, needsBank: true },
  { id: "rates", titleKey: "setup.refreshRates", descKey: "setup.refreshRatesDesc", runnable: true },
  { id: "profile", titleKey: "setup.stepProfile", descKey: "setup.stepProfileDesc", runnable: false, to: "/setup?tab=account" },
];

type TitleKey = "setup.step1" | "setup.step2" | "setup.step3" | "setup.refreshRates" | "setup.stepProfile";
type DescKey = "setup.step1Desc" | "setup.step2Desc" | "setup.step3Desc" | "setup.refreshRatesDesc" | "setup.stepProfileDesc";

/**
 * The state of every step, read from observable facts — never from a local "we ran it" flag.
 *
 * `transactions > 0` covers the legacy-import path too: someone who moved an existing history in
 * has no backfill cursor, and telling them to backfill an account that already has data would be
 * both wrong and expensive.
 *
 * The bank branch is the part worth reading twice. With no token:
 *   • and no data yet → the bank steps are BLOCKED (they would fail; the user needs the key first);
 *   • but data already present (CSV import, manual accounts) → they are SKIPPED, because there is
 *     no bank in this person's setup and a checklist that can never be completed is just a nag.
 * `credsLoaded` keeps the list from flashing "blocked" during the first render, when we do not yet
 * know whether there is a key — a wrong claim that corrects itself is worse than a slow one.
 */
function stepStates(s: SetupStatus | undefined, bank: boolean, credsLoaded: boolean): Record<StepId, StepState> {
  const hasData = (s?.transactions ?? 0) > 0 || (s?.accounts ?? 0) > 0;
  const bankStep = (done: boolean): StepState => {
    if (done) return "done";
    if (!credsLoaded || bank) return "todo";
    return hasData ? "skipped" : "blocked";
  };
  return {
    accounts: bankStep((s?.accounts ?? 0) > 0),
    webhook: bankStep(s?.webhookRegistered === true),
    backfill: bankStep(s?.backfill?.done === true || (s?.transactions ?? 0) > 0),
    rates: (s?.rates ?? 0) > 0 ? "done" : "todo",
    profile: s?.profileSet ? "done" : "todo",
  };
}
