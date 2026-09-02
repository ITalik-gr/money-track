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

      <div className="floor-nums">
        <div className="floor-main">
          <div className="label">{t("floor.floor")}</div>
          <div className="num-hero"><Money minor={data.floor} decimals={false} /></div>
          <div className="floor-of">
            {t("floor.ofBurn", { pct: share })} <Money minor={data.burn} decimals={false} />
          </div>
        </div>
        <div className="floor-main">
          <div className="label">{t("floor.lumpy")}</div>
          <div className="num-hero muted-num"><Money minor={data.lumpy} decimals={false} /></div>
          {/* Lumpy is about RHYTHM, never about whether the money was avoidable — a quarterly tax
              is lumpy and unavoidable. Calling it "optional" would be the app inventing permission;
              §EFF_IMPORTANCE is where avoidability lives, and it is a different axis. */}
          <div className="floor-of">{t("floor.lumpyNote")}</div>
        </div>
      </div>

      {/* Two runways side by side. The full-burn one keeps the emphasis: it is the number every
          other screen shows, and quietly promoting the friendlier one would be the app choosing
          the optimistic answer on the reader's behalf. */}
      {data.runway_months != null && (
        <div className="floor-runways">
          <span className="floor-rw strong">
            {t("floor.runwayFull")} <b>{data.runway_months}{t("adv.monthsAbbr")}</b>
          </span>
          {data.floor_months != null && data.floor_months !== data.runway_months && (
            <span className="floor-rw">
              {t("floor.runwayFloor")} <b>{data.floor_months}{t("adv.monthsAbbr")}</b>
            </span>
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
