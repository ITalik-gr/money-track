import { useEffect, useState } from "react";
import { useCreateGoalMutation, useUpdateGoalMutation, useGetAccountsQuery } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/index.ts";
import { Select } from "../ui/Select.tsx";
import type { SavingsGoal, GoalKind, AutofillKind, GoalBody } from "../../store/api.ts";
import { getBaseCurrency } from "../../lib/currency.ts";
import { currencySign } from "../../../shared/currency.ts";

const PALETTE = ["#2e6be6", "#127c86", "#1f6e4c", "#7a3e9d", "#c2417a", "#b23a2e", "#c9871a", "#0e7490"];

// Опції будуються ФУНКЦІЄЮ від `t`, а не модульною константою: константа застигла б з
// мовою на момент імпорту, і перемикач UA/EN не перемалював би ці підписи (§i18n).
const KIND_OPTIONS = (t: (k: TranslationKey) => string) => [
  { value: "save_up", label: t("goal.kind.save_up"), hint: t("goal.kind.save_up.hint") },
  { value: "debt_payoff", label: t("goal.kind.debt_payoff"), hint: t("goal.kind.debt_payoff.hint") },
  { value: "sinking_fund", label: t("goal.kind.sinking_fund"), hint: t("goal.kind.sinking_fund.hint") },
];

const AUTOFILL_OPTIONS = (t: (k: TranslationKey) => string) => [
  { value: "fixed", label: t("goal.autofill.fixed") },
  { value: "income_pct", label: t("goal.autofill.income_pct") },
];

const toDateInput = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "";

// Створення / редагування цілі-накопичення. Прогрес: або ручний (сума), або привʼязка
// до банки — тоді її баланс = прогрес автоматично.
export function GoalModal({ goal, defaultAccountId, defaultName, onClose }: {
  goal?: SavingsGoal | null; defaultAccountId?: string | null; defaultName?: string; onClose: () => void;
}) {
  const t = useT();
  const editing = !!goal;
  const { data: accounts = [] } = useGetAccountsQuery();
  const [createGoal, { isLoading: creating }] = useCreateGoalMutation();
  const [updateGoal, { isLoading: updating }] = useUpdateGoalMutation();

  const [name, setName] = useState(goal?.name ?? defaultName ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target_amount / 100) : "");
  const [accountId, setAccountId] = useState<string | null>(goal?.account_id ?? defaultAccountId ?? null);
  const [current, setCurrent] = useState(goal ? String(goal.current_amount / 100) : "");
  const [deadline, setDeadline] = useState(toDateInput(goal?.deadline));
  const [color, setColor] = useState(goal?.color ?? PALETTE[0]);
  const [note, setNote] = useState(goal?.note ?? "");
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? "save_up");
  const [autoKind, setAutoKind] = useState<AutofillKind | null>(goal?.autofill_kind ?? null);
  // Значення в ОДИНИЦЯХ правила: для 'fixed' — гривні, для 'income_pct' — відсотки. Одне поле
  // на два сенси, бо разом вони й читаються («відкладати 10 % доходу»).
  const [autoValue, setAutoValue] = useState(
    goal?.autofill_value != null ? String(goal.autofill_kind === "fixed" ? goal.autofill_value / 100 : goal.autofill_value) : "",
  );

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  /**
   * §GOAL-CUR — the unit this form is typing in.
   *
   * A jar-backed goal is denominated in its JAR: the progress will literally be that account's
   * balance, so a target typed against anything else guarantees a comparison across currencies —
   * which is exactly how a $2 000 goal came to be stored as 2 000 ₴ and reported complete at 5%.
   * An existing goal keeps whatever it already declares; a new manual goal takes the reader's base.
   */
  const jarCurrency = accounts.find((a) => a.id === accountId)?.currency_code ?? null;
  const cur = jarCurrency ?? goal?.currency_code ?? getBaseCurrency();
  const sign = currencySign(cur);

  // Джерело прогресу — банки (накопичення).
  const jarOptions = accounts
    .filter((a) => a.type === "jar")
    .map((a) => ({ value: a.id, label: a.title ?? t("goal.jarFallback"), color: "#127c86", hint: `${Math.round((a.balance ?? 0) / 100)} ${currencySign(a.currency_code ?? 980)}` }));

  const busy = creating || updating;

  // Правило авто-поповнення діє лише для РУЧНОЇ цілі: у цілі-банки прогрес веде баланс
  // рахунку, тож авто-внесок поверх нього рахував би ті самі гроші двічі (сервер це відхиляє).
  const autoAllowed = !accountId;
  const autoNum = Number(autoValue.replace(",", "."));
  const autoReady = autoKind == null || (Number.isFinite(autoNum) && autoNum > 0 && (autoKind !== "income_pct" || autoNum <= 100));

  async function save() {
    if (!name.trim() || !(Number(target) > 0) || !autoReady) return;
    const auto = autoAllowed ? autoKind : null;
    const body: GoalBody = {
      name: name.trim(),
      target_amount: Math.round(Number(target.replace(",", ".")) * 100),
      account_id: accountId,
      current_amount: accountId ? 0 : Math.round(Number(current.replace(",", ".") || 0) * 100),
      deadline: deadline ? Math.floor(new Date(deadline).getTime() / 1000) : null,
      color, note: note.trim() || undefined,
      kind,
      autofill_kind: auto,
      // 'fixed' зберігається в копійках (як усі гроші), 'income_pct' — цілим відсотком.
      autofill_value: auto == null ? null : auto === "fixed" ? Math.round(autoNum * 100) : Math.round(autoNum),
    };
    if (editing && goal) await updateGoal({ id: goal.id, ...body }).unwrap();
    else await createGoal(body).unwrap();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-goal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{editing ? t("goalModal.editTitle") : t("goalModal.newTitle")}</h3>
          <button className="modal-x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("goalModal.nameLabel")}</span>
            <input autoFocus placeholder={t("goalModal.namePlaceholder")} value={name}
              onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="row" style={{ gap: 10 }}>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("goalModal.targetLabel")}, {sign}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("goalModal.deadlineLabel")}</span>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("goalModal.kindLabel")}</span>
            <Select value={kind} onChange={(v) => setKind(v as GoalKind)} options={KIND_OPTIONS(t)} />
          </label>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("goalModal.sourceLabel")}</span>
            <Select value={accountId} clearable clearLabel={t("goalModal.manualClear")} placeholder={t("goalModal.manualClear")}
              onChange={(v) => setAccountId(v == null ? null : String(v))} options={jarOptions} />
          </label>

          {!accountId && (
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">{t("goalModal.alreadySavedLabel")}, {sign}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
          )}

          {/* §P2.1 — авто-поповнення. Показуємо лише для ручної цілі: у цілі-банки прогрес
              веде банк, і поле тут обіцяло б те, чого сервер не зробить. */}
          {autoAllowed && (
            <div className="stack" style={{ gap: 5 }}>
              <span className="label">{t("goalModal.autofillLabel")}</span>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select value={autoKind} clearable clearLabel={t("goalModal.autofillOff")} placeholder={t("goalModal.autofillOff")}
                    onChange={(v) => setAutoKind(v == null ? null : (String(v) as AutofillKind))}
                    options={AUTOFILL_OPTIONS(t)} />
                </div>
                {autoKind && (
                  <input style={{ flex: 1, minWidth: 0 }} type="number" inputMode="decimal"
                    placeholder={autoKind === "income_pct" ? "10" : "1000"}
                    value={autoValue} onChange={(e) => setAutoValue(e.target.value)} />
                )}
              </div>
              {autoKind && <span className="ai-block-hint">{t(autoKind === "income_pct" ? "goalModal.autofillPctHint" : "goalModal.autofillFixedHint")}</span>}
            </div>
          )}

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">{t("goalModal.colorLabel")}</span>
            <div className="color-row">
              {PALETTE.map((cc) => (
                <button key={cc} type="button" className={`swatch ${color === cc ? "on" : ""}`}
                  style={{ background: cc }} onClick={() => setColor(cc)} aria-label={cc} />
              ))}
            </div>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("goalModal.noteLabel")}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("goalModal.notePlaceholder")} />
          </label>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !(Number(target) > 0) || !autoReady}>
              {editing ? t("common.save") : t("goalModal.createBtn")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
