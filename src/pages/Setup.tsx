import { useEffect, useRef, useState } from "react";
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
      <div className="page-head">
        <div>
          <div className="greet">Налаштування</div>
          <div className="sub">Профіль, синхронізація Monobank, AI-моделі та інтеграції.</div>
        </div>
      </div>

      {/* Профіль і AI-блоки — на всю ширину (текстове поле / перемикачі моделей потребують місця);
          решта — картки-групи дій у 2-колонковій сітці (§налаштування-layout). */}
      <div className="settings-grid">
        <ProfileCard />
        <AiUsageCard />

        <div className="card set-card">
          <div className="set-card-h"><Icon name="stats" size={16} />Стан бази</div>
          <div className="stack" style={{ marginTop: 12 }}>
            <Status label="Рахунків у базі" value={status?.accounts ?? "…"} />
            <Status label="Транзакцій" value={status?.transactions ?? "…"} />
            <Status label="Вебхук моно" value={status?.webhookRegistered ? "зареєстровано" : "ні"} />
          </div>
        </div>

        <div className="card set-card">
          <div className="set-card-h"><Icon name="repeat" size={16} />Перший запуск</div>
          <p className="set-card-sub">Одноразово, у цьому порядку.</p>
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
          </div>
          {running && (
            <p className="set-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
              Бекфіл іде по одному запиту раз на 60 секунд (обмеження Monobank). Можна лишити вкладку відкритою.
            </p>
          )}
        </div>

        <div className="card set-card">
          <div className="set-card-h"><Icon name="settings" size={16} />Обслуговування</div>
          <p className="set-card-sub">Періодично, за потреби.</p>
          <div className="stack">
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
          </div>
        </div>

        <div className="card set-card">
          <div className="set-card-h"><Icon name="bell" size={16} />Telegram</div>
          <p className="set-card-sub">Бот для пушів і швидкого запису.</p>
          <div className="stack">
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
        </div>
      </div>

      <div className="set-footer">
        <button className="btn ghost" onClick={() => logout()}>Вийти з акаунта</button>
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
  const { data: profile } = useGetProfileQuery();
  const [saveProfile, { isLoading }] = useSetProfileMutation();
  const [text, setText] = useState("");
  useEffect(() => { if (profile) setText(profile.text); }, [profile]);

  return (
    <div className="card ai-block set-full">
      <div className="ai-block-head">
        <span className="ai-block-title"><Icon name="spark" size={16} />Про мене — щоб AI мене розумів</span>
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
          onClick={async () => { try { await saveProfile(text).unwrap(); toast.success("Збережено"); } catch (e) { toast.error(errText(e)); } }}>
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
    <div className="card set-full">
      <div className="set-card-h"><Icon name="spark" size={16} />AI: витрати й моделі</div>
      <div className="ai-usage-row">
        {rows.map((r) => (
          <div key={r.label} className="ai-usage-tile">
            <span className="label">{r.label}</span>
            <span className="ai-usage-cost num-hero">{money(r.cost)}</span>
            <span className="ai-usage-calls muted">{r.calls} викл.</span>
          </div>
        ))}
      </div>
      <AiModelToggle />
      <p className="ai-block-hint" style={{ marginTop: 12, marginBottom: 0 }}>
        Модель окремо на задачу. Категоризація/OCR завжди на Haiku. Вартість — оцінка за токенами, не рахунок.
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
const AI_MODEL_ROWS: { task: AiTask; label: string; hint: string; options: AiModelToken[] }[] = [
  { task: "report", label: "Репорти", hint: "глибокий розбір періоду — варто найкращої моделі", options: ["sonnet", "opus"] },
  { task: "advisor", label: "Порадник", hint: "поради-картки на сторінці Порадника", options: ["haiku", "sonnet", "opus"] },
  { task: "chat", label: "Чат з AI", hint: "розмова про твої гроші як з фінменеджером", options: ["haiku", "sonnet", "opus"] },
  { task: "insight", label: "AI-огляд у Статистиці", hint: "короткий коментар — масово, дешево", options: ["haiku", "sonnet"] },
];

function AiModelToggle() {
  const { data } = useGetAiModelsQuery();
  const [setModel, { isLoading }] = useSetAiModelMutation();
  const models = data?.models;
  return (
    <div className="ai-model-list">
      {AI_MODEL_ROWS.map((row) => {
        const cur = models?.[row.task] ?? "sonnet";
        return (
          <div key={row.task} className="ai-model-row">
            <div className="ai-model-info">
              <span className="ai-model-label">{row.label}</span>
              <span className="ai-model-hint">{row.hint} · {MODEL_META[cur].price} за MTok</span>
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
