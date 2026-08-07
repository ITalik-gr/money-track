import { useState } from "react";
import { useLocation } from "react-router";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { useGetFeedbackContactQuery, useSendFeedbackMutation, useGetMeQuery, type FeedbackKind } from "../../store/api.ts";

const MAX = 2000;

/**
 * The way back to the developer.
 *
 * Until now there was none: someone who hit a bug could only stop using the app, and the app
 * never learned it was broken for anyone but its author. That was tolerable while the users were
 * ten friends with a phone number; open registration (2026-07-31) ended it.
 *
 * Shown to demo visitors too, and that is the point — the person seeing this for the first time
 * is the one who notices what is confusing, and a form that opens only after sign-up collects
 * reports from people who already got past the part that stopped everyone else.
 *
 * The mail address underneath is not decoration: a form has a size limit and no attachments, and
 * "here is a screenshot of what happened" is the most useful report there is. It comes from the
 * server (`OWNER_EMAIL`), never from a constant here — this repository is public.
 */
export function FeedbackCard() {
  const t = useT();
  const { pathname } = useLocation();
  const { data: me } = useGetMeQuery();
  const { data: contact } = useGetFeedbackContactQuery();
  const [send, state] = useSendFeedbackMutation();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  // A signed-in sender's address comes from their account, so asking for it again would be a
  // field with a wrong answer available. A demo visitor has no account — for them it is the only
  // way an answer could ever come back, and it stays optional.
  const anonymous = me?.demo === true || !me?.authenticated;

  async function submit() {
    const text = message.trim();
    if (text.length < 3) return;
    try {
      await send({ kind, message: text.slice(0, MAX), page: pathname, ...(anonymous && email.trim() ? { email: email.trim() } : {}) }).unwrap();
      setMessage("");
      setSent(true);
      toast.success(t("feedback.thanks"));
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="advisor" size={16} />{t("feedback.title")}</div>
      <p className="set-card-sub">{t("feedback.sub")}</p>

      <div className="stack" style={{ marginTop: 12 }}>
        <Select
          value={kind}
          onChange={(v) => setKind(v as FeedbackKind)}
          options={[
            { value: "bug", label: t("feedback.kindBug") },
            { value: "idea", label: t("feedback.kindIdea") },
            { value: "other", label: t("feedback.kindOther") },
          ]}
        />
        <textarea
          className="fb-text"
          rows={4}
          maxLength={MAX}
          placeholder={t("feedback.placeholder")}
          value={message}
          onChange={(e) => { setMessage(e.target.value); setSent(false); }}
        />
        {anonymous && (
          <input
            className="fb-email"
            type="email"
            placeholder={t("feedback.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        <button className="btn primary" disabled={state.isLoading || message.trim().length < 3} onClick={submit}>
          {state.isLoading ? t("feedback.sending") : t("feedback.send")}
        </button>
        {/* Не зникає після успіху: людина, яка щойно надіслала одне, часто згадує друге. */}
        {sent && <div className="muted" style={{ fontSize: 12.5 }}>{t("feedback.sentNote")}</div>}
        {contact?.email && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {t("feedback.orMail")} <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </div>
        )}
      </div>
    </div>
  );
}
