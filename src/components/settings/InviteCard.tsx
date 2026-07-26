import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getLocale, localeTag } from "../../i18n/locale.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetAdminUsersQuery, useInviteUserMutation, useSetUserStatusMutation } from "../../store/api.ts";

/**
 * Owner-only user administration (D2).
 *
 * The invite-only whitelist has been enforced server-side since P0.1, but it had no interface at
 * all: inviting a person meant issuing `POST /api/admin/users/invite` by hand. A gate that only
 * its author can operate is not a working feature of the product — it is a curl command with a
 * deployment attached. Everything here maps 1:1 onto endpoints that already existed.
 *
 * Disabling rather than deleting is the default action offered: a disabled user loses API access
 * within ~60s (`userAccess`) while their Durable Object stays intact, so the decision is
 * reversible. Erasure is deliberately NOT wired to a one-click button here — `DELETE
 * /api/admin/users/:id` drops a person's entire financial history, and that belongs behind the
 * same kind of typed confirmation the account owner gets, not next to a status toggle.
 */
export function InviteCard() {
  const t = useT();
  const { data, isError, error } = useGetAdminUsersQuery();
  const [invite, inviteState] = useInviteUserMutation();
  const [setStatus, statusState] = useSetUserStatusMutation();
  const [email, setEmail] = useState("");

  async function send() {
    const value = email.trim();
    if (!value) return;
    try {
      await invite(value).unwrap();
      setEmail("");
      toast.success(t("admin.invited", { email: value }));
    } catch (e) {
      toast.error(errText(e));
    }
  }

  const users = data?.users ?? [];

  return (
    <div className="card set-card set-full">
      <div className="set-card-h"><Icon name="accounts" size={16} />{t("admin.title")}</div>
      <p className="set-card-sub">{t("admin.sub")}</p>

      <div className="row" style={{ gap: 8 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder={t("admin.emailPlaceholder")}
          style={{ flex: 1 }}
        />
        <button className="btn primary" disabled={inviteState.isLoading || !email.trim()} onClick={send}>
          {inviteState.isLoading ? "…" : t("admin.invite")}
        </button>
      </div>
      {/* Says what actually happens next, because nothing visible happens after an invite: no
          email is sent. Without this the owner waits for a delivery that will never occur. */}
      <p className="set-card-sub" style={{ marginTop: 10 }}>{t("admin.inviteHint")}</p>

      {isError && <p className="set-card-sub" style={{ color: "var(--neg)" }}>{errText(error)}</p>}

      {users.length > 0 && (
        <ul className="adm-list">
          {users.map((u) => (
            <li key={u.id} className="adm-row">
              <div className="adm-who">
                <span className="adm-email">{u.email}</span>
                <span className="adm-meta">
                  {u.name ? `${u.name} · ` : ""}
                  {u.last_login_at ? t("admin.lastLogin", { date: dfmt(u.last_login_at) }) : t("admin.neverSignedIn")}
                </span>
              </div>
              <span className={`adm-status ${u.status}`}>{t(STATUS_KEY[u.status] ?? "admin.statusInvited")}</span>
              {/* The owner cannot lock themselves out: the server refuses it too
                  (`cannot_disable_owner`), but a button that only ever errors is still a lie. */}
              {!u.is_owner && (
                <button
                  className="btn ghost sm"
                  disabled={statusState.isLoading}
                  onClick={async () => {
                    const next = u.status === "disabled" ? "active" : "disabled";
                    try { await setStatus({ id: u.id, status: next }).unwrap(); } catch (e) { toast.error(errText(e)); }
                  }}
                >
                  {u.status === "disabled" ? t("admin.enable") : t("admin.disable")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_KEY: Record<string, "admin.statusActive" | "admin.statusInvited" | "admin.statusDisabled"> = {
  active: "admin.statusActive",
  invited: "admin.statusInvited",
  disabled: "admin.statusDisabled",
};

// Через `localeTag`, а не голий `toLocaleDateString()`: інакше дата йде в мові СИСТЕМИ, а не в
// обраній мові застосунку (§i18n — теги локалі живуть лише в `locale.ts`).
function dfmt(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(localeTag(getLocale()));
}
