import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import {
  useGetQuickAddQuery, useIssueQuickAddTokenMutation, useRevokeQuickAddTokenMutation,
} from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", year: "numeric" });

/**
 * §QUICK-ADD — an iPhone shortcut that adds operations, with a token that can do nothing else.
 *
 * Laid out like `McpCard` and for the same reasons: state first, the once-only token second, the
 * setup steps folded away because they are read once. The steps are the product here — the
 * endpoint is useless to someone who does not know which Shortcuts actions to chain — so each
 * recipe names the exact fields the action wants.
 *
 * ⚠️ The Wallet recipe says «only cards no bank syncs». The server refuses a card whose name
 * matches a synced account, but Wallet card names and account titles rarely match, and the only
 * reliable dedup is the person not pointing the automation at a card the bank already reports.
 */
export function QuickAddCard() {
  const t = useT();
  const { data, isError, error, refetch } = useGetQuickAddQuery();
  const [issue, issueState] = useIssueQuickAddTokenMutation();
  const [revoke, revokeState] = useRevokeQuickAddTokenMutation();
  const [token, setToken] = useState<string | null>(null);

  const url = data?.url ?? `${location.origin}/quick-add`;
  const active = data?.active ?? false;
  const header = `Bearer ${token ?? "<YOUR-TOKEN>"}`;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("mcp.copied"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="plus" size={16} />{t("qa.title")}</div>
      <p className="set-card-sub">{t("qa.sub")}</p>

      {isError && <ErrorNote error={error} what={t("qa.title")} onRetry={refetch} />}

      <p className={active ? "mcp-state on" : "mcp-state"}>
        {active && data?.issued_at != null
          ? t("qa.active", { when: when.format(data.issued_at * 1000) })
          : t("qa.inactive")}
      </p>

      <div className="stack">
        <button
          className="btn"
          disabled={issueState.isLoading}
          onClick={async () => {
            try { setToken((await issue().unwrap()).token); } catch (e) { toast.error(errText(e)); }
          }}
        >
          {active ? t("mcp.rotate") : t("mcp.issue")}
        </button>
        {active && (
          <button
            className="btn"
            disabled={revokeState.isLoading}
            onClick={async () => {
              try {
                await revoke().unwrap();
                setToken(null);
                toast.success(t("mcp.revoked"));
              } catch (e) { toast.error(errText(e)); }
            }}
          >
            {t("qa.revoke")}
          </button>
        )}
      </div>

      {token && (
        <div className="mcp-secret">
          <p className="mcp-once">{t("qa.once")}</p>
          <code className="mono mcp-code">{token}</code>
          <button className="btn" onClick={() => copy(token)}>{t("mcp.copy")}</button>
        </div>
      )}

      <p className="set-card-sub mcp-when">{t("qa.request")}</p>
      <code className="mono mcp-code">{`POST ${url}\nAuthorization: ${header}`}</code>
      <div className="stack">
        <button className="btn" onClick={() => copy(url)}>{t("mcp.copyUrl")}</button>
        <button className="btn" onClick={() => copy(header)}>{t("qa.copyHeader")}</button>
      </div>

      <details className="tg-more">
        <summary>{t("qa.walletTitle")}</summary>
        <p className="set-card-sub">{t("qa.walletSteps")}</p>
        <code className="mono mcp-code">{`amount   ← Shortcut Input › Amount\nmerchant ← Shortcut Input › Merchant\ncard     ← Shortcut Input › Card or Pass Name`}</code>
        <p className="set-card-sub mcp-when">{t("qa.walletWarn")}</p>
      </details>

      <details className="tg-more">
        <summary>{t("qa.buttonTitle")}</summary>
        <p className="set-card-sub">{t("qa.buttonSteps")}</p>
        <code className="mono mcp-code">{`amount   ← Provided Input (1)\nmerchant ← Provided Input (2)`}</code>
      </details>

      <details className="tg-more">
        <summary>{t("qa.siriTitle")}</summary>
        <p className="set-card-sub">{t("qa.siriSteps")}</p>
        <code className="mono mcp-code">{`text ← Dictated Text`}</code>
      </details>
    </div>
  );
}
