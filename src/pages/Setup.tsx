import { useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast.ts";
import {
  useBackfillStartMutation,
  useBackfillStepMutation,
  useDetectTransfersMutation,
  useApplySubscriptionCategoriesMutation,
  useGetProfileQuery,
  useSetProfileMutation,
  useGetAiUsageQuery,
  useGetAiModelQuery,
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

// Крок бекфілу раз на 60с (ліміт моно 1/60с), клієнт веде таймінг і показує прогрес (§5).
const STEP_INTERVAL_MS = 60_000;

export function Setup() {
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
      <div className="section-head"><h2>Налаштування та синхронізація</h2></div>

      <ProfileCard />

      <AiUsageCard />

      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="stack">
          <Status label="Рахунків у базі" value={status?.accounts ?? "…"} />
          <Status label="Транзакцій" value={status?.transactions ?? "…"} />
          <Status label="Вебхук моно" value={status?.webhookRegistered ? "зареєстровано" : "ні"} />
        </div>
      </div>

      <div className="stack">
        <button className="btn" onClick={() => syncAccounts()} disabled={syncState.isLoading}>
          1. Підтягнути рахунки та банки з Monobank
        </button>
        <button className="btn" onClick={() => registerWebhook()} disabled={whState.isLoading}>
          2. Зареєструвати вебхук (онлайн-оновлення)
        </button>
        <button className="btn" onClick={runBackfill} disabled={running}>
          3. Бекфіл за ~90 днів {running && progress ? `— ${progress.progress}/${progress.total}` : ""}
        </button>
        <button className="btn" onClick={() => refreshRates()} disabled={ratesState.isLoading}>
          Оновити курси валют
        </button>
        <button
          className="btn"
          disabled={transfersState.isLoading}
          onClick={async () => {
            const r = await detectTransfers().unwrap();
            toast.success(`Позначено переказами: ${r.marked}`);
          }}
        >
          Знайти перекази між своїми картками
        </button>
        <button
          className="btn"
          disabled={subCatsState.isLoading}
          onClick={async () => {
            const r = await applySubCats().unwrap();
            toast.success(`Категорію підписки застосовано до ${r.fixed} операцій`);
          }}
        >
          Застосувати категорії підписок
        </button>

        <button
          className="btn"
          disabled={tgState.isLoading}
          onClick={async () => {
            const r = await registerTelegram().unwrap();
            if (r.error) toast.error(`Помилка: ${r.error}`); else toast.success("Telegram-бот підключено");
          }}
        >
          Підключити Telegram-бота
        </button>
        <button
          className="btn"
          disabled={tgPushState.isLoading}
          onClick={async () => {
            const r = await tgProactive().unwrap();
            if (r.sent) toast.success("Проактивний пуш надіслано (глянь у Telegram)");
            else toast.info(`Пуш не надіслано: ${r.reason ?? "TG не налаштовано"}`);
          }}
        >
          Тест: надіслати підсумок + бюджети в TG
        </button>
        <button
          className="btn"
          disabled={scanState.isLoading}
          onClick={async () => {
            const r = await scanAlerts().unwrap();
            if (r.sent > 0) toast.success(`Надіслано алертів: ${r.sent} (глянь у Telegram)`);
            else toast.info("Вагомих непояснених операцій за 14 днів не знайдено.");
          }}
        >
          Тест: сканувати вагомі операції → алерти в TG
        </button>
      </div>

      {running && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Бекфіл іде по одному запиту раз на 60 секунд (обмеження Monobank). Можна лишити вкладку відкритою.
        </p>
      )}

      <button className="btn" style={{ marginTop: 24 }} onClick={() => logout()}>
        Вийти
      </button>
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
  const { data: profile } = useGetProfileQuery();
  const [saveProfile, { isLoading }] = useSetProfileMutation();
  const [text, setText] = useState("");
  useEffect(() => { if (profile) setText(profile.text); }, [profile]);

  return (
    <div className="card ai-block" style={{ marginBottom: 12 }}>
      <div className="ai-block-head">
        <span className="ai-block-title">✨ Про мене — щоб AI мене розумів</span>
      </div>
      <p className="ai-block-hint">
        Коротко опиши себе й свою ситуацію: чим займаєшся, дохід/робота, цілі, звички витрат, що для тебе «податки» чи
        «робочі витрати». AI враховує це <b>всюди</b> — у порадах, розпізнаванні операцій, чаті та підписках.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="напр. «Фрилансер-розробник, дохід у $. Плачу податки ФОП щокварталу. Мета — подушка на 6 міс. Знімаю готівку переважно на продукти.»"
      />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" disabled={isLoading}
          onClick={async () => { try { await saveProfile(text).unwrap(); toast.success("Збережено"); } catch (e) { toast.error(String(e)); } }}>
          {isLoading ? "Зберігаю…" : "Зберегти профіль"}
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
  const { data } = useGetAiUsageQuery();
  if (!data) return null;
  const rows: { label: string; cost: number; calls: number }[] = [
    { label: "Сьогодні", cost: data.today.cost_usd, calls: data.today.calls },
    { label: "Цей місяць", cost: data.month.cost_usd, calls: data.month.calls },
    { label: "За весь час", cost: data.total.cost_usd, calls: data.total.calls },
  ];
  return (
    <div className="card" style={{ padding: 16, marginBottom: 12 }}>
      <div className="ai-block-head" style={{ marginBottom: 8 }}>
        <span className="ai-block-title">💸 Витрати на AI</span>
      </div>
      <div className="stack">
        {rows.map((r) => (
          <Status
            key={r.label}
            label={r.label}
            value={`${money(r.cost)} · ${r.calls} викл.`}
          />
        ))}
      </div>
      <AiModelToggle />
      <p className="ai-block-hint" style={{ marginTop: 8, marginBottom: 0 }}>
        Орієнтовна вартість запитів до Claude (Haiku масово, розумна модель для порадника/репортів/чату). Оцінка за токенами, не рахунок.
      </p>
    </div>
  );
}

// Перемикач розумної моделі (порадник/репорти/чат/бюджет). Enrich/OCR завжди на Haiku.
function AiModelToggle() {
  const { data } = useGetAiModelQuery();
  const [setModel, { isLoading }] = useSetAiModelMutation();
  const model = data?.model ?? "sonnet";
  return (
    <div className="ai-model-row">
      <div className="ai-model-info">
        <span className="ai-model-label">Розумна модель</span>
        <span className="ai-model-hint">{model === "opus" ? "Opus 4.8 — найкраща якість (~$5/$25 за MTok)" : "Sonnet 5 — баланс якість/ціна (~$3/$15)"}</span>
      </div>
      <div className="seg">
        {(["sonnet", "opus"] as const).map((m) => (
          <button key={m} className={`seg-btn ${model === m ? "active" : ""}`} disabled={isLoading} onClick={() => setModel(m)}>
            {m === "sonnet" ? "Sonnet 5" : "Opus 4.8"}
          </button>
        ))}
      </div>
    </div>
  );
}
