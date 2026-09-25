import { useEffect, useState, type ReactNode } from "react";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
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
  useGetTranslitFixesQuery,
  useApplyTranslitFixesMutation,
  useGetMeQuery,
  useEraseMyDataMutation,
  useLogoutAllMutation,
  useLogoutMutation,
} from "../store/api.ts";
import type { AiTask, AiModelToken } from "../store/api.ts";
import { CredentialsCard } from "../components/settings/CredentialsCard.tsx";
import { clearLocalUserData } from "../lib/localdata.ts";
import { CsvImportCard } from "../components/settings/CsvImportCard.tsx";
import { BankConnections } from "../components/settings/BankConnections.tsx";
import { ExportCard } from "../components/settings/ExportCard.tsx";
import { AiActivityCard } from "../components/settings/AiActivityCard.tsx";
import { BackupCard } from "../components/settings/BackupCard.tsx";
import { McpCard } from "../components/settings/McpCard.tsx";
import { SearchCard } from "../components/settings/SearchCard.tsx";
import { QuickAddCard } from "../components/settings/QuickAddCard.tsx";
import { FirstRun } from "../components/settings/FirstRun.tsx";
import { UsersCard } from "../components/settings/UsersCard.tsx";
import { TelegramCard } from "../components/settings/TelegramCard.tsx";
import { CurrencyCard } from "../components/settings/CurrencyCard.tsx";
import { FeedbackCard } from "../components/settings/FeedbackCard.tsx";
import { PushCard } from "../components/settings/PushCard.tsx";
import { FeedbackInbox } from "../components/settings/FeedbackInbox.tsx";
import { JevUsageCard } from "../components/settings/JevUsageCard.tsx";

// Settings used to be one flat stack of ten cards — every screen's worth of configuration on one
// page, so finding anything meant scrolling and recognising it by shape. Tabs group it the way
// the rest of the app already groups things (`stat-tabs`, as on Stats and Advisor), and the tab
// lives in the URL so a link to a specific group survives a reload.
//
// SE1 (2026-09-25), owner: «громіздко, не зрозуміло поділено». The tabs now follow what a person
// comes here to do — about me · where the money comes from · how the app reaches me · the AI — and
// each tab is split into captioned blocks. Merged: bank key + linked banks + «Стан бази» (one card),
// sign-out + sign-out-everywhere (one card). Gone from users' view: the «Обслуговування» tab (three
// one-off repair buttons for old data — now the owner's «Адмін», with the users and the inbox).
const TABS = {
  account: "setup.tabGeneral",
  data: "setup.tabBanks",
  channels: "setup.tabChannels",
  ai: "setup.tabAi",
  // Owner-only, filtered out below.
  admin: "setup.tabAdmin",
} as const;
type SetupTab = keyof typeof TABS;
/** Old links (`?tab=users`, `?tab=maintenance`) land where their content went. */
const LEGACY_TAB: Record<string, SetupTab> = { users: "admin", maintenance: "admin" };

export function Setup() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const mapped = raw ? LEGACY_TAB[raw] ?? raw : null;
  const setTab = (v: SetupTab) => setParams((p) => { p.set("tab", v); return p; }, { replace: true });

  const { data: me } = useGetMeQuery();
  const isDemo = me?.demo === true; // a sandbox has no account to erase
  // Owner-only surfaces: the admin tab, and inside the Telegram card the one button that
  // reconfigures a GLOBAL resource (the bot's webhook). Everything else about Telegram is now
  // per-user (§D1) — the push target is this user's own linked chat, so hiding the card from
  // them would hide a feature that works for them.
  const isOwner = me?.user?.is_owner === true;
  const tab: SetupTab = mapped && mapped in TABS && (mapped !== "admin" || isOwner) ? (mapped as SetupTab) : "account";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("setup.title")}</div>
          <div className="sub">{t("setup.sub")}</div>
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as SetupTab[])
          // A tab nobody but the owner may open must not be visible to anyone else — a 403 behind
          // a tab still promises a feature that does not exist for that person.
          .filter((k) => k !== "admin" || isOwner)
          .map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
              {t(TABS[k])}
            </button>
          ))}
      </div>

      {/* ONE grid, no sub-blocks (owner, 2026-09-25: «огромні пробіли між блоками»): each block
          balanced its own two columns, so a short card beside a tall one left a hole the height of
          the difference. In one flow the columns balance each other: currency + sessions on the
          left, feedback on the right, the danger zone spanning last. */}
      {tab === "account" && (
        <SetBlock>
          <ProfileCard />
          {/* §BASE-CUR: beside the language switch in the shell header, this is the other half of
              "how the app talks to me" — and the half an English-reading visitor notices first. */}
          <CurrencyCard />
          <SessionsCard isDemo={isDemo} />
          {/* For everyone, the demo included: a first-time visitor is exactly who notices what is
              unclear, and a form behind sign-up only hears from people past the broken part. */}
          <FeedbackCard />
          {!isDemo && <DangerZone />}
        </SetBlock>
      )}

      {tab === "data" && (
        <>
          <SetBlock title={t("setup.blockConnect")}>
            {/* Keys first: every step of the first run needs them. The checklist folds to one line
                once it is done. */}
            <FirstRun />
            <CredentialsCard kind="bank"><BankConnections /></CredentialsCard>
          </SetBlock>
          <SetBlock title={t("setup.blockFiles")}>
            <CsvImportCard />
            {/* Manual export beside the import; automatic copies right after it — the same question,
                «what if it all disappears», without «if I remember». */}
            <ExportCard />
            {!isDemo && <BackupCard />}
          </SetBlock>
        </>
      )}

      {tab === "channels" && (
        <>
          <SetBlock title={t("setup.blockNotify")}>
            {/* §D1: the recipient is personal, so the card is for everyone; only registering the
                global webhook stays owner-only (inside the card). Push answers the same question. */}
            <TelegramCard isOwner={isOwner} />
            <PushCard />
          </SetBlock>
          {/* Hidden in the demo: a sandbox lives 24h, so a token minted here would stop working the
              same day (the server refuses it outright, §MCP). */}
          {!isDemo && (
            <SetBlock title={t("setup.blockAccess")}>
              <McpCard />
              <QuickAddCard />
            </SetBlock>
          )}
        </>
      )}

      {/* Every AI card is full width, stacked: no pair here has matching heights, and a pair that
          does not match is a hole (owner, 2026-09-25). Keys first, then what the AI costs and what
          it changed, then search. */}
      {tab === "ai" && (
        <SetBlock>
          <CredentialsCard kind="ai" />
          <AiUsageCard />
          {/* §AI-AUDIT beside the spend card on purpose: one says what the model COST, the other
              what it CHANGED. Those are the two questions people have about an AI in their data. */}
          <AiActivityCard />
          {!isDemo && <SearchCard />}
        </SetBlock>
      )}

      {/* Guarded twice: the tab is hidden above, and `tab` falls back to «account» for anyone else
          — a hidden tab is still reachable by typing `?tab=admin` into the address bar. */}
      {tab === "admin" && isOwner && (
        <>
          <SetBlock title={t("setup.blockPeople")}>
            <UsersCard />
            <FeedbackInbox />
          </SetBlock>
          <SetBlock title={t("jevuse.block")}>
            <JevUsageCard />
          </SetBlock>
          <SetBlock title={t("setup.maintenance")}>
            <MaintenanceCard />
          </SetBlock>
        </>
      )}
    </>
  );
}

/** A captioned group of cards inside a tab (SE1): the caption says what the block is FOR. A tab
 *  whose cards only balance in one flow is a single block with no caption. */
function SetBlock({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="set-block">
      {title && <div className="section-head"><h2>{title}</h2></div>}
      <div className="settings-grid">{children}</div>
    </section>
  );
}

function MaintenanceCard() {
  const t = useT();
  const [detectTransfers, transfersState] = useDetectTransfersMutation();
  const [applySubCats, subCatsState] = useApplySubscriptionCategoriesMutation();
  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="settings" size={16} />{t("setup.maintenance")}</div>
      <p className="set-card-sub">{t("setup.maintenanceSub")}</p>
      <div className="stack">
        <button className="btn" disabled={transfersState.isLoading}
          onClick={async () => {
            try { const r = await detectTransfers().unwrap(); toast.success(t("setup.transfersMarked", { n: r.marked })); }
            catch (e) { toast.error(errText(e)); }
          }}>
          {t("setup.findTransfers")}
        </button>
        <button className="btn" disabled={subCatsState.isLoading}
          onClick={async () => {
            try { const r = await applySubCats().unwrap(); toast.success(t("setup.subCatsApplied", { n: r.fixed })); }
            catch (e) { toast.error(errText(e)); }
          }}>
          {t("setup.applySubCats")}
        </button>
        <TranslitFixes />
      </div>
    </div>
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
/**
 * Revoking every session is a SAFETY action, and it used to live inside the red "delete
 * everything" card (2026-08-14).
 *
 * Colour is a claim: inside that card the button read as a step of deletion, so the one control a
 * person reaches for when they think somebody else has their session sat in the place they are
 * most afraid to touch. It is an ordinary card now, next to the other account controls; the red
 * card keeps exactly one thing in it, which is what makes red mean something.
 */
function SessionsCard({ isDemo }: { isDemo: boolean }) {
  const t = useT();
  const [logoutAll, logoutAllState] = useLogoutAllMutation();
  const [logout] = useLogoutMutation();
  // SE1: «вийти» and «вийти всюди» are one card — the plain sign-out used to be a lone button under
  // the «Обслуговування» tab, the one place nobody looks for it.
  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="settings" size={16} />{t("setup.sessionsTitle")}</div>
      <p className="set-card-sub">{t("setup.logoutAllHint")}</p>
      <div className="stack" style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => { clearLocalUserData(); await logout(); }}>
          {t("setup.logout")}
        </button>
        {!isDemo && <button
          className="btn"
          disabled={logoutAllState.isLoading}
          onClick={async () => {
            try {
              await logoutAll().unwrap();
              clearLocalUserData();
              window.location.href = "/";
            } catch (e) { toast.error(errText(e)); }
          }}
        >
          {t("setup.logoutAll")}
        </button>}
      </div>
    </div>
  );
}

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
  const { data, isFetching, error, refetch } = useGetTranslitFixesQuery(undefined, { skip: !open });
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
      <ErrorNote error={error} what={t("setup.translitCheck")} onRetry={refetch} />
      {!isFetching && !error && fixes.length === 0 && <p className="set-card-sub" style={{ margin: 0 }}>{t("setup.translitNone")}</p>}
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
    <div>
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
