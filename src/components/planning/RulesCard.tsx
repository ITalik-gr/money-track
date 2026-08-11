import { useState } from "react";
import {
  useGetRulesQuery, useCreateRuleMutation, useDeleteRuleMutation, useApplyRuleMutation,
  useLazyPreviewRuleQuery, useGetCategoriesQuery,
} from "../../store/api.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { RulePreview } from "../../store/api.ts";

/**
 * Categorisation rules — the deterministic layer, editable at last.
 *
 * `rules` is step 4 of `categorize()` (learned alias → subscription → merchant consensus → RULES →
 * AI) and has existed since the first migration, but nothing outside a seed could ever write to
 * it. So every repeated correction went to the AI, or to a learned alias that matches one exact
 * merchant. A rule is the missing middle: a PATTERN, free to run and unable to hallucinate.
 *
 * ⚠️ The preview is not a nicety, it is the safety. A rule is a standing instruction about money
 * that has not arrived yet, and the only honest way to judge one is to run it against the past
 * before saving — which is why the form asks the server what it WOULD match, and why the seeded
 * MCC rules are collapsed out of the way (a hundred lines nobody wrote are not what you came for).
 */
export function RulesCard() {
  const t = useT();
  const { data: rules = [], isError, error, refetch } = useGetRulesQuery();
  const { data: cats = [] } = useGetCategoriesQuery();
  const [create, { isLoading: creating }] = useCreateRuleMutation();
  const [del] = useDeleteRuleMutation();
  const [apply, { isLoading: applying }] = useApplyRuleMutation();
  const [runPreview] = useLazyPreviewRuleQuery();

  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<"text" | "mcc">("text");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [showSeeded, setShowSeeded] = useState(false);

  // A seeded MCC rule is `mcc` at the default priority 10 — the same test the server sorts by.
  const isSeeded = (r: { match_type: string; priority: number }) => r.match_type === "mcc" && r.priority === 10;
  const mine = rules.filter((r) => !isSeeded(r));
  const seeded = rules.filter(isSeeded);

  const catOptions: SelectOption[] = cats
    .filter((c) => !c.is_income)
    .map((c) => ({ value: c.id, label: (c.parent_id ? "— " : "") + c.name, color: c.color, icon: c.icon }));

  async function check() {
    if (pattern.trim().length < 2) return;
    try {
      setPreview(await runPreview({ match_type: matchType, pattern: pattern.trim() }).unwrap());
    } catch (e) { toast.error(errText(e)); }
  }

  async function save() {
    if (categoryId == null) return;
    try {
      await create({ match_type: matchType, pattern: pattern.trim(), category_id: categoryId, priority: 50 }).unwrap();
      setPattern(""); setPreview(null);
      toast.success(t("rules.created"));
    } catch (e) { toast.error(errText(e)); }
  }

  async function applyRule(id: number) {
    try {
      const r = await apply(id).unwrap();
      // Says the NUMBER, including zero: "applied" with nothing changed would read as a failure,
      // and zero is a real and common answer (everything it matches is already categorised).
      toast.success(t("rules.applied", { n: r.updated }));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <section className="card set-full">
      <div className="set-head">
        <h2>{t("rules.title")}</h2>
        <span className="label">{t("rules.sub")}</span>
      </div>

      {isError && <ErrorNote error={error} what={t("rules.title")} onRetry={refetch} />}

      <div className="rule-form">
        <Select value={matchType} options={[
          { value: "text", label: t("rules.matchText") },
          { value: "mcc", label: t("rules.matchMcc") },
        ]} onChange={(v) => { setMatchType(v as "text" | "mcc"); setPreview(null); }} />
        <input
          className="rule-pattern"
          value={pattern}
          placeholder={matchType === "mcc" ? t("rules.mccPlaceholder") : t("rules.textPlaceholder")}
          onChange={(e) => { setPattern(e.target.value); setPreview(null); }}
          onKeyDown={(e) => e.key === "Enter" && check()}
        />
        <Select value={categoryId} options={catOptions} placeholder={t("rules.pickCategory")}
          onChange={(v) => setCategoryId(v == null ? null : Number(v))} />
        <button className="btn" disabled={pattern.trim().length < 2} onClick={check}>{t("rules.check")}</button>
        <button className="btn primary" disabled={!preview || categoryId == null || creating} onClick={save}>
          {t("rules.save")}
        </button>
      </div>

      {/* Saving is gated on having previewed: the button above stays disabled until the person has
          seen what the rule does. That is deliberate friction on a standing instruction. */}
      {preview && (
        <div className="rule-preview">
          <div className="rule-preview-head">
            {preview.n === 0
              ? t("rules.previewNone")
              : t("rules.previewFound", { n: preview.n, unc: preview.n_uncategorised })}
          </div>
          {preview.samples.length > 0 && (
            <ul className="rule-samples">
              {preview.samples.map((s) => <li key={s.id}>{s.merchant || t("rules.noName")}</li>)}
            </ul>
          )}
        </div>
      )}

      {mine.length > 0 && (
        <ul className="rule-list">
          {mine.map((r) => (
            <li key={r.id}>
              <span className="rule-kind">{r.match_type === "mcc" ? "MCC" : t("rules.matchTextShort")}</span>
              <span className="rule-pat" title={r.pattern}>{r.pattern}</span>
              <span className="rule-arrow">→</span>
              <span className="rule-cat">
                <span className="d" style={{ background: r.category_color ?? "var(--muted)" }} />
                {r.category_name ?? "—"}
              </span>
              <button className="btn sm ghost" disabled={applying} onClick={() => applyRule(r.id)}>
                {t("rules.applyPast")}
              </button>
              <button className="icon-mini" aria-label={t("common.delete")} onClick={() => del(r.id)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The ~100 seeded MCC rules are real and editable, but they are not why anyone opens this
          card — collapsed so the handful the person wrote stays readable. */}
      {seeded.length > 0 && (
        <button className="btn sm ghost rule-seeded-toggle" onClick={() => setShowSeeded(!showSeeded)}>
          {showSeeded ? t("rules.hideSeeded") : t("rules.showSeeded", { n: seeded.length })}
        </button>
      )}
      {showSeeded && (
        <ul className="rule-list rule-list-seeded">
          {seeded.map((r) => (
            <li key={r.id}>
              <span className="rule-kind">MCC</span>
              <span className="rule-pat">{r.pattern}</span>
              <span className="rule-arrow">→</span>
              <span className="rule-cat">{r.category_name ?? "—"}</span>
              <button className="icon-mini" aria-label={t("common.delete")} onClick={() => del(r.id)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
