/**
 * §EVENT-GOAL — the goal an event was saving toward, and whether the saving covered it.
 *
 * The two halves of one plan used to live in separate tables with nothing between them: a "Japan"
 * goal filling up, and a "Japan" event filling up with spending. The app could show each of them
 * and could not say they were the same undertaking, so the only question that matters afterwards —
 * "did what I put aside actually cover it" — was arithmetic left to the person.
 *
 * ⚠️ The verdict is stated in WORDS, not only as two numbers side by side. "Відклав 70 000,
 * витратив 61 000" still asks the reader to subtract; "вистачило, лишилось 9 000" is the answer
 * they came for. The numbers stay visible underneath, because a verdict with no figures behind it
 * is not checkable.
 *
 * ⚠️ Deliberately NO progress bar. It would be the third bar on this page (the event budget has
 * one, the goal card has one) and it would mean a different thing from both — this is a comparison
 * of two finished quantities, not consumption of a limit.
 */
import { useGetGoalsQuery, useSetEventGoalMutation } from "../../store/api.ts";
import { Select } from "../ui/Select.tsx";
import { Money } from "../ui/Money.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { useT } from "../../i18n/index.ts";

export function EventGoalLink(
  { id, spent, goalId }: { id: number; spent: number; goalId: number | null | undefined },
) {
  const t = useT();
  const { data: goals = [] } = useGetGoalsQuery();
  const [setGoal, { isLoading }] = useSetEventGoalMutation();
  const goal = goalId == null ? null : goals.find((g) => g.id === goalId) ?? null;

  async function pick(v: string | number | null) {
    try {
      // An empty option is the unlink, so anything falsy becomes an explicit `null` rather than 0.
      await setGoal({ id, goal_id: v ? Number(v) : null }).unwrap();
    } catch (e) { toast.error(errText(e)); }
  }

  // Nothing to link to and nothing linked: the block would be a control for a feature the account
  // cannot use yet, which is worse than its absence.
  if (!goals.length && goal == null) return null;

  // `current` is the goal's canonical progress — a jar reports its account balance, a manual goal
  // its contributions. Reading `current_amount` directly here would disagree with the goal card
  // for every jar-backed goal.
  const saved = goal?.current ?? 0;
  const covered = goal != null && spent <= saved;
  const diff = Math.abs(saved - spent);

  return (
    <div className="card evt-goal">
      <div className="evt-goal-head">
        <span className="label">{t("evtGoal.title")}</span>
        <Select
          value={goalId == null ? "" : String(goalId)}
          onChange={pick}
          disabled={isLoading}
          options={[
            { value: "", label: t("evtGoal.none") },
            ...goals.map((g) => ({ value: String(g.id), label: g.name, color: g.color })),
          ]}
        />
      </div>

      {goal && (
        <>
          <p className={`evt-goal-verdict ${covered ? "ok" : "over"}`}>
            {covered
              ? t("evtGoal.covered", { amount: "" })
              : t("evtGoal.short", { amount: "" })}
            {" "}<b><Money minor={diff} decimals={false} /></b>
          </p>
          <div className="evt-goal-nums">
            <span>{t("evtGoal.saved")} <b><Money minor={saved} decimals={false} /></b></span>
            <span>{t("evtGoal.spent")} <b><Money minor={spent} decimals={false} /></b></span>
          </div>
        </>
      )}
    </div>
  );
}
