import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getLocale, localeTag } from "../../i18n/locale.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import {
  useGetAdminUsersQuery, useInviteUserMutation, useSetUserStatusMutation,
  useRefreshAdminStatsMutation, type AdminUser,
} from "../../store/api.ts";

/**
 * Owner-only user administration.
 *
 * Was an invite form with a bare list of emails, which was enough while the door was shut and
 * the owner knew everyone personally. Registration opened on 2026-07-31, so the question changed
 * from "who did I invite?" to "who signed up, are they actually using it, and did they add their
 * own keys?" — the last one matters because without an Anthropic key half the product is dark
 * for them, and that looks like a broken app rather than a missing setting.
 *
 * ⚠️ Volume only. Counts of transactions and accounts, never balances, spending or categories:
 * the owner administers accounts, they do not read other people's finances (see the note in
 * migration `0004_user_stats.sql`).
 *
 * Disabling rather than deleting is the action offered here: a disabled user loses API access
 * within ~60s (`userAccess`) while their Durable Object stays intact, so it is reversible.
 * Erasure stays off this screen on purpose — `DELETE /api/admin/users/:id` drops a person's
 * whole financial history and belongs behind a typed confirmation, not next to a toggle.
 */
export function UsersCard() {
  const t = useT();
  const { data, isError, error } = useGetAdminUsersQuery();
  const [invite, inviteState] = useInviteUserMutation();
  const [setStatus, statusState] = useSetUserStatusMutation();
  const [refresh, refreshState] = useRefreshAdminStatsMutation();
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
  const open = data?.signup !== "invite";
  const active = users.filter((u) => u.status === "active").length;
  const withAi = users.filter((u) => u.has_ai_key).length;

  return (
    <div className="card set-card set-full">
      <div className="set-card-h">
        <Icon name="accounts" size={16} />{t("admin.title")}
        <button className="btn ghost sm" style={{ marginLeft: "auto" }} disabled={refreshState.isLoading}
          onClick={async () => {
            try {
              const r = await refresh().unwrap();
              toast.success(t("admin.statsRefreshed", { n: r.updated }));
              if (r.failed.length) toast.error(r.failed.join(" | "));
            } catch (e) { toast.error(errText(e)); }
          }}>
          {refreshState.isLoading ? "…" : t("admin.refreshStats")}
        </button>
      </div>

      {/* States the CURRENT policy rather than describing the feature: with an open door the
          owner needs to know at a glance that strangers can arrive, and where the switch is. */}
      <p className="set-card-sub">
        {open ? t("admin.signupOpen") : t("admin.signupInvite")}
      </p>

      <div className="adm-summary">
        <span><b>{users.length}</b> {t("admin.sumTotal")}</span>
        <span><b>{active}</b> {t("admin.sumActive")}</span>
        <span><b>{withAi}</b> {t("admin.sumWithAi")}</span>
      </div>

      {/* The invite form stays even with open signup: it is how the owner pre-creates a row for
          someone, and the only interface at all when SIGNUP=invite. */}
      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder={t("admin.emailPlaceholder")}
          style={{ flex: 1 }}
        />
        <button className="btn" disabled={inviteState.isLoading || !email.trim()} onClick={send}>
          {inviteState.isLoading ? "…" : t("admin.invite")}
        </button>
      </div>
      {/* Says what actually happens next, because nothing visible happens after an invite: no
          email is sent. Without this the owner waits for a delivery that will never occur. */}
      <p className="set-card-sub" style={{ marginTop: 10 }}>{t("admin.inviteHint")}</p>

      {isError && <p className="set-card-sub" style={{ color: "var(--neg)" }}>{errText(error)}</p>}

      {users.length > 0 && (
        <ul className="adm-list">
          {users.map((u) => <Row key={u.id} u={u} busy={statusState.isLoading} onToggle={setStatus} />)}
        </ul>
      )}
    </div>
  );
}

function Row({ u, busy, onToggle }: {
  u: AdminUser;
  busy: boolean;
  onToggle: (a: { id: string; status: "active" | "disabled" }) => { unwrap: () => Promise<unknown> };
}) {
  const t = useT();
  return (
    <li className="adm-row">
      <div className="adm-who">
        <span className="adm-email">
          {u.email}
          {u.is_owner && <span className="adm-tag owner">{t("admin.tagOwner")}</span>}
        </span>
        <span className="adm-meta">
          {u.name ? `${u.name} · ` : ""}
          {/* "Last seen" beats "last login" for the only question being asked. Falls back to the
              login date while 0004's counters are still unreported for an old account. */}
          {u.last_seen_at
            ? t("admin.lastSeen", { date: dfmt(u.last_seen_at) })
            : u.last_login_at
              ? t("admin.lastLogin", { date: dfmt(u.last_login_at) })
              : t("admin.neverSignedIn")}
        </span>
        <span className="adm-facts">
          {/* `null` — the object has not reported yet — is shown as an em dash, not as 0.
              "Unknown" and "empty" are different facts and the second one accuses the user. */}
          <span className="adm-fact">
            <Icon name="tx" size={12} />{u.tx_count == null ? "—" : u.tx_count}
          </span>
          <span className="adm-fact">
            <Icon name="accounts" size={12} />{u.accounts_count == null ? "—" : u.accounts_count}
          </span>
          <KeyChip on={u.has_ai_key} label={t("admin.keyAi")} />
          <KeyChip on={u.has_mono_key} label={t("admin.keyBank")} />
        </span>
      </div>
      <span className={`adm-status ${u.status}`}>{t(STATUS_KEY[u.status] ?? "admin.statusInvited")}</span>
      {/* The owner cannot lock themselves out: the server refuses it too
          (`cannot_disable_owner`), but a button that only ever errors is still a lie. */}
      {!u.is_owner && (
        <button
          className="btn ghost sm"
          disabled={busy}
          onClick={async () => {
            const next = u.status === "disabled" ? "active" : "disabled";
            try { await onToggle({ id: u.id, status: next }).unwrap(); } catch (e) { toast.error(errText(e)); }
          }}
        >
          {u.status === "disabled" ? t("admin.enable") : t("admin.disable")}
        </button>
      )}
    </li>
  );
}

/** Three states, not two: yes / no / not reported yet. */
function KeyChip({ on, label }: { on: boolean | null; label: string }) {
  if (on == null) return <span className="adm-fact muted">{label} —</span>;
  return <span className={`adm-fact ${on ? "ok" : "off"}`}>{label} {on ? "✓" : "✕"}</span>;
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
