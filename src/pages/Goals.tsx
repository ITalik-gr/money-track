import { useState } from "react";
import { dateFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import {
  useGetGoalsQuery, useDeleteGoalMutation, useGetAccountsQuery,
  useGetGoalContributionsQuery, useAddGoalContributionMutation, useDeleteGoalContributionMutation,
} from "../store/api.ts";
import { GoalGridSkeleton } from "../components/ui/Skeleton.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { GoalModal } from "../components/planning/GoalModal.tsx";
import type { SavingsGoal } from "../store/api.ts";

const fmtDate = dateFmt({ day: "numeric", month: "short", year: "numeric" });

function daysLeft(deadline: number | null): number | null {
  if (!deadline) return null;
  return Math.ceil((deadline - Date.now() / 1000) / 86400);
}

type ModalState = { open: boolean; goal: SavingsGoal | null; accountId?: string | null; name?: string };

// Цілі-накопичення (§7): скільки й до коли хочемо зібрати. Прогрес — вручну або з банки.
// Банки (jars) авто-показуються як цілі — задай їм суму одним кліком (§F3).
export function Goals() {
  const t = useT();
  // `isLoading` окремо від даних: із дефолтом `= []` порожній акаунт і незавершений запит
  // малювали ОДИН екран («Цілей ще немає»), тож перше відкриття читалось як «нічого нема».
  const { data: goals = [], isLoading: loadingGoals } = useGetGoalsQuery();
  const { data: accounts = [], isLoading: loadingAccounts } = useGetAccountsQuery();
  const loading = loadingGoals || loadingAccounts;
  const [deleteGoal] = useDeleteGoalMutation();
  const [modal, setModal] = useState<ModalState>({ open: false, goal: null });

  // Банки без привʼязаної цілі — показуємо як «незадані цілі».
  const linkedJars = new Set(goals.map((g) => g.account_id).filter(Boolean));
  const jarGoals = accounts.filter((a) => a.type === "jar" && !linkedJars.has(a.id));
  const hasAny = goals.length > 0 || jarGoals.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("nav.goals")}</div>
          <div className="sub">{t("goal.sub")}</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setModal({ open: true, goal: null })}>＋ {t("goal.addNew")}</button>
        </div>
      </div>

      {loading ? <GoalGridSkeleton /> : hasAny ? (
        <div className="goal-grid">
          {jarGoals.map((a) => (
            <div key={a.id} className="goal-card goal-jar" style={{ "--goal-color": "var(--c-teal)" } as React.CSSProperties}>
              <div className="goal-top">
                <div className="goal-name">🏦 {a.title || t("goal.jarFallback")}</div>
              </div>
              <div className="goal-amounts">
                <span className="goal-cur"><Money minor={a.balance ?? 0} currency={a.currency_code ?? 980} decimals={false} /></span>
                <span className="goal-target">{t("goal.noTarget")}</span>
              </div>
              <div className="goal-bar"><div className="goal-fill" style={{ width: "0%" }} /></div>
              <button className="btn sm"
                onClick={() => setModal({ open: true, goal: null, accountId: a.id, name: a.title || t("goal.jarFallback") })}>
                {t("goal.setGoalBtn")}
              </button>
            </div>
          ))}
          {goals.map((g) => (
            <GoalCard key={g.id} g={g} onEdit={() => setModal({ open: true, goal: g })} onDelete={() => deleteGoal(g.id)} />
          ))}
        </div>
      ) : (
        <div className="card empty" style={{ padding: 28 }}>{t("goal.emptyHint")}</div>
      )}

      {modal.open && (
        <GoalModal goal={modal.goal} defaultAccountId={modal.accountId} defaultName={modal.name}
          onClose={() => setModal({ open: false, goal: null })} />
      )}
    </>
  );
}

/**
 * §P2.1 — внески в ціль: додати рух і побачити історію.
 *
 * Історія згорнута за замовчуванням: на екрані з шістьма цілями шість розгорнутих списків —
 * це стіна, у якій самі цілі губляться. Кнопка «+» завжди видима, бо саме вона тут дія.
 */
function GoalContribs({ goalId }: { goalId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  // `skip`, поки згорнуто: історія потрібна рівно тому, хто її відкрив.
  const { data: items = [] } = useGetGoalContributionsQuery(goalId, { skip: !open });
  const [add, { isLoading }] = useAddGoalContributionMutation();
  const [del] = useDeleteGoalContributionMutation();

  async function submit() {
    // Кома як десятковий роздільник — на українській розкладці її вводять частіше за крапку.
    const major = Number(amount.replace(",", "."));
    if (!Number.isFinite(major) || major === 0) return;
    try {
      await add({ id: goalId, amount: Math.round(major * 100) }).unwrap();
      setAmount("");
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="goal-contrib">
      <div className="row" style={{ gap: 6 }}>
        <input
          className="gc-input"
          inputMode="decimal"
          placeholder={t("goal.contribPlaceholder")}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn sm" disabled={!amount || isLoading} onClick={submit}>{t("goal.contribAdd")}</button>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? t("goal.contribHide") : t("goal.contribHistory")}</button>
      </div>
      {open && (
        items.length ? (
          <ul className="gc-list">
            {items.map((c) => (
              <li key={c.id}>
                <span className={c.amount < 0 ? "neg" : "pos"}>
                  {c.amount > 0 ? "+" : ""}<Money minor={c.amount} decimals={false} />
                </span>
                <span className="gc-date">{fmtDate.format(c.at * 1000)}</span>
                <button className="gc-del" aria-label={t("common.delete")} onClick={() => del({ id: goalId, cid: c.id })}>×</button>
              </li>
            ))}
          </ul>
        ) : <div className="gc-empty">{t("goal.contribEmpty")}</div>
      )}
    </div>
  );
}

function GoalCard({ g, onEdit, onDelete }: { g: SavingsGoal; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  const ratio = g.target_amount > 0 ? Math.min(g.current / g.target_amount, 1) : 0;
  const pct = Math.round(ratio * 100);
  const left = Math.max(0, g.target_amount - g.current);
  const dl = daysLeft(g.deadline);
  const color = g.color ?? "var(--accent)";
  const done = g.current >= g.target_amount;

  // §P5: скільки відкладати на місяць, щоб устигнути до дедлайну = залишок ÷ місяців до дати.
  // <1 міс до дедлайну — показуємо «зібрати X за N дн» (місячна ставка вводила б в оману).
  const monthsLeft = g.deadline != null ? (g.deadline - Date.now() / 1000) / (86400 * 30.44) : null;
  const perMonth = !done && left > 0 && monthsLeft != null && monthsLeft >= 1 ? Math.round(left / monthsLeft) : null;
  const sprint = !done && left > 0 && dl != null && dl >= 0 && (monthsLeft == null || monthsLeft < 1);
  return (
    <div className="goal-card" style={{ "--goal-color": color } as React.CSSProperties}>
      <div className="goal-top">
        <div className="goal-name">{g.name}{done && <span className="goal-done">✓</span>}</div>
        <div className="goal-actions">
          <button className="icon-mini" onClick={onEdit} aria-label={t("common.edit")}><Icon name="edit" size={15} /></button>
          <button className="icon-mini" onClick={onDelete} aria-label={t("common.delete")}><Icon name="trash" size={15} /></button>
        </div>
      </div>
      <div className="goal-amounts">
        <span className="goal-cur"><Money minor={g.current} decimals={false} /></span>
        <span className="goal-target">{t("goal.ofTarget")} <Money minor={g.target_amount} decimals={false} /></span>
      </div>
      <div className="goal-bar"><div className="goal-fill" style={{ width: `${pct}%` }} /></div>
      <div className="goal-foot">
        <span className="goal-pct">{pct}%</span>
        {done
          ? <span className="goal-meta pos">{t("goal.achieved")}</span>
          : <span className="goal-meta">{t("goal.leftPrefix")} <Money minor={left} decimals={false} /></span>}
      </div>
      {perMonth != null && (
        <div className="goal-need">{t("goal.needSaveMonthly")} <b><Money minor={perMonth} decimals={false} />{t("goal.perMonthSuffix")}</b></div>
      )}
      {sprint && (
        <div className="goal-need urgent">{t("goal.leftDaysPrefix", { days: dl })} <b><Money minor={left} decimals={false} /></b></div>
      )}
      <div className="goal-sub">
        {g.account_title ? <span className="goal-tag">🏦 {g.account_title}</span> : <span className="goal-tag">{t("goal.manualTag")}</span>}
        {/* Тип показуємо, лише коли він НЕ дефолтний: підпис «накопичення» на кожній картці —
            це шум, бо він і так є нормою. Виняток інформативний, норма — ні. */}
        {g.kind && g.kind !== "save_up" && <span className="goal-tag">{t(`goal.kind.${g.kind}` as const)}</span>}
        {/* Авто-поповнення — обіцянка, що гроші додаються без тебе; про неї треба бачити,
            не відкриваючи форму. */}
        {g.autofill_kind && (
          <span className="goal-tag auto">↻ {g.autofill_kind === "income_pct"
            ? t("goal.autofillPctTag", { pct: g.autofill_value ?? 0 })
            : t("goal.autofillFixedTag", { amount: Math.round((g.autofill_value ?? 0) / 100) })}</span>
        )}
        {g.deadline && (
          <span className={`goal-tag ${dl != null && dl < 0 ? "neg" : ""}`}>
            {t("goal.untilPrefix")} {fmtDate.format(g.deadline * 1000)}{dl != null && dl >= 0 ? t("goal.daysSuffix", { days: dl }) : dl != null ? t("goal.overdue") : ""}
          </span>
        )}
      </div>
      {g.note && <div className="goal-note">{g.note}</div>}
      {/* Внески — лише для РУЧНОЇ цілі: прогрес цілі-банки веде баланс рахунку, і ручний
          внесок поверх нього рахував би ті самі гроші двічі (сервер це теж відхиляє). */}
      {!g.account_id && <GoalContribs goalId={g.id} />}
    </div>
  );
}
