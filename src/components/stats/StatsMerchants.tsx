/**
 * Statistics → Merchants: who was paid, and under which group or card.
 *
 * Split out of `src/pages/Stats.tsx` on 2026-08-08. That file was 1 379 lines — the largest in the
 * project — and it had stopped being a page: it was five pages sharing a header. The cut follows
 * the TABS, because that is the boundary the user already sees and the one that decides what is
 * on screen; any other cut would have produced files nobody could name.
 *
 * `Stats.tsx` keeps what all five genuinely share: the period, the currency, the one
 * `/analytics/overview` request they all read. Everything a single tab owns lives here.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetSparkQuery } from "../../store/api.ts";
import type { Overview } from "../../store/api.ts";
import { MerchantLogo } from "../ui/MerchantLogo.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Icon } from "../ui/Icon.tsx";
import { cardKind, cardKindLabel, cardLast4 } from "../../lib/merchant.ts";
import { SliceDrillPanel, type Cur } from "./shared.tsx";

// §R2-ST3+ST5(б) / §P3: Топ мерчантів — рядки-лінки на сторінку мерчанта (уся історія,
// тренд, середній чек, частка в категорії). Раніше клік розкривав інлайн-дрил операцій —
// сторінка мерчанта багатша, тож ведемо туди.
export function MerchantsBlock({ data, sign, merchMax }: {
  data: Overview; sign: string; merchMax: number;
}) {
  const t = useT();
  const { data: spark } = useGetSparkQuery();
  return (
    <section>
      <div className="section-head"><h2>{t("stats.merchants.title")}</h2><InfoTip>{t("stats.merchants.tip")}</InfoTip><span className="label">{t("stats.byCategory.click")}</span></div>
      {data.byMerchant.length ? (
        <div className="card flush"><div className="mrows">
          {data.byMerchant.slice(0, 7).map((m, i) => (
            <Link key={i} to={`/merchant/${encodeURIComponent(m.merchant)}`} className="mrow mrow-link">
              <MerchantLogo merchant={m.merchant} color="var(--accent)" fallbackLabel={m.merchant} />
              <div className="m-body">
                <div className="m-name">{m.merchant}</div>
                <div className="m-track"><div className="m-fill" style={{ width: `${(m.spent / merchMax) * 100}%` }} /></div>
              </div>
              {spark?.merchants[m.merchant] && <Sparkline values={spark.merchants[m.merchant]} color="var(--accent)" />}
              <div style={{ textAlign: "right" }}>
                <div className="m-val">{formatMinor(m.spent, { decimals: false })} {sign}</div>
                <div className="m-sub">{t("stats.merchants.avgSub", { n: m.n, amount: formatMinor(Math.round(m.spent / m.n), { decimals: false }), sign })}</div>
              </div>
            </Link>
          ))}
        </div></div>
      ) : <div className="card empty">{t("stats.merchants.empty")}</div>}
    </section>
  );
}

// §R2-ST3+ST5(б): По групах — клік розкриває операції; лінк «відкрити групу» всередині.
export function EventsBlock({ data, from, to, currency, sign }: {
  data: Overview; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  // ROADMAP L3: this block shares a `.stats-2col` row with the merchants block, so returning
  // null left the whole right half of the tab blank — read as broken layout, not as "no groups".
  if (!data.byEvent || data.byEvent.length === 0) {
    return (
      <section>
        <div className="section-head"><h2>{t("stats.events.title")}</h2><span className="label">{t("stats.events.sub")}</span></div>
        <EmptyCard icon="folder" title={t("empty.events.title")} hint={t("empty.events.hint")}
          to="/events" action={t("empty.events.action")} />
      </section>
    );
  }
  const max = Math.max(...data.byEvent.map((e) => e.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.events.title")}</h2><span className="label">{t("stats.events.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {data.byEvent.map((e) => {
          const isOpen = open === e.event_id;
          return (
            <div key={e.event_id}>
              <button type="button" className={`catbar catbar-btn ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : e.event_id)}>
                <span className="cb-name"><span className="d" style={{ background: e.event_color ?? "var(--accent)" }} />{e.event_name}</span>
                <span className="cb-track"><span className="cb-fill" style={{ width: `${(e.spent / max) * 100}%`, background: e.event_color ?? "var(--accent)" }} /></span>
                <span className="cb-val">{formatMinor(e.spent, { decimals: false })} {sign}</span>
                <span className="cb-pct">{e.n}</span>
              </button>
              {isOpen && <SliceDrillPanel dim="event" value={String(e.event_id)} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}

// §R2-ST3+ST5(б): По картках — клік розкриває операції зрізу.
export function AccountsBlock({ data, from, to, currency, sign }: {
  data: Overview; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (data.byAccount.length <= 1) return null;
  const max = Math.max(...data.byAccount.map((a) => a.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.accounts.title")}</h2><InfoTip>{t("stats.accounts.tip")}</InfoTip><span className="label">{t("stats.accounts.click")}</span></div>
      <div className="card flush"><div className="mrows">
        {data.byAccount.map((a, i) => {
          const key = a.account_id ?? String(i);
          const isOpen = open === key;
          const kind = cardKind(a.account_title ?? a.account_type ?? null);
          const last4 = cardLast4(a.account_title);
          return (
            <div key={key}>
              <button type="button" className={`mrow mrow-btn ${isOpen ? "open" : ""}`}
                disabled={!a.account_id} onClick={() => a.account_id && setOpen(isOpen ? null : key)}>
                <span className={`acct-badge ${kind}`}><Icon name="accounts" size={18} /></span>
                <div className="m-body">
                  <div className="m-name">
                    {cardKindLabel(kind)}
                    {last4 && <span className="acct-pan">{last4}</span>}
                  </div>
                  <div className="m-track"><div className="m-fill" style={{ width: `${(a.spent / max) * 100}%` }} /></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="m-val">{formatMinor(a.spent, { decimals: false })} {sign}</div>
                  <div className="m-sub">{t("stats.accounts.nTx", { n: a.n })}</div>
                </div>
              </button>
              {isOpen && a.account_id && <SliceDrillPanel dim="account" value={a.account_id} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}
