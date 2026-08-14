import { useRef, useState } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useNavigate, useParams } from "react-router-dom";
import { useGetEventQuery, useEvaluateGroupMutation, useChatGroupMutation, useAddEventPlannedMutation, useDeleteEventPlannedMutation } from "../store/api.ts";
import type { StructuredInsight, TxRow } from "../store/api.ts";
import type { TranslationKey } from "../i18n/index.ts";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { TransactionList } from "../components/transactions/TransactionList.tsx";
import { EventBudget } from "../components/planning/EventBudget.tsx";
import { EventGoalLink } from "../components/planning/EventGoalLink.tsx";
import { GROUP_KINDS } from "../components/planning/GroupModal.tsx";
import { renderMarkdown } from "../lib/markdown.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT, translate } from "../i18n/index.ts";

const kindLabel = (k: string | null) => {
  const found = GROUP_KINDS.find((x) => x.value === k);
  return translate(getLocale(), found?.labelKey ?? "evt.groupFallback");
};

// Деталь групи: зліва підсумок + транзакції, справа — AI-панель (оцінка групи + чат по ній).
export function EventDetail() {
  const t = useT();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useGetEventQuery(Number(id), { skip: !id });

  if (isLoading) return <div className="empty">{t("common.loading")}</div>;
  if (!data?.event) return <div className="card empty">{t("evt.notFound")}</div>;

  // Суми беремо з сервера (зведені в ₴), а не рахуємо тут — інакше сторінка й список груп
  // розходяться на валютних операціях.
  const { event, transactions, spent, income, planned, planned_total } = data;
  const color = event.color ?? "var(--accent)";

  return (
    <>
      <div className="section-head">
        <button className="btn ghost xs" style={{ marginLeft: -8 }} onClick={() => navigate(-1)}>← {t("evt.back")}</button>
      </div>

      <div className="card group-detail-head" style={{ "--group-color": color } as React.CSSProperties}>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <span className="group-ico" style={{ background: color }}><Icon name="folder" size={20} /></span>
          <div>
            <div className="greet" style={{ fontSize: 22 }}>{event.name}</div>
            <div className="sub">{kindLabel(event.kind)} · {t("evt.txCount", { n: transactions.length })}</div>
          </div>
        </div>
        {event.note && <p className="group-detail-note">{event.note}</p>}
        <div className="group-detail-stats">
          <div><div className="label">{t("evt.spentLabel")}</div><div className="num-hero" style={{ fontSize: 24 }}><Money minor={spent} decimals={false} /></div></div>
          {income > 0 && <div><div className="label">{t("evt.receivedLabel")}</div><div className="num-hero pos" style={{ fontSize: 24 }}><Money minor={income} decimals={false} /></div></div>}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <EventBudget id={Number(id)} spent={spent} budget={event.budget} />
      </div>

      <div style={{ marginTop: 14 }}>
        <EventGoalLink id={Number(id)} spent={spent} goalId={event.goal_id} />
      </div>

      <div style={{ marginTop: 14 }}>
        <EventPlan eventId={Number(id)} kind={event.kind} planned={planned} plannedTotal={planned_total} spent={spent} />
      </div>

      <div className="evt-grid">
        <div>
          <div className="section-head" style={{ marginTop: 18 }}><h2>{t("evt.groupTxTitle")}</h2></div>
          <TransactionList rows={transactions as TxRow[]} />
        </div>
        <div>
          <div className="section-head" style={{ marginTop: 18 }}><h2>{t("evt.aiAboutGroupTitle")}</h2></div>
          <GroupAiPanel eventId={Number(id)} groupName={event.name} />
        </div>
      </div>
    </>
  );
}

// Starter plans by group kind (P2.3): label key + a rough ₴ estimate the user then edits.
const PLAN_TEMPLATES: Record<string, [TranslationKey, number][]> = {
  trip: [["evt.tpl.flights", 8000], ["evt.tpl.stay", 6000], ["evt.tpl.food", 4000], ["evt.tpl.transport", 1500], ["evt.tpl.activities", 2000]],
  project: [["evt.tpl.materials", 5000], ["evt.tpl.labor", 4000], ["evt.tpl.tools", 1500]],
  event: [["evt.tpl.venue", 3000], ["evt.tpl.foodDrinks", 4000], ["evt.tpl.gifts", 1500], ["evt.tpl.decor", 1000]],
};

interface PlanItem { id: number; label: string; amount: number; category_id: number | null; category_name: string | null }

// Plan vs actual (P2.3): an itemized estimate for the event compared to the ₴ roll-up of tagged
// transactions. Amounts are ₴, so they line up directly with `spent` from the server.
function EventPlan({ eventId, kind, planned, plannedTotal, spent }: {
  eventId: number; kind: string | null; planned: PlanItem[]; plannedTotal: number; spent: number;
}) {
  const t = useT();
  const [addPlanned] = useAddEventPlannedMutation();
  const [delPlanned] = useDeleteEventPlannedMutation();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");

  const hasPlan = planned.length > 0;
  const over = plannedTotal > 0 && spent > plannedTotal;
  const fill = plannedTotal > 0 ? Math.min(100, (spent / plannedTotal) * 100) : 0;
  const template = kind ? PLAN_TEMPLATES[kind] : undefined;

  async function add() {
    const amt = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!label.trim() || !amt || amt <= 0) return;
    try { await addPlanned({ id: eventId, label: label.trim(), amount: amt }).unwrap(); setLabel(""); setAmount(""); }
    catch (e) { toast.error(errText(e)); }
  }

  async function seedTemplate() {
    if (!template) return;
    try { for (const [k, uah] of template) await addPlanned({ id: eventId, label: t(k), amount: uah * 100 }).unwrap(); }
    catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card evt-plan">
      <div className="section-head" style={{ marginBottom: 10 }}>
        <h2>{t("evt.plan.title")}</h2>
        {hasPlan && (
          <span className={`evt-plan-tag ${over ? "neg" : "pos"}`}>
            {over ? t("evt.plan.over") : t("evt.plan.left")}: <Money minor={Math.abs(plannedTotal - spent)} decimals={false} />
          </span>
        )}
      </div>

      {hasPlan && (
        <div className="evt-plan-bar-wrap">
          <div className="evt-plan-bar"><span className={over ? "over" : ""} style={{ width: `${fill}%` }} /></div>
          <div className="evt-plan-nums">
            <span>{t("evt.plan.planned")} <b><Money minor={plannedTotal} decimals={false} /></b></span>
            <span>{t("evt.plan.actual")} <b><Money minor={spent} decimals={false} /></b></span>
          </div>
        </div>
      )}

      {hasPlan ? (
        <ul className="evt-plan-items">
          {planned.map((p) => (
            <li key={p.id}>
              <span className="pl-label">{p.label}{p.category_name && <span className="muted"> · {p.category_name}</span>}</span>
              <span className="pl-amt"><Money minor={p.amount} decimals={false} /></span>
              <button className="pl-del" onClick={() => delPlanned({ id: eventId, pid: p.id })} aria-label={t("common.delete")}><Icon name="close" size={12} /></button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="evt-plan-empty">
          <p className="muted">{t("evt.plan.empty")}</p>
          {template && <button className="btn ghost sm" onClick={seedTemplate}><Icon name="spark" size={13} /> {t("evt.plan.useTemplate")}</button>}
        </div>
      )}

      <div className="evt-plan-add">
        <input placeholder={t("evt.plan.labelPh")} value={label} onChange={(e) => setLabel(e.target.value)} />
        <input type="number" inputMode="decimal" placeholder="₴" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="btn primary sm" onClick={add} disabled={!label.trim() || !amount}>{t("evt.plan.add")}</button>
      </div>
    </div>
  );
}

type Msg = { role: "user" | "assistant"; content: string };

function GroupAiPanel({ eventId, groupName }: { eventId: number; groupName: string }) {
  const t = useT();
  const [evaluate, { isLoading: evaluating }] = useEvaluateGroupMutation();
  const [chatGroup, { isLoading: chatting }] = useChatGroupMutation();
  const [evalResult, setEvalResult] = useState<StructuredInsight | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);

  async function runEval() {
    try { setEvalResult(await evaluate(eventId).unwrap()); }
    catch (e) { toast.error(errText(e)); }
  }

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || chatting || sending.current) return;
    sending.current = true;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    try {
      const r = await chatGroup({ id: eventId, messages: next }).unwrap();
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: t("evt.chatFailedFallback") }]);
    } finally { sending.current = false; }
  }

  return (
    <div className="card grp-ai">
      <p className="grp-ai-hint">{t("evt.aiHint")}</p>
      <button className="btn primary" style={{ width: "100%" }} disabled={evaluating} onClick={runEval}>
        {evaluating ? t("evt.analyzingBtn") : <><Icon name="spark" size={15} />{evalResult ? t("evt.evalAgainBtn") : t("evt.evalGroupBtn")}</>}
      </button>

      {evalResult && (
        <div className="grp-eval">
          <div className="grp-eval-head">{renderMarkdown(evalResult.headline)}</div>
          <div className="grp-eval-facts">
            {(evalResult.facts ?? []).map((f, i) => (
              <div key={i} className="grp-fact">
                <span className={`grp-fact-dot ${f.tone ?? "neutral"}`} />
                <span className="grp-fact-label">{renderMarkdown(f.label)}</span>
                {f.amount != null && <span className="grp-fact-amt">{f.amount.toLocaleString(localeTag(getLocale()))} ₴</span>}
              </div>
            ))}
          </div>
          {evalResult.note && <div className="grp-eval-note">💡 {renderMarkdown(evalResult.note)}</div>}
        </div>
      )}

      <div className="grp-chat">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === "assistant" ? renderMarkdown(m.content) : m.content}
          </div>
        ))}
        {chatting && <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>}
      </div>

      <div className="grp-chat-input">
        <input placeholder={t("tx.chatInputPlaceholder", { name: groupName })} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <button className="btn primary" onClick={() => send()} disabled={chatting || !input.trim()} aria-label={t("tx.chatSend")}>➤</button>
      </div>
    </div>
  );
}
