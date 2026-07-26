import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { Icon } from "../components/Icon.tsx";
import {
  useBackfillStartMutation,
  useBackfillStepMutation,
  useDetectTransfersMutation,
  useApplySubscriptionCategoriesMutation,
  useGetProfileQuery,
  useSetProfileMutation,
  useGetAiUsageQuery,
  useGetAiModelsQuery,
  useSetAiModelMutation,
  useGetSetupStatusQuery,
  useLogoutMutation,
  useRefreshRatesMutation,
  useRegisterWebhookMutation,
  useRegisterTelegramMutation,
  useTgProactiveMutation,
  useScanAlertsMutation,
  useSyncAccountsMutation,
} from "../store/api.ts";
import type { AiTask, AiModelToken } from "../store/api.ts";
import { CredentialsCard } from "../components/CredentialsCard.tsx";
import { CsvImportCard } from "../components/CsvImportCard.tsx";

// Крок бекфілу раз на 60с (ліміт моно 1/60с), клієнт веде таймінг і показує прогрес (§5).
const STEP_INTERVAL_MS = 60_000;

export function Setup() {
  const t = useT();
  const { data: status } = useGetSetupStatusQuery(undefined, { pollingInterval: 5000 });
  const [syncAccounts, syncState] = useSyncAccountsMutation();
  const [registerWebhook, whState] = useRegisterWebhookMutation();
  const [refreshRates, ratesState] = useRefreshRatesMutation();
  const [detectTransfers, transfersState] = useDetectTransfersMutation();
  const [applySubCats, subCatsState] = useApplySubscriptionCategoriesMutation();
  const [registerTelegram, tgState] = useRegisterTelegramMutation();
  const [tgProactive, tgPushState] = useTgProactiveMutation();
  const [scanAlerts, scanState] = useScanAlertsMutation();
  const [logout] = useLogoutMutation();
  const [backfillStart] = useBackfillStartMutation();
  const [backfillStep] = useBackfillStepMutation();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ progress: number; total: number } | null>(null);
  const timer = useRef<number | null>(null);

  async function runBackfill() {
    setRunning(true);
    const started = await backfillStart().unwrap();
    setProgress({ progress: 0, total: started.total });
    const tick = async () => {
      const r = await backfillStep().unwrap();
      setProgress({ progress: r.progress, total: r.total });
      if (r.done) {
        setRunning(false);
        if (timer.current) window.clearInterval(timer.current);
      }
    };
    await tick();
    timer.current = window.setInterval(tick, STEP_INTERVAL_MS);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("setup.title")}</div>
          <div className="sub">{t("setup.sub")}</div>
        </div>
      </div>

      {/* Профіль і AI-блоки — на всю ширину (текстове поле / перемикачі моделей потребують місця);
          решта — картки-групи дій у 2-колонковій сітці (§налаштування-layout). */}
      <div className="settings-grid">
        <ProfileCard />
        <AiUsageCard />
        <CredentialsCard />
        <CsvImportCard />

        <div className="card set-card">
          <div className="set-card-h"><Icon name="stats" size={16} />{t("setup.dbState")}</div>
          <div className="stack" style={{ marginTop: 12 }}>
            <Status label={t("setup.accountsInDb")} value={status?.accounts ?? "…"} />
            <Status label={t("setup.txCount")} value={status?.transactions ?? "…"} />
            <Status label={t("setup.webhookStatus")} value={status?.webhookRegistered ? t("setup.registered") : t("setup.notRegistered")} />
          </div>
        </div>

        <div className="card set-card">
          <div className="set-card-h"><Icon name="repeat" size={16} />{t("setup.firstRun")}</div>
          <p className="set-card-sub">{t("setup.firstRunSub")}</p>
          <div className="stack">
            <button className="btn" onClick={() => syncAccounts()} disabled={syncState.isLoading}>
              {t("setup.step1")}
            </button>
            <button className="btn" onClick={() => registerWebhook()} disabled={whState.isLoading}>
              {t("setup.step2")}
            </button>
            <button className="btn" onClick={runBackfill} disabled={running}>
              {t("setup.step3")} {running && progress ? `— ${progress.progress}/${progress.total}` : ""}
            </button>
            <button className="btn" onClick={() => refreshRates()} disabled={ratesState.isLoading}>
              {t("setup.refreshRates")}
            </button>
          </div>
          {running && (
            <p className="set-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
              {t("setup.backfillNote")}
            </p>
          )}
        </div>

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
          </div>
        </div>

        <div className="card set-card">
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
      </div>

      <div className="set-footer">
        <button className="btn ghost" onClick={() => logout()}>{t("setup.logout")}</button>
      </div>
    </>
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
  const [setModel, { isLoading }] = useSetAiModelMutation();
  const models = data?.models;
  return (
    <div className="ai-model-list">
      {AI_MODEL_TASKS.map((row) => {
        const cur = models?.[row.task] ?? "sonnet";
        return (
          <div key={row.task} className="ai-model-row">
            <div className="ai-model-info">
              <span className="ai-model-label">{t(row.labelKey)}</span>
              <span className="ai-model-hint">{t(row.hintKey)} · {MODEL_META[cur].price} {t("setup.perMtok")}</span>
            </div>
            <div className="seg">
              {row.options.map((m) => (
                <button key={m} className={`seg-btn ${cur === m ? "active" : ""}`} disabled={isLoading}
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
