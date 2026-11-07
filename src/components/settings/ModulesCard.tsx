/**
 * §BIZ-SPLIT — the business / ФОП switches, reachable from Settings → General.
 *
 * The same `BizSwitches` the business page shows (one component, so the two places cannot
 * disagree about what the switches do). Rendered only for the owner: the module is §FOP-GATE'd,
 * and for anyone else the profile endpoint answers 404.
 */
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { BizSwitches } from "../fop/BizSwitches.tsx";
import { useGetTaxStatusQuery, useUpdateTaxProfileMutation } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";

export function ModulesCard() {
  const t = useT();
  const { data, error, refetch } = useGetTaxStatusQuery();
  const [update, { isLoading }] = useUpdateTaxProfileMutation();
  if (error) return <ErrorNote error={error} what={t("fop.whatWeTrack")} onRetry={refetch} />;
  return <BizSwitches profile={data?.profile} onSave={update} saving={isLoading || !data} />;
}
