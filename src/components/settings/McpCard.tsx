import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useGetMcpQuery, useIssueMcpTokenMutation, useRevokeMcpTokenMutation } from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", year: "numeric" });

/**
 * §MCP — connect Claude to this ledger.
 *
 * The card is arranged around what someone actually needs, in order: whether anything is connected
 * right now, the address to paste, and how to disconnect. Everything else — the setup steps, and
 * the personal token for headless use — is folded away, because it is read once and never again.
 *
 * ⚠️ **"Revoke" is a card-level control, not part of the token drawer** (fixed 2026-08-24). It
 * used to render only when a personal token existed, so the people most likely to want it — anyone
 * who connected Claude Desktop through the consent screen and never minted a token at all — had no
 * button. The account had a live grant and the screen offered no way to end it, which is the one
 * failure a permissions card must not have.
 *
 * ⚠️ Revoking ends BOTH kinds of access at once, and the button says so. They share one generation
 * (`users.mcp_version`), so a label promising to disconnect only one of them would be false.
 */
export function McpCard() {
  const t = useT();
  const { data, isError, error, refetch } = useGetMcpQuery();
  const [issue, issueState] = useIssueMcpTokenMutation();
  const [revoke, revokeState] = useRevokeMcpTokenMutation();
  const [token, setToken] = useState<string | null>(null);

  const url = data?.url ?? `${location.origin}/mcp`;
  const connected = data?.connected_clients ?? 0;
  const hasToken = data?.active ?? false;
  const anyAccess = connected > 0 || hasToken;

  // Deliberately not a fake token shape: an example that LOOKS like a credential invites a paste
  // of the example itself, which then fails authentication for a reason nobody can see.
  const secret = token ?? "<YOUR-TOKEN>";
  // With OAuth in place this needs no credential: `/mcp` answers 401 with a pointer to the
  // discovery document, and Claude Code opens a browser for consent by itself.
  const cli = `claude mcp add --transport http money-track ${url}`;
  const cliToken = `claude mcp add --transport http money-track ${url} \\\n  --header "Authorization: Bearer ${secret}"`;
  const desktop = JSON.stringify({
    mcpServers: {
      "money-track": {
        command: "npx",
        args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${secret}`],
      },
    },
  }, null, 2);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("mcp.copied"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="spark" size={16} />{t("mcp.title")}</div>
      <p className="set-card-sub">{t("mcp.sub")}</p>

      {isError && <ErrorNote error={error} what={t("mcp.title")} onRetry={refetch} />}

      {/* State first: "is anything reading my finances right now" is the question this card exists
          to answer, and it should not need a click. */}
      <p className={anyAccess ? "mcp-state on" : "mcp-state"}>
        {connected > 0 ? t("mcp.connected", { n: connected })
          : hasToken ? t("mcp.tokenOnly")
          : t("mcp.notConnected")}
      </p>

      {/* The address is the whole setup on every Claude surface with a connector screen — Desktop,
          claude.ai, the phone — so it leads. Leading with the credential taught people to paste a
          secret they do not need. */}
      <code className="mono mcp-code">{url}</code>
      <div className="stack">
        <button className="btn" onClick={() => copy(url)}>{t("mcp.copyUrl")}</button>
      </div>
      <p className="set-card-sub mcp-when">{t("mcp.connectHint")}</p>

      {anyAccess && (
        <div className="stack" style={{ marginTop: 12 }}>
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
            {t("mcp.revoke")}
          </button>
          <p className="set-card-sub">{t("mcp.revokeHint")}</p>
        </div>
      )}

      <details className="tg-more">
        <summary>{t("mcp.howto")}</summary>
        <p className="set-card-sub">{t("mcp.uiStep")}</p>
        <p className="set-card-sub mcp-when">{t("mcp.cliStep")}</p>
        <code className="mono mcp-code">{cli}</code>
        <button className="btn" onClick={() => copy(cli)}>{t("mcp.copyCmd")}</button>
      </details>

      <details className="tg-more">
        <summary>{t("mcp.tokenTitle")}</summary>
        <p className="set-card-sub">{t("mcp.tokenWhy")}</p>
        <div className="stack">
          <button
            className="btn"
            disabled={issueState.isLoading}
            onClick={async () => {
              try {
                setToken((await issue().unwrap()).token);
              } catch (e) { toast.error(errText(e)); }
            }}
          >
            {hasToken ? t("mcp.rotate") : t("mcp.issue")}
          </button>
        </div>

        {hasToken && data?.issued_at != null && !token && (
          <p className="set-card-sub mcp-when">{t("mcp.issuedAt", { when: when.format(data.issued_at * 1000) })}</p>
        )}

        {token && (
          <div className="mcp-secret">
            <p className="mcp-once">{t("mcp.once")}</p>
            <code className="mono mcp-code">{token}</code>
            <button className="btn" onClick={() => copy(token)}>{t("mcp.copy")}</button>
          </div>
        )}

        <p className="set-card-sub mcp-when">{t("mcp.cliStep")}</p>
        <code className="mono mcp-code">{cliToken}</code>
        <button className="btn" onClick={() => copy(cliToken)}>{t("mcp.copyCmd")}</button>
        <p className="set-card-sub mcp-when">{t("mcp.desktopStep")}</p>
        <code className="mono mcp-code">{desktop}</code>
        <button className="btn" onClick={() => copy(desktop)}>{t("mcp.copyCfg")}</button>
      </details>
    </div>
  );
}
