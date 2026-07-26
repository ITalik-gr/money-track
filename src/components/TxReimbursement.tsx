import { useEffect, useState } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.tsx";
import { formatMinor, currencySign } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import {
  useGetReimbursementQuery,
  useGetReimbursementUsageQuery,
  useSetReimbursementMutation,
} from "../store/api.ts";
import type { ReimbursementTx } from "../store/api.ts";

// §COMPENSATION: «мені скинули за це гроші».
//
// Ти платиш за спільне, частину повертають. У витратах має лишитись лише твоя частина
// (`EFF_AMOUNT`, stats.ts), а прив'язана частина надходження перестає бути доходом.
//
// v2 (0030): одне надходження РОЗПОДІЛЯЄТЬСЯ між кількома витратами. Перша версія дозволяла
// прив'язати надходження рівно до однієї витрати й обрізала суму стелею витрати — на реальних
// даних «+2400 за витрату −1870» це означало, що 530 ₴ зависали: ні на іншу витрату, ні в дохід.
// Тепер береться рівно стільки, скільки треба, а залишок лишається вільним для інших витрат.
const dfmt = new Intl.DateTimeFormat(localeTag(getLocale()), { day: "2-digit", month: "short" });
const toMinor = (major: string) => Math.round(Number(major.replace(",", ".")) * 100) || 0;
const toMajor = (minor: number) => (Math.max(0, minor) / 100).toFixed(2);

export function TxReimbursement({ txId, amount, currency }: { txId: string; amount: number; currency: number }) {
  const t = useT();
  const { data } = useGetReimbursementQuery(txId);
  const [save, { isLoading }] = useSetReimbursementMutation();
  const [editing, setEditing] = useState(false);
  // Ключ присутній = надходження обране; значення = скільки саме з нього беремо (у гривнях).
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [manual, setManual] = useState("");
  const [manualMode, setManualMode] = useState(false);

  const total = Math.abs(amount);
  const sign = currencySign(currency);
  const current = data?.tx.reimbursed ?? 0;
  const linked = data?.linked ?? [];
  const has = current > 0 || linked.length > 0;

  // Вже прив'язані мусять лишитись у списку, інакше зняти позначку було б нічим — вони не
  // потрапляють у кандидатів (їх виключає `NOT IN`).
  const options: ReimbursementTx[] = [...linked, ...(data?.candidates ?? [])];
  const allocSum = Object.values(alloc).reduce((s, v) => s + toMinor(v), 0);
  const effective = manualMode ? toMinor(manual) : allocSum;
  const over = effective > total;
  const mine = Math.max(0, total - effective);

  useEffect(() => {
    if (!editing || !data) return;
    const next: Record<string, string> = {};
    for (const l of linked) if (l.allocated_here > 0) next[l.id] = toMajor(l.allocated_here);
    setAlloc(next);
    // Ручний режим вмикається сам, коли сума не пояснюється розподілами — інакше відкриття
    // редактора мовчки стерло б суму, введену руками.
    const fromLinks = linked.reduce((s, l) => s + l.allocated_here, 0);
    const manualOnly = current > 0 && current !== fromLinks;
    setManualMode(manualOnly);
    setManual(manualOnly ? toMajor(current - fromLinks) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, data]);

  // Позначаючи надходження, беремо рівно скільки треба й скільки в нього лишилось вільним.
  function toggle(o: ReimbursementTx, on: boolean) {
    setAlloc((prev) => {
      const next = { ...prev };
      if (!on) { delete next[o.id]; return next; }
      const takenElsewhere = Object.entries(prev).reduce((s, [, v]) => s + toMinor(v), 0);
      const need = Math.max(0, total - takenElsewhere);
      const free = o.available + o.allocated_here; // власний внесок не рахуємо як зайнятий
      next[o.id] = toMajor(Math.min(free, need));
      return next;
    });
  }

  async function commit(clear = false) {
    try {
      // Вкладки взаємовиключні: у ручному режимі розподіли знімаємо. Інакше збережений стан
      // не відповідав би екрану — сума вписана руками, а надходження тихо лишились прив'язаними.
      await save({
        id: txId,
        manual_amount: clear ? 0 : manualMode ? toMinor(manual) : 0,
        allocations: clear || manualMode ? [] : Object.entries(alloc).map(([source_id, v]) => ({ source_id, amount: toMinor(v) })),
      }).unwrap();
      toast.success(clear ? t("rb.toastCleared") : t("rb.toastSaved"));
      setEditing(false);
    } catch (e) { toast.error(errText(e)); }
  }

  if (amount >= 0) return null;

  if (has && !editing) {
    return (
      <div className="card split-card">
        <div className="section-head">
          <h3>{t("rb.title")}</h3>
          <button className="btn sm ghost" onClick={() => setEditing(true)}>{t("common.edit")}</button>
        </div>
        <div className="rb-summary">
          <div className="rb-fig">
            <span className="label">{t("rb.yourShare")}</span>
            <span className="rb-mine">{formatMinor(total - current, { decimals: false })} {sign}</span>
          </div>
          <div className="rb-fig">
            <span className="label">{t("rb.reimbursedLabel")}</span>
            <span className="rb-back">{formatMinor(current, { decimals: false })} {sign}</span>
          </div>
        </div>
        <div className="rb-bar">
          <span className="rb-bar-mine" style={{ width: `${Math.round(((total - current) / (total || 1)) * 100)}%` }} />
        </div>
        {linked.length > 0 && (
          <div className="split-view" style={{ marginTop: 10 }}>
            {linked.map((l) => (
              <div className="split-vrow" key={l.id}>
                <span className="split-cat">
                  <Link to={`/tx/${l.id}`}>{l.label}</Link> <span className="muted">· {dfmt.format(l.time * 1000)}</span>
                </span>
                <span className="split-amt">
                  {formatMinor(l.allocated_here, { decimals: false })} {sign}
                  {/* Видно, що взято ЧАСТИНУ надходження, а решта лишилась вільною для інших витрат. */}
                  {l.allocated_here < l.amount && (
                    <span className="muted"> {t("rb.ofAmount", { amount: `${formatMinor(l.amount, { decimals: false })} ${sign}` })}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="split-empty-s" style={{ marginTop: 10 }}>
          {t("rb.countedInExpenses", { amount: `${formatMinor(total - current, { decimals: false })} ${sign}` })}
          {linked.length > 0 ? t("rb.usedNotIncome") : ""}
        </p>
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => commit(true)} disabled={isLoading}>{t("rb.removeBtn")}</button>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="card split-card">
        <div className="split-empty">
          <div>
            <div className="split-empty-t">{t("rb.emptyTitle")}</div>
            <div className="split-empty-s">{t("rb.emptyDesc")}</div>
          </div>
          <button className="btn sm" onClick={() => setEditing(true)}><Icon name="repeat" /> {t("rb.specifyBtn")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card split-card">
      <div className="section-head"><h3>{t("rb.title")}</h3></div>

      <div className="rb-modes" role="tablist">
        <button role="tab" aria-selected={!manualMode} className={`rb-mode${manualMode ? "" : " on"}`} onClick={() => setManualMode(false)}>
          {t("rb.modeBank")}
        </button>
        <button role="tab" aria-selected={manualMode} className={`rb-mode${manualMode ? " on" : ""}`} onClick={() => setManualMode(true)}>
          {t("rb.modeCash")}
        </button>
      </div>

      {manualMode ? (
        <label className="stack" style={{ gap: 5 }}>
          <span className="label">{t("rb.howMuchReturned", { sign })}</span>
          <input inputMode="decimal" value={manual} placeholder="0.00" autoFocus onChange={(e) => setManual(e.target.value)} />
        </label>
      ) : options.length > 0 ? (
        <>
          <span className="label">{t("rb.candidatesHint")}</span>
          <div className="rb-cands">
            {options.map((o) => {
              const on = o.id in alloc;
              const free = o.available + o.allocated_here;
              const partial = free < o.amount;
              return (
                <div key={o.id} className={`rb-cand${on ? " on" : ""}`}>
                  <label className="rb-cand-pick">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(o, e.target.checked)} />
                    <span className="rb-cand-main">
                      <span className="rb-cand-name">{o.label}</span>
                      <span className="rb-cand-sub">
                        {dfmt.format(o.time * 1000)}{o.account_title ? ` · ${o.account_title}` : ""}
                        {partial && ` · ${t("rb.freeOf", { free: formatMinor(free, { decimals: false }), amount: formatMinor(o.amount, { decimals: false }) })}`}
                      </span>
                    </span>
                    <span className="rb-cand-amt">+{formatMinor(o.amount, { decimals: false })} {sign}</span>
                  </label>
                  {/* Скільки взяти з цього надходження. Підставляється автоматично, але
                      редагується: одне надходження може покривати кілька витрат. */}
                  {on && (
                    <div className="rb-take">
                      <span className="label">{t("rb.takeFromHere")}</span>
                      <div className="split-amt-in">
                        <input inputMode="decimal" value={alloc[o.id]} placeholder="0.00"
                          onChange={(e) => setAlloc((p) => ({ ...p, [o.id]: e.target.value }))} />
                        <span className="split-sign">{sign}</span>
                      </div>
                      {toMinor(alloc[o.id]) > free && (
                        <span className="rb-take-err">{t("rb.tooMuchFree", { free: formatMinor(free, { decimals: false }) })}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="split-empty-s">{t("rb.noCandidates")}</p>
      )}

      <div className="rb-preview">
        {effective > 0 && !over && (
          <div className="rb-bar">
            <span className="rb-bar-mine" style={{ width: `${Math.round((mine / (total || 1)) * 100)}%` }} />
          </div>
        )}
        <div className={`split-remainder ${over ? "" : effective <= 0 ? "idle" : "ok"}`}>
          {over
            ? t("rb.tooMuch", { effective: `${formatMinor(effective, { decimals: false })} ${sign}`, total: `${formatMinor(total, { decimals: false })} ${sign}` })
            : effective <= 0
              ? t("rb.nothingYet", { total: `${formatMinor(total, { decimals: false })} ${sign}` })
              : t("rb.previewShare", { mine: `${formatMinor(mine, { decimals: false })} ${sign}`, total: `${formatMinor(total, { decimals: false })} ${sign}`, effective: `${formatMinor(effective, { decimals: false })} ${sign}` })}
        </div>
      </div>

      <div className="split-actions">
        <button className="btn sm ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
        <button className="btn sm primary" disabled={isLoading || over || effective <= 0} onClick={() => commit()}>{t("common.save")}</button>
      </div>
    </div>
  );
}

/**
 * Зворотний бік для НАДХОДЖЕННЯ: куди воно пішло і скільки з нього ще вільно.
 * Без цього блока нерозподілений залишок («скинули 2400, використано 1870») ніде не видно,
 * і незрозуміло, чому в доході стоїть не вся сума.
 */
export function TxReimbursementUsage({ txId, amount, currency }: { txId: string; amount: number; currency: number }) {
  const t = useT();
  const { data } = useGetReimbursementUsageQuery(txId, { skip: amount <= 0 });
  if (amount <= 0 || !data || data.allocated <= 0) return null;
  const sign = currencySign(currency);

  return (
    <div className="card split-card">
      <div className="section-head"><h3>{t("rb.coveredByTitle")}</h3></div>
      <div className="split-view">
        {data.used.map((u) => (
          <div className="split-vrow" key={u.id}>
            <span className="split-cat">
              <Link to={`/tx/${u.id}`}>{u.label}</Link> <span className="muted">· {dfmt.format(u.time * 1000)}</span>
            </span>
            <span className="split-amt">{formatMinor(u.amount, { decimals: false })} {sign}</span>
          </div>
        ))}
      </div>
      <p className="split-empty-s" style={{ marginTop: 10 }}>
        {data.available > 0
          ? t("rb.stillFree", { avail: `${formatMinor(data.available, { decimals: false })} ${sign}` })
          : t("rb.fullyAllocated")}
      </p>
    </div>
  );
}
