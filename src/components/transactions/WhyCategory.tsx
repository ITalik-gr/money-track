// "Why is it in this category?" — the sentence the AI block never said (2026-08-14).
//
// The block used to list what the app DECIDED (status · recognised as · category · tags) and never
// once what it decided it FROM. That is the difference between a panel you read and a panel you
// trust: a category with no reason behind it is either obviously right, in which case the line is
// free, or wrong — and then the reason is the only thing that tells you which knob to turn.
//
// Deliberately one sentence and no controls of its own. Every fix it could offer already exists a
// few centimetres away (the category select, the rules card, "recognise"), and a second path to
// the same edit is how two screens start disagreeing about what changed.
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetWhyQuery } from "../../store/api.ts";

export function WhyCategory({ txId }: { txId: string }) {
  const t = useT();
  const { data } = useGetWhyQuery(txId);
  if (!data) return null;

  // The deterministic chain, in the words of the thing that matched. `source` is reported by
  // `categorize()` itself, so this cannot describe a rule the engine no longer applies.
  const reason = data.source === "alias_desc" ? t("why.aliasDesc", { detail: data.detail ?? "" })
    : data.source === "alias_mcc" ? t("why.aliasMcc", { detail: data.detail ?? "" })
    : data.source === "subscription" ? t("why.subscription", { detail: data.detail ?? "" })
    : data.source === "rule_mcc" ? t("why.ruleMcc", { detail: data.detail ?? "" })
    : data.source === "rule_text" ? t("why.ruleText", { detail: data.detail ?? "" })
    // Nothing deterministic matches. Two very different situations share that: the model chose it,
    // or a person did. Saying which is the whole point of the line.
    : data.ai_enriched ? t("why.ai")
    : t("why.manual");

  return (
    <div className="why">
      <span className="why-ico"><Icon name="info" size={14} /></span>
      <span className="why-text">
        {reason}
        {/*
          The rules and the stored category disagree. Not an error and not auto-fixed: the stored
          one may be a correction somebody made on purpose, and silently "repairing" it would undo
          their work. Shown because a disagreement is exactly what a person would want to know and
          has no other way to see.
        */}
        {!data.agrees && (
          <span className="why-conflict">
            {" · "}
            {t("why.disagrees", { category: data.category_name ?? t("tx.noCategory") })}
          </span>
        )}
      </span>
    </div>
  );
}
