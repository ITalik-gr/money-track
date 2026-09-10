/**
 * §FLOOR — what a month costs with no decisions in it, and how long the cushion covers THAT.
 *
 * The owner's complaint that produced §BURN-SHAPE was «порадник каже я 44к в місяць витрачаю, але
 * такого і близько немає». The split answered it — his 44 784 is 28 707 that repeats plus 16 077
 * of quarterly tax, electronics and a dentist — and then went almost nowhere: the full breakdown
 * reaches the model, and the screen shows one parenthetical line under the burn metric. The number
 * he recognised as his life is still not a number the app puts in front of him.
 *
 * It matters more than a caption, because runway is divided by the FULL burn. That is the right
 * default — a quarterly tax is real money, and a runway that forgets it lies in the dangerous
 * direction — but «скільки я протягну, якщо не станеться нічого разового» is a different question
 * with a different, always larger, answer. Both are shown, labelled, and the full-burn one stays
 * the headline: showing either alone is a claim rather than a fact.
 *
 * ⚠️ **The card is a LEDGER, not two figures side by side** (2026-09-10, owner: «блок не зовсім
 * зрозумілий»). The first version printed «28 885 постійні» beside «11 849 разові» with «71% від
 * burn 40 734» underneath, which asks the reader to do three things at once: add two numbers that
 * were never shown as addends, divide one of them by a third, and know what «burn» means. The
 * figures were right and the block still had to be decoded. Now the two parts are stacked as
 * addends with the total under a rule, so the arithmetic is READ rather than performed — and the
 * total, which is the number every other screen quotes, is the one on the bottom line.
 *
 * ⚠️ **Each runway carries the condition it is true under, in words.** «запас на все: 1.3м» /
 * «лише на постійне: 1.8м» were labels for a distinction the reader has to already hold in their
 * head — and «1.3м» in a card full of hryvnia reads as 1.3 million at a glance. The cushion the
 * two divide into is named as well: without it they are two ratios with an invisible numerator.
 */
import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { useGetSpendFloorQuery } from "../../store/api.ts";

export function SpendFloorCard() {
  const t = useT();
  const { data } = useGetSpendFloorQuery();
  // No levels yet (a fresh account) means there is no floor to state. Saying «0 ₴/міс» would be a
  // confident answer about an account the app has not yet seen a full month of.
  if (!data || data.burn <= 0) return null;

  const share = data.burn > 0 ? Math.round((data.floor / data.burn) * 100) : 0;

  return (
    <div className="card floor-card">
      <div className="ai-head">
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("floor.title")}
            <InfoTip>{t("floor.tip")}</InfoTip>
          </div>
          <div className="label">{t("floor.sub")}</div>
        </div>
      </div>

      {/* Two addends and a total, in that order and under a rule. The one-off row keeps the tip
          that says what «one-off» means here: RHYTHM, never «money you could skip» — a quarterly
          tax is lumpy and unavoidable, and calling it optional would be the app inventing
          permission. §EFF_IMPORTANCE is where avoidability lives, and it is a different axis. */}
      <div className="floor-ledger">
        <div className="fl-row">
          <span className="fl-lbl">{t("floor.fixedRow")}</span>
          <span className="fl-amt"><Money minor={data.floor} decimals={false} /></span>
        </div>
        <div className="fl-row">
          <span className="fl-lbl">
            <span className="fl-op" aria-hidden>+</span>
            {t("floor.lumpyRow")}
            <InfoTip>{t("floor.lumpyNote")}</InfoTip>
          </span>
          <span className="fl-amt muted-num"><Money minor={data.lumpy} decimals={false} /></span>
        </div>
        <div className="fl-row total">
          <span className="fl-lbl">{t("floor.totalRow")}</span>
          <span className="fl-amt"><Money minor={data.burn} decimals={false} /></span>
        </div>
        <div className="fl-note">{t("floor.fixedShare", { pct: share })}</div>
      </div>

      {/* Two runways, each with the condition that makes it true. The full-burn one keeps the
          emphasis: it is the number every other screen shows, and quietly promoting the friendlier
          one would be the app choosing the optimistic answer on the reader's behalf. */}
      {data.runway_months != null && (
        <div className="floor-runways">
          <div className="label">{t("floor.cushionIs")} <Money minor={data.cushion} decimals={false} /></div>
          <div className="floor-rw strong">
            <b>{t("floor.months", { n: data.runway_months })}</b>
            <span>{t("floor.runwayFullWhen")}</span>
          </div>
          {data.floor_months != null && data.floor_months !== data.runway_months && (
            <div className="floor-rw">
              <b>{t("floor.months", { n: data.floor_months })}</b>
              <span>{t("floor.runwayFloorWhen")}</span>
            </div>
          )}
        </div>
      )}

      {data.parts.length > 0 && (
        <div className="floor-parts">
          <div className="label">{t("floor.made")}</div>
          <div className="floor-chips">
            {data.parts.map((p) => (
              <span key={p.category_id} className="floor-chip">
                <span className="d" style={{ background: p.color ?? "var(--muted)" }} />
                {p.name}
                <b><Money minor={p.level} decimals={false} /></b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
