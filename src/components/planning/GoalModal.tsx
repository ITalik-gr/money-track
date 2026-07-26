import { useEffect, useState } from "react";
import { useCreateGoalMutation, useUpdateGoalMutation, useGetAccountsQuery } from "../store/api.ts";
import { useT } from "../i18n/index.ts";
import { Select } from "./Select.tsx";
import type { SavingsGoal } from "../store/api.ts";

const PALETTE = ["#2e6be6", "#127c86", "#1f6e4c", "#7a3e9d", "#c2417a", "#b23a2e", "#c9871a", "#0e7490"];

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

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Джерело прогресу — банки (накопичення).
  const jarOptions = accounts
    .filter((a) => a.type === "jar")
    .map((a) => ({ value: a.id, label: a.title ?? t("goal.jarFallback"), color: "#127c86", hint: `${Math.round((a.balance ?? 0) / 100)} ₴` }));

  const busy = creating || updating;

  async function save() {
    if (!name.trim() || !(Number(target) > 0)) return;
    const body = {
      name: name.trim(),
      target_amount: Math.round(Number(target.replace(",", ".")) * 100),
      account_id: accountId,
      current_amount: accountId ? 0 : Math.round(Number(current.replace(",", ".") || 0) * 100),
      deadline: deadline ? Math.floor(new Date(deadline).getTime() / 1000) : null,
      color, note: note.trim() || undefined,
    };
    if (editing && goal) await updateGoal({ id: goal.id, ...body }).unwrap();
    else await createGoal(body).unwrap();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
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
              <span className="label">{t("goalModal.targetLabel")}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("goalModal.deadlineLabel")}</span>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("goalModal.sourceLabel")}</span>
            <Select value={accountId} clearable clearLabel={t("goalModal.manualClear")} placeholder={t("goalModal.manualClear")}
              onChange={(v) => setAccountId(v == null ? null : String(v))} options={jarOptions} />
          </label>

          {!accountId && (
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">{t("goalModal.alreadySavedLabel")}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
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
            <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !(Number(target) > 0)}>
              {editing ? t("common.save") : t("goalModal.createBtn")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
