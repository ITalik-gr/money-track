import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useT } from "../i18n/index.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { Icon } from "../components/ui/Icon.tsx";
import {
  useDetectTransfersMutation,
  useApplySubscriptionCategoriesMutation,
  useGetProfileQuery,
  useSetProfileMutation,
  useGetAiUsageQuery,
  useGetAiModelsQuery,
  useSetAiModelMutation,
  useGetSetupStatusQuery,
  useGetTranslitFixesQuery,
  useApplyTranslitFixesMutation,
  useGetMeQuery,
  useEraseMyDataMutation,
  useLogoutMutation,
  useRegisterTelegramMutation,
  useTgProactiveMutation,
  useScanAlertsMutation,
} from "../store/api.ts";
import type { AiTask, AiModelToken } from "../store/api.ts";
import { CredentialsCard } from "../components/settings/CredentialsCard.tsx";
import { clearLocalUserData } from "../lib/localdata.ts";
import { CsvImportCard } from "../components/settings/CsvImportCard.tsx";
import { FirstRun } from "../components/settings/FirstRun.tsx";
import { InviteCard } from "../components/settings/InviteCard.tsx";

// Settings used to be one flat stack of ten cards — every screen's worth of configuration on one
// page, so finding anything meant scrolling and recognising it by shape. Tabs group it the way
// the rest of the app already groups things (`stat-tabs`, as on Stats and Advisor), and the tab
// lives in the URL so a link to a specific group survives a reload.
const TABS = {
  account: "setup.tabAccount",
  data: "setup.tabData",
  ai: "setup.tabAi",
  maintenance: "setup.tabMaintenance",
} as const;
type SetupTab = keyof typeof TABS;

export function Setup() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: SetupTab = raw && raw in TABS ? (raw as SetupTab) : "account";
  const setTab = (v: SetupTab) => setParams((p) => { p.set("tab", v); return p; }, { replace: true });

  const { data: status } = useGetSetupStatusQuery(undefined, { pollingInterval: 5000 });
  const [detectTransfers, transfersState] = useDetectTransfersMutation();
  const [applySubCats, subCatsState] = useApplySubscriptionCategoriesMutation();
  const [registerTelegram, tgState] = useRegisterTelegramMutation();
  const [tgProactive, tgPushState] = useTgProactiveMutation();
  const [scanAlerts, scanState] = useScanAlertsMutation();
  const [logout] = useLogoutMutation();
  const { data: me } = useGetMeQuery();
  const isDemo = me?.demo === true; // a sandbox has no account to erase
  // The Telegram bot is ONE global installation wired to the owner's chat id, so its controls
  // are the owner's too (security review 2026-07-26: the push paths are gated on `IS_OWNER`
  // server-side). Showing buttons that answer 403 — or worse, look like they configure YOUR
  // bot — is a lie about what the product does for you. Per-user bots: ROADMAP §D1.
  const isOwner = me?.user?.is_owner === true;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("setup.title")}</div>
          <div className="sub">{t("setup.sub")}</div>
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as SetupTab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {t(TABS[k])}
          </button>
        ))}
      </div>

      {/* Профіль і AI-блоки — на всю ширину (текстове поле / перемикачі моделей потребують місця);
          решта — картки-групи дій у 2-колонковій сітці (§налаштування-layout). */}
      {tab === "account" && (
        <div className="settings-grid">
          <ProfileCard />
          {/* Invite-only is enforced server-side; this is the only way to operate it. */}
          {isOwner && <InviteCard />}
          {/* Owner-only: one global bot, one global chat id (see `isOwner` above). */}
          {isOwner && (
            <div className="card set-card set-full">
              <div className="set-card-h"><Icon name="bell" size={16} />Telegram</div>
              <p className="set-card-sub">{t("setup.telegramSub")}</p>
              <div className="stack">
                <button
                  className="btn"
                  disabled={tgState.isLoading}
                  onClick={async () => {
                    const r = await registerTelegram().unwrap();
                    if (r.error) toast.error(t("setup.tgError", { error: r.error })); else toast.success(t("setup.tgConnected"));
                  }}
                >
                  {t("setup.connectTg")}
                </button>
                <button
                  className="btn"
                  disabled={tgPushState.isLoading}
                  onClick={async () => {
                    const r = await tgProactive().unwrap();
                    if (r.sent) toast.success(t("setup.tgPushSent"));
                    else toast.info(t("setup.tgPushNotSent", { reason: r.reason ?? t("setup.tgNotConfigured") }));
                  }}
                >
                  {t("setup.tgTestSummary")}
                </button>
                <button
                  className="btn"
                  disabled={scanState.isLoading}
                  onClick={async () => {
                    const r = await scanAlerts().unwrap();
                    if (r.sent > 0) toast.success(t("setup.alertsSent", { n: r.sent }));
                    else toast.info(t("setup.noSignificantTx"));
                  }}
                >
                  {t("setup.tgTestScan")}
                </button>
              </div>
            </div>
          )}
          {!isDemo && <DangerZone />}
        </div>
      )}

      {tab === "data" && (
        <div className="settings-grid">
          {/* Keys first: every step of the first run needs them, so a page that opened on the
              checklist would be asking for actions that cannot succeed yet. */}
          <CredentialsCard />
          <FirstRun />
          <div className="card set-card">
            <div className="set-card-h"><Icon name="stats" size={16} />{t("setup.dbState")}</div>
            <div className="stack" style={{ marginTop: 12 }}>
              <Status label={t("setup.accountsInDb")} value={status?.accounts ?? "…"} />
              <Status label={t("setup.txCount")} value={status?.transactions ?? "…"} />
              <Status label={t("setup.webhookStatus")} value={status?.webhookRegistered ? t("setup.registered") : t("setup.notRegistered")} />
            </div>
          </div>
          <CsvImportCard />
        </div>
      )}

      {tab === "ai" && (
        <div className="settings-grid">
          <AiUsageCard />
        </div>
      )}

      {tab === "maintenance" && (
        <div className="settings-grid">
          <div className="card set-card">
            <div className="set-card-h"><Icon name="settings" size={16} />{t("setup.maintenance")}</div>
            <p className="set-card-sub">{t("setup.maintenanceSub")}</p>
            <div className="stack">
              <button
                className="btn"
                disabled={transfersState.isLoading}
                onClick={async () => {
                  const r = await detectTransfers().unwrap();
                  toast.success(t("setup.transfersMarked", { n: r.marked }));
                }}
              >
                {t("setup.findTransfers")}
              </button>
              <button
                className="btn"
                disabled={subCatsState.isLoading}
                onClick={async () => {
                  const r = await applySubCats().unwrap();
                  toast.success(t("setup.subCatsApplied", { n: r.fixed }));
                }}
              >
                {t("setup.applySubCats")}
              </button>
              <TranslitFixes />
            </div>
          </div>
        </div>
      )}

      <div className="set-footer">
        <button className="btn ghost" onClick={async () => { clearLocalUserData(); await logout(); }}>
          {t("setup.logout")}
        </button>
      </div>
    </>
  );
}

/**
 * Account erasure (security review 2026-07-26).
 *
 * Until this existed, the only removal was the owner disabling someone: the door closed and every
 * transaction, balance and AI note stayed in the deployment forever. "Delete my data" has to be
 * something the person whose data it is can do.
 *
 * Typed confirmation rather than a modal with an OK button: this drops a bank history and cannot
 * be undone, and the cost of typing six letters is the point.
 */
function DangerZone() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [eraseMyData, delState] = useEraseMyDataMutation();

  async function run() {
    try {
      await eraseMyData().unwrap();
      // The server dropped the cookie; clearing the device-side copy of the chats is ours to do.
      clearLocalUserData();
      window.location.href = "/";
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <div className="card set-card set-full danger-zone">
      <div className="set-card-h"><Icon name="alert" size={16} />{t("setup.dangerTitle")}</div>
      <p className="set-card-sub">{t("setup.dangerBody")}</p>
      {!open ? (
        <button className="btn sm ghost danger-text" onClick={() => setOpen(true)}>{t("setup.deleteAccount")}</button>
      ) : (
        <div className="stack">
          <p className="set-card-sub" style={{ margin: 0 }}>{t("setup.deleteConfirmHint")}</p>
          <div className="row" style={{ gap: 8 }}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" style={{ flex: 1 }} />
            <button className="btn sm danger-text" disabled={typed !== "DELETE" || delState.isLoading} onClick={run}>
              {delState.isLoading ? "…" : t("setup.deleteConfirmBtn")}
            </button>
            <button className="btn sm ghost" onClick={() => { setOpen(false); setTyped(""); }}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ROADMAP L5: merchants the model transliterated before the prompt fix («Сільпо» over a `SILPO`
// statement line) split one shop's history in two. Preview first, apply on demand — the pass
// renames every matching transaction, and a bulk rename shown only as a result is a bulk rename
// nobody can check. Loads lazily: most accounts have nothing to fix, and the scan reads all rows.
function TranslitFixes() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data, isFetching } = useGetTranslitFixesQuery(undefined, { skip: !open });
  const [apply, applyState] = useApplyTranslitFixesMutation();
  const fixes = data?.fixes ?? [];

  // No margin override: this button now sits INSIDE the card's `.stack` with its siblings, which
  // is also what left-aligns its label — `.set-card .stack .btn { justify-content: flex-start }`
  // never reached it while it was a direct child of the card, so it alone rendered centred.
  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        {t("setup.translitCheck")}
      </button>
    );
  }
  return (
    <div className="translit-box">
      {isFetching && <p className="set-card-sub" style={{ margin: 0 }}>{t("common.loading")}</p>}
      {!isFetching && fixes.length === 0 && <p className="set-card-sub" style={{ margin: 0 }}>{t("setup.translitNone")}</p>}
      {!isFetching && fixes.length > 0 && (
        <>
          <p className="set-card-sub" style={{ margin: "0 0 8px" }}>{t("setup.translitFound", { n: fixes.length })}</p>
          <ul className="translit-list">
            {fixes.slice(0, 8).map((f) => (
              <li key={`${f.from}->${f.to}`}>
                <span className="tl-from">{f.from}</span>
                <Icon name="arrowRight" size={13} />
                <span className="tl-to">{f.to}</span>
                <span className="tl-n">{t("setup.translitTxCount", { n: f.n })}</span>
              </li>
            ))}
          </ul>
          <button className="btn primary sm" disabled={applyState.isLoading}
            onClick={async () => {
              try {
                const r = await apply().unwrap();
                toast.success(t("setup.translitApplied", { n: r.fixed, m: r.merchants }));
              } catch (e) { toast.error(errText(e)); }
            }}>
            {t("setup.translitApply")}
          </button>
        </>
      )}
    </div>
  );
}

function Status({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <span className="label">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

// §B1: опис «про мене» — щоб AI знав користувача. Використовується в порадах, збагаченні
// транзакцій, чаті по операції та розумінні підписок (спільний finance_profile).
function ProfileCard() {
  const t = useT();
  const { data: profile } = useGetProfileQuery();
  const [saveProfile, { isLoading }] = useSetProfileMutation();
  const [text, setText] = useState("");
  useEffect(() => { if (profile) setText(profile.text); }, [profile]);

  return (
    <div className="card ai-block set-full">
      <div className="ai-block-head">
        <span className="ai-block-title"><Icon name="spark" size={16} />{t("setup.aboutMeTitle")}</span>
      </div>
      <p className="ai-block-hint">
        {t("setup.aboutMeHintPre")}<b>{t("setup.aboutMeHintBold")}</b>{t("setup.aboutMeHintPost")}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={t("setup.aboutMePlaceholder")}
      />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" disabled={isLoading}
          onClick={async () => { try { await saveProfile(text).unwrap(); toast.success(t("setup.saved")); } catch (e) { toast.error(errText(e)); } }}>
          {isLoading ? t("setup.saving") : t("setup.saveProfile")}
        </button>
      </div>
    </div>
  );
}

// §Хвіст C: глобальний лічильник витрат AI — «$ за сьогодні / цей місяць / за весь час».
// Раніше вартість було видно лише за окремий виклик; тепер бачимо сукупно.
function money(usd: number): string {
  return "$" + (usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2));
}
function AiUsageCard() {
  const t = useT();
  const { data } = useGetAiUsageQuery();
  if (!data) return null;
  const rows: { label: string; cost: number; calls: number }[] = [
    { label: t("setup.aiToday"), cost: data.today.cost_usd, calls: data.today.calls },
    { label: t("setup.aiMonth"), cost: data.month.cost_usd, calls: data.month.calls },
    { label: t("setup.aiTotal"), cost: data.total.cost_usd, calls: data.total.calls },
  ];
  return (
    <div className="card set-full">
      <div className="set-card-h"><Icon name="spark" size={16} />{t("setup.aiCosts")}</div>
      <div className="ai-usage-row">
        {rows.map((r) => (
          <div key={r.label} className="ai-usage-tile">
            <span className="label">{r.label}</span>
            <span className="ai-usage-cost num-hero">{money(r.cost)}</span>
            <span className="ai-usage-calls muted">{t("setup.callsShort", { n: r.calls })}</span>
          </div>
        ))}
      </div>
      <AiModelToggle />
      <p className="ai-block-hint" style={{ marginTop: 12, marginBottom: 0 }}>
        {t("setup.aiModelHint")}
      </p>
    </div>
  );
}

// Моделі ОКРЕМО НА ЗАДАЧУ. Три головні задачі змінні; enrich/OCR завжди на Haiku.
const MODEL_META: Record<AiModelToken, { name: string; price: string }> = {
  haiku: { name: "Haiku 4.5", price: "$1/$5" },
  sonnet: { name: "Sonnet 5", price: "$3/$15" },
  opus: { name: "Opus 4.8", price: "$5/$25" },
};
const AI_MODEL_TASKS: { task: AiTask; labelKey: "setup.task.report" | "setup.task.advisor" | "setup.task.chat" | "setup.task.insight" | "setup.task.notify"; hintKey: "setup.task.reportHint" | "setup.task.advisorHint" | "setup.task.chatHint" | "setup.task.insightHint" | "setup.task.notifyHint"; options: AiModelToken[] }[] = [
  { task: "report", labelKey: "setup.task.report", hintKey: "setup.task.reportHint", options: ["sonnet", "opus"] },
  { task: "advisor", labelKey: "setup.task.advisor", hintKey: "setup.task.advisorHint", options: ["haiku", "sonnet", "opus"] },
  { task: "chat", labelKey: "setup.task.chat", hintKey: "setup.task.chatHint", options: ["haiku", "sonnet", "opus"] },
  { task: "insight", labelKey: "setup.task.insight", hintKey: "setup.task.insightHint", options: ["haiku", "sonnet"] },
  { task: "notify", labelKey: "setup.task.notify", hintKey: "setup.task.notifyHint", options: ["haiku", "sonnet"] },
];

function AiModelToggle() {
  const t = useT();
  const { data } = useGetAiModelsQuery();
  const { data: me } = useGetMeQuery();
  const [setModel, { isLoading }] = useSetAiModelMutation();
  const models = data?.models;
  // A demo sandbox runs on OUR key, so the server pins every task to Haiku (`getTaskModel`).
  // Showing pickable Sonnet/Opus buttons that silently do nothing would be a lie about the
  // product — say it instead, and show the model that is actually used.
  const isDemo = me?.demo === true;
  return (
    <div className="ai-model-list">
      {isDemo && <p className="ai-model-note">{t("setup.aiModelDemoNote")}</p>}
      {AI_MODEL_TASKS.map((row) => {
        const cur = isDemo ? "haiku" : (models?.[row.task] ?? "sonnet");
        const options = isDemo ? (["haiku"] as AiModelToken[]) : row.options;
        return (
          <div key={row.task} className="ai-model-row">
            <div className="ai-model-info">
              <span className="ai-model-label">{t(row.labelKey)}</span>
              <span className="ai-model-hint">{t(row.hintKey)} · {MODEL_META[cur].price} {t("setup.perMtok")}</span>
            </div>
            <div className="seg">
              {options.map((m) => (
                <button key={m} className={`seg-btn ${cur === m ? "active" : ""}`} disabled={isLoading || isDemo}
                  onClick={() => setModel({ task: row.task, model: m })}>
                  {MODEL_META[m].name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
