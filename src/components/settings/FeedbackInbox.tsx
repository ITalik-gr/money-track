import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useGetAdminFeedbackQuery, useMarkFeedbackHandledMutation, useDiscountDemoVisitsMutation } from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayLabel = dateFmt({ day: "numeric", month: "short" });

/**
 * Owner-only: what people wrote, and how many of them opened the demo.
 *
 * One card for both because they answer one question together — "is anyone out there, and did
 * they have anything to say". Separately, a visit count is a vanity number and an empty inbox
 * means nothing; side by side, "40 demos, zero messages" is information.
 *
 * ⚠️ Everything here is about OTHER people, which is why it lives behind the owner gate and
 * nowhere else. The visit tally is deliberately just a count per day: no fingerprint, no
 * referrer, no location. It answers "how many", which is the whole question, and cannot be
 * turned into "who".
 */
export function FeedbackInbox() {
  const t = useT();
  const { data, isError, error, refetch } = useGetAdminFeedbackQuery();
  const [mark] = useMarkFeedbackHandledMutation();
  const [discount] = useDiscountDemoVisitsMutation();

  const days = data?.demo_days ?? [];
  const peak = Math.max(1, ...days.map((d) => d.sandboxes));
  const total = days.reduce((s, d) => s + d.sandboxes, 0);

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="bell" size={16} />{t("feedback.inboxTitle")}</div>
      <p className="set-card-sub">{t("feedback.inboxSub")}</p>

      {isError && <ErrorNote error={error} what={t("feedback.inboxTitle")} onRetry={refetch} />}

      <div className="fb-demo">
        <div className="fb-demo-h">
          <span>{t("feedback.demoTitle")}</span>
          {days.length > 0 && <span className="muted">{total} · {t("feedback.demoTotal", { n: days.length })}</span>}
        </div>
        {days.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>{t("feedback.demoEmpty")}</div>
        ) : (
          // Newest first is how the list arrives and how it is read, so the row is not reversed
          // into a chronological chart: this is a log with a bar for scale, not a trend line.
          <div className="fb-demo-rows">
            {days.slice(0, 30).map((d) => (
              <div key={d.day} className="fb-demo-row">
                <span className="fb-demo-day">{dayLabel.format(new Date(`${d.day}T12:00:00`))}</span>
                <span className="fb-demo-bar"><span style={{ width: `${(d.sandboxes / peak) * 100}%` }} /></span>
                <span className="fb-demo-n">{d.sandboxes}</span>
                {/* The owner opens the sandbox constantly while testing, so the one number meant
                    to answer "is anyone out there" is largely noise they made themselves.
                    Subtracting one is a correction, not a delete: a day usually holds both their
                    visits and real ones. */}
                <button
                  className="fb-demo-minus"
                  title={t("feedback.demoDiscount")}
                  aria-label={t("feedback.demoDiscount")}
                  onClick={() => void discount({ day: d.day })}
                >−</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="fb-list">
        {(data?.feedback ?? []).length === 0 && !isError && (
          <div className="muted" style={{ fontSize: 12.5 }}>{t("feedback.inboxEmpty")}</div>
        )}
        {(data?.feedback ?? []).map((f) => (
          <div key={f.id} className={`fb-item ${f.handled_at ? "handled" : ""}`}>
            <div className="fb-item-h">
              <span className={`fb-kind ${f.kind}`}>{t(`feedback.kind${f.kind === "bug" ? "Bug" : f.kind === "idea" ? "Idea" : "Other"}`)}</span>
              <span className="fb-from">{f.email ?? t("feedback.anonymous")}</span>
              <span className="fb-when">{when.format(new Date(f.created_at * 1000))}</span>
            </div>
            <div className="fb-msg">{f.message}</div>
            <div className="fb-item-f">
              {f.page && <span className="muted">{f.page}</span>}
              <button
                className="btn ghost sm"
                onClick={async () => {
                  try { await mark({ id: f.id, on: !f.handled_at }).unwrap(); }
                  catch (e) { alert(errText(e)); }
                }}
              >
                {f.handled_at ? t("feedback.markUnhandled") : t("feedback.markHandled")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
