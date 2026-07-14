import { useState } from "react";
import { useGetGoalsQuery, useDeleteGoalMutation, useGetAccountsQuery } from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Icon } from "../components/Icon.tsx";
import { GoalModal } from "../components/GoalModal.tsx";
import type { SavingsGoal } from "../store/api.ts";

const fmtDate = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", year: "numeric" });

function daysLeft(deadline: number | null): number | null {
  if (!deadline) return null;
  return Math.ceil((deadline - Date.now() / 1000) / 86400);
}

type ModalState = { open: boolean; goal: SavingsGoal | null; accountId?: string | null; name?: string };

// Цілі-накопичення (§7): скільки й до коли хочемо зібрати. Прогрес — вручну або з банки.
// Банки (jars) авто-показуються як цілі — задай їм суму одним кліком (§F3).
export function Goals() {
  const { data: goals = [] } = useGetGoalsQuery();
  const { data: accounts = [] } = useGetAccountsQuery();
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
          <div className="greet">Цілі</div>
          <div className="sub">Накопичення з прогресом. Банки — це теж цілі: задай їм суму.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setModal({ open: true, goal: null })}>＋ нова ціль</button>
        </div>
      </div>

      {hasAny ? (
        <div className="goal-grid">
          {jarGoals.map((a) => (
            <div key={a.id} className="goal-card goal-jar" style={{ "--goal-color": "var(--c-teal)" } as React.CSSProperties}>
              <div className="goal-top">
                <div className="goal-name">🏦 {a.title || "Банка"}</div>
              </div>
              <div className="goal-amounts">
                <span className="goal-cur"><Money minor={a.balance ?? 0} currency={a.currency_code ?? 980} decimals={false} /></span>
                <span className="goal-target">без цілі</span>
              </div>
              <div className="goal-bar"><div className="goal-fill" style={{ width: "0%" }} /></div>
              <button className="btn" style={{ padding: "7px 12px", fontSize: 13 }}
                onClick={() => setModal({ open: true, goal: null, accountId: a.id, name: a.title || "Банка" })}>
                Задати ціль
              </button>
            </div>
          ))}
          {goals.map((g) => (
            <GoalCard key={g.id} g={g} onEdit={() => setModal({ open: true, goal: g })} onDelete={() => deleteGoal(g.id)} />
          ))}
        </div>
      ) : (
        <div className="card empty" style={{ padding: 28 }}>
          Ще нема цілей. Натисни «нова ціль» — задай суму, дедлайн і (за бажанням) привʼяжи банку, щоб прогрес рахувався сам.
        </div>
      )}

      {modal.open && (
        <GoalModal goal={modal.goal} defaultAccountId={modal.accountId} defaultName={modal.name}
          onClose={() => setModal({ open: false, goal: null })} />
      )}
    </>
  );
}

function GoalCard({ g, onEdit, onDelete }: { g: SavingsGoal; onEdit: () => void; onDelete: () => void }) {
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
          <button className="icon-mini" onClick={onEdit} aria-label="Редагувати"><Icon name="edit" size={15} /></button>
          <button className="icon-mini" onClick={onDelete} aria-label="Видалити"><Icon name="trash" size={15} /></button>
        </div>
      </div>
      <div className="goal-amounts">
        <span className="goal-cur"><Money minor={g.current} decimals={false} /></span>
        <span className="goal-target">з <Money minor={g.target_amount} decimals={false} /></span>
      </div>
      <div className="goal-bar"><div className="goal-fill" style={{ width: `${pct}%` }} /></div>
      <div className="goal-foot">
        <span className="goal-pct">{pct}%</span>
        {done
          ? <span className="goal-meta pos">Ціль досягнута 🎉</span>
          : <span className="goal-meta">лишилось <Money minor={left} decimals={false} /></span>}
      </div>
      {perMonth != null && (
        <div className="goal-need">Щоб устигнути — відкладай <b><Money minor={perMonth} decimals={false} />/міс</b></div>
      )}
      {sprint && (
        <div className="goal-need urgent">Лишилось {dl} дн — зібрати <b><Money minor={left} decimals={false} /></b></div>
      )}
      <div className="goal-sub">
        {g.account_title ? <span className="goal-tag">🏦 {g.account_title}</span> : <span className="goal-tag">вручну</span>}
        {g.deadline && (
          <span className={`goal-tag ${dl != null && dl < 0 ? "neg" : ""}`}>
            до {fmtDate.format(g.deadline * 1000)}{dl != null && dl >= 0 ? ` · ${dl} дн` : dl != null ? " · прострочено" : ""}
          </span>
        )}
      </div>
      {g.note && <div className="goal-note">{g.note}</div>}
    </div>
  );
}
