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
 * §MCP — connect an MCP client (Claude Code, Claude Desktop) to this account's ledger.
 *
 * The card exists because the token cannot be shown twice. It is minted, displayed once, and from
 * then on the server can only say whether one is valid — the same promise `/api/credentials` makes
 * about a stored API key, for the same reason: a credential a screen can re-display is a
 * credential a screen can leak. So the copy step has to be here, beside the button that mints it,
 * rather than on a "view token" screen that could not exist.
 *
 * The setup commands are shown filled in with the real token while it is on screen, and with a
 * placeholder afterwards. A person who has just minted a credential is going to paste it
 * somewhere; leaving them to assemble the command by hand is how it ends up in shell history with
 * a typo, and then the failure looks like the server rejecting them.
 */
export function McpCard() {
  const t = useT();
  const { data, isError, error, refetch } = useGetMcpQuery();
  const [issue, issueState] = useIssueMcpTokenMutation();
  const [revoke] = useRevokeMcpTokenMutation();
  const [token, setToken] = useState<string | null>(null);

  const url = data?.url ?? `${location.origin}/mcp`;
  // The placeholder is deliberately not a fake token shape: something that LOOKS like a token
  // invites a paste of the example itself, which then fails authentication for a reason nobody
  // can see from the error.
  const secret = token ?? "<YOUR-TOKEN>";
  const cli = `claude mcp add --transport http money-track ${url} \\\n  --header "Authorization: Bearer ${secret}"`;
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

      <div className="stack">
        <button
          className="btn"
          disabled={issueState.isLoading}
          onClick={async () => {
            try {
              const r = await issue().unwrap();
              setToken(r.token);
            } catch (e) { toast.error(errText(e)); }
          }}
        >
          {data?.active ? t("mcp.rotate") : t("mcp.issue")}
        </button>
        {data?.active && (
          <button
            className="btn"
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
        )}
      </div>

      {data?.active && data.issued_at != null && !token && (
        <p className="set-card-sub mcp-when">{t("mcp.issuedAt", { when: when.format(data.issued_at * 1000) })}</p>
      )}

      {token && (
        <div className="mcp-secret">
          <p className="mcp-once">{t("mcp.once")}</p>
          <code className="mono mcp-code">{token}</code>
          <button className="btn" onClick={() => copy(token)}>{t("mcp.copy")}</button>
        </div>
      )}

      <details className="tg-more">
        <summary>{t("mcp.howto")}</summary>
        <p className="set-card-sub">{t("mcp.cliStep")}</p>
        <code className="mono mcp-code">{cli}</code>
        <button className="btn" onClick={() => copy(cli)}>{t("mcp.copyCmd")}</button>
        <p className="set-card-sub mcp-when">{t("mcp.desktopStep")}</p>
        <code className="mono mcp-code">{desktop}</code>
        <button className="btn" onClick={() => copy(desktop)}>{t("mcp.copyCfg")}</button>
      </details>
    </div>
  );
}
