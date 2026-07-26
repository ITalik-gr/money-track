import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import {
  useBackfillStartMutation,
  useBackfillStepMutation,
  useGetSetupStatusQuery,
  useRefreshRatesMutation,
  useRegisterWebhookMutation,
  useSyncAccountsMutation,
  type SetupStatus,
} from "../../store/api.ts";

/**
 * First run — the four things that have to happen once before the app has anything to show.
 *
 * What was wrong before (user feedback, 2026-07-26): four unlabelled buttons in a card, which a
 * new user had to guess they must press, IN ORDER. Skip one and the account simply stays empty —
 * indistinguishable from a broken product. Nothing said what a step did, and nothing said whether
 * it had already been done.
 *
 * Three changes, in order of importance:
 *
 *   1. **It runs itself.** One button walks the chain. Each step is still individually clickable,
 *      because "run everything" is the wrong tool when one step failed and you want to retry only
 *      that one.
 *   2. **Completed steps are marked, from real state** — not from a "we ran it" flag. Every step
 *      derives `done` from an observable fact in `/setup/status` (accounts exist, the webhook is
 *      registered, transactions exist, rates are cached). A flag would keep claiming success after
 *      the thing it describes stopped being true.
 *   3. **Each step says what it does and what it costs**, since two of them touch an external bank
 *      and one of them spends real money on AI enrichment.
 *
 * Backfill is the reason this orchestration lives on the client rather than in one server call:
 * monobank allows one statement request per 60 seconds, so it is a sequence of ticks spread over
 * minutes, not a request. The chain therefore starts it and returns; the ticking continues here.
 */
const STEP_INTERVAL_MS = 60_000;

type StepId = "accounts" | "webhook" | "backfill" | "rates";
type RunState = { active: StepId | null; failed: StepId | null };

export function FirstRun() {
  const t = useT();
  const { data: status } = useGetSetupStatusQuery(undefined, { pollingInterval: 5000 });
  const [syncAccounts] = useSyncAccountsMutation();
  const [registerWebhook] = useRegisterWebhookMutation();
  const [refreshRates] = useRefreshRatesMutation();
  const [backfillStart] = useBackfillStartMutation();
  const [backfillStep] = useBackfillStepMutation();

  const [run, setRun] = useState<RunState>({ active: null, failed: null });
  const [chaining, setChaining] = useState(false);
  const [progress, setProgress] = useState<{ progress: number; total: number } | null>(null);
  const timer = useRef<number | null>(null);

  const done = doneMap(status);
  const allDone = STEPS.every((s) => done[s.id]);
  const busy = run.active !== null;

  /**
   * Backfill: start, then tick on monobank's 60s rhythm. Resolves as soon as the FIRST page is in
   * — the chain must not block for the minutes the rest takes, and the remaining pages keep
   * arriving in the background while the user reads the next step.
   */
  async function runBackfill() {
    const started = await backfillStart().unwrap();
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
    if (timer.current == null) timer.current = window.setInterval(tick, STEP_INTERVAL_MS);
  }

  const RUNNERS: Record<StepId, () => Promise<unknown>> = {
    accounts: () => syncAccounts().unwrap(),
    webhook: () => registerWebhook().unwrap(),
    backfill: runBackfill,
    rates: () => refreshRates().unwrap(),
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

  /** The whole chain, skipping what is already done. Stops at the first failure — every later
   *  step depends on an earlier one, so continuing past a break just produces more errors. */
  async function runAll() {
    setChaining(true);
    for (const s of STEPS) {
      if (done[s.id]) continue;
      const ok = await runStep(s.id);
      if (!ok) break;
    }
    setChaining(false);
  }

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="repeat" size={16} />{t("setup.firstRun")}</div>
      <p className="set-card-sub">{allDone ? t("setup.firstRunAllDone") : t("setup.firstRunSub")}</p>

      {!allDone && (
        <button className="btn primary fr-run-all" onClick={runAll} disabled={busy || chaining}>
          <Icon name="spark" size={15} />
          {chaining ? t("setup.firstRunRunning") : t("setup.firstRunRunAll")}
        </button>
      )}

      <ol className="fr-list">
        {STEPS.map((s, i) => {
          const isDone = done[s.id];
          const isActive = run.active === s.id;
          return (
            <li key={s.id} className={`fr-step${isDone ? " done" : ""}${run.failed === s.id ? " failed" : ""}`}>
              <span className="fr-mark" aria-hidden="true">
                {isDone ? <Icon name="check" size={13} /> : i + 1}
              </span>
              <div className="fr-body">
                <span className="fr-title">{t(s.titleKey)}</span>
                <span className="fr-desc">{t(s.descKey)}</span>
                {s.id === "backfill" && progress && progress.progress < progress.total && (
                  <span className="fr-desc">{t("setup.backfillNote")} — {progress.progress}/{progress.total}</span>
                )}
              </div>
              <span className="fr-action">
                {isDone
                  ? <button className="btn ghost sm" disabled={busy} onClick={() => void runStep(s.id)}>{t("setup.stepRepeat")}</button>
                  : <button className="btn sm" disabled={busy} onClick={() => void runStep(s.id)}>{isActive ? "…" : t("setup.stepRun")}</button>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STEPS: { id: StepId; titleKey: TitleKey; descKey: DescKey }[] = [
  { id: "accounts", titleKey: "setup.step1", descKey: "setup.step1Desc" },
  { id: "webhook", titleKey: "setup.step2", descKey: "setup.step2Desc" },
  { id: "backfill", titleKey: "setup.step3", descKey: "setup.step3Desc" },
  { id: "rates", titleKey: "setup.refreshRates", descKey: "setup.refreshRatesDesc" },
];

type TitleKey = "setup.step1" | "setup.step2" | "setup.step3" | "setup.refreshRates";
type DescKey = "setup.step1Desc" | "setup.step2Desc" | "setup.step3Desc" | "setup.refreshRatesDesc";

/**
 * "Done" is read from observable state, never from a local flag — see the component comment.
 * `transactions > 0` covers the legacy-import path too: someone who moved an existing history in
 * has no backfill cursor, and telling them to backfill an account that already has data would be
 * both wrong and expensive.
 */
function doneMap(s: SetupStatus | undefined): Record<StepId, boolean> {
  return {
    accounts: (s?.accounts ?? 0) > 0,
    webhook: s?.webhookRegistered === true,
    backfill: s?.backfill?.done === true || (s?.transactions ?? 0) > 0,
    rates: (s?.rates ?? 0) > 0,
  };
}
