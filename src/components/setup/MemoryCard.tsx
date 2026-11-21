import { useState } from "react";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Select } from "../ui/Select.tsx";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { errText } from "../../lib/errors.ts";
import { toast } from "../../lib/toast.ts";
import {
  useAddMemoryMutation, useDeleteMemoryMutation, useGetMemoryQuery, usePatchMemoryMutation,
} from "../../store/api.ts";
import type { MemoryHorizon, MemoryItem } from "../../../shared/api/memory.ts";

const HORIZONS: MemoryHorizon[] = ["lasting", "months", "weeks", "days"];
const day = (u: number) => dateFmt({ day: "numeric", month: "short", year: "numeric" }).format(new Date(u * 1000));

function MemoryRow({ m }: { m: MemoryItem }) {
  const t = useT();
  const [patch] = usePatchMemoryMutation();
  const [del] = useDeleteMemoryMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const run = async (p: Promise<unknown>) => { try { await p; } catch (e) { toast.error(errText(e)); } };
  const archived = m.status === "archived";
  const outdated = !archived && !m.pinned && Date.now() / 1000 >= m.review_at;

  return (
    <li className="mem-row">
      <div className="mem-main">
        {draft == null ? <div className="mem-text">{m.text}</div> : (
          <textarea className="mem-edit" rows={2} autoFocus maxLength={240} value={draft} onChange={(e) => setDraft(e.target.value)} />
        )}
        <div className="mem-meta">
          <span>{t(`memory.horizon.${m.horizon}`)}</span>
          {m.valid_until && <span>{t("memory.until", { date: day(m.valid_until) })}</span>}
          {outdated && <span className="mem-old">{t("memory.outdated")}</span>}
          {archived && m.archive_reason && <span>{t(`memory.reason.${m.archive_reason}`)}</span>}
        </div>
      </div>
      <div className="mem-actions">
        {draft != null ? (
          <>
            <button className="btn sm primary" onClick={() => { void run(patch({ id: m.id, text: draft }).unwrap()); setDraft(null); }}>{t("common.save")}</button>
            <button className="btn sm ghost" onClick={() => setDraft(null)}>{t("common.cancel")}</button>
          </>
        ) : archived ? (
          <button className="btn sm ghost" onClick={() => void run(patch({ id: m.id, status: "active" }).unwrap())}>{t("memory.restore")}</button>
        ) : (
          <>
            <button className={`mem-icon${m.pinned ? " on" : ""}`} aria-pressed={!!m.pinned} aria-label={t("memory.pin")} title={t("memory.pin")}
              onClick={() => void run(patch({ id: m.id, pinned: !m.pinned }).unwrap())}><Icon name="check" size={14} /></button>
            <button className="btn sm ghost" onClick={() => setDraft(m.text)}>{t("memory.edit")}</button>
          </>
        )}
        <button className="mem-icon" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => void run(del(m.id).unwrap())}>×</button>
      </div>
    </li>
  );
}

// §MEMORY: everything the assistant carries between conversations, open to the person it is about.
export function MemoryCard({ isDemo }: { isDemo: boolean }) {
  const t = useT();
  const { data, error, refetch } = useGetMemoryQuery();
  const [add, { isLoading }] = useAddMemoryMutation();
  const [text, setText] = useState("");
  const [horizon, setHorizon] = useState<MemoryHorizon>("lasting");
  const [showArchive, setShowArchive] = useState(false);
  const active = data?.active ?? [];
  const archived = data?.archived ?? [];

  async function submit() {
    if (!text.trim()) return;
    try { await add({ text: text.trim(), horizon }).unwrap(); setText(""); } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card ai-block set-full">
      <div className="ai-block-head">
        <span className="ai-block-title"><Icon name="spark" size={16} />{t("memory.title")}<InfoTip>{t("memory.tip")}</InfoTip></span>
      </div>
      <p className="ai-block-hint">{t("memory.hint")}</p>
      {error ? <ErrorNote error={error} onRetry={refetch} /> : active.length === 0
        ? <p className="mem-empty">{t("memory.empty")}</p>
        : <ul className="ilist mem-list">{active.map((m) => <MemoryRow key={m.id} m={m} />)}</ul>}
      {!isDemo && (
        <div className="mem-add">
          <input value={text} maxLength={240} placeholder={t("memory.addPlaceholder")} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          <Select value={horizon} options={HORIZONS.map((h) => ({ value: h, label: t(`memory.horizon.${h}`) }))} onChange={(v) => setHorizon(v as MemoryHorizon)} />
          <button className="btn primary" disabled={isLoading || !text.trim()} onClick={() => void submit()}>{t("memory.add")}</button>
        </div>
      )}
      {archived.length > 0 && (
        <>
          <button className="btn sm ghost mem-toggle" onClick={() => setShowArchive((v) => !v)}>
            {showArchive ? t("memory.hideArchive") : t("memory.showArchive", { n: archived.length })}
          </button>
          {showArchive && <ul className="ilist mem-list">{archived.map((m) => <MemoryRow key={m.id} m={m} />)}</ul>}
        </>
      )}
    </div>
  );
}
