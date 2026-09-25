/**
 * The AI block of the operation page: what the model concluded about this row and why, the note
 * that steers it, the record of what it changed, and the conversation about the row.
 *
 * Redesigned 2026-09-25 (UI_PASS S7). The folded «Усі розпізнані дані» table is gone: of its eight
 * rows, the category, the MCC and the tags repeated the facts card and the editor on the same
 * screen, «recognised as» repeated the page's own title, and the one row worth reading — what the
 * model UNDERSTANDS this to be — was hidden behind the fold. That line is now shown as a quote, the
 * status and the plan link are two chips, and nothing is said twice.
 *
 * The business flag moved OUT of this block into the editor: it is a person's decision about the
 * row, and placed here it read as something the AI had decided.
 *
 * The note has its own Save. It used to be saved by the editor's button in the other column, so
 * typing a note here and looking for the button beside it found nothing.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import {
  useChatTxMutation, useEditTransactionMutation, useEnrichTransactionMutation, useGetTxChatQuery,
} from "../../store/api.ts";
import type { TxDetail } from "../../store/api.ts";
import { renderMarkdown } from "../../lib/markdown.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { AiChangeLog } from "./AiChangeLog.tsx";
import { WhyCategory } from "./WhyCategory.tsx";

export function TxAiBlock({ tx }: { tx: TxDetail }) {
  const t = useT();
  const [enrich, { isLoading: enriching }] = useEnrichTransactionMutation();
  const [editTx, { isLoading: savingNote }] = useEditTransactionMutation();
  const [note, setNote] = useState(tx.user_note ?? "");
  useEffect(() => { setNote(tx.user_note ?? ""); }, [tx.user_note]);
  const noteDirty = note.trim() !== (tx.user_note ?? "").trim();

  // §R6: a changed note is re-read by the model at once (enrich ranks `user_note` first), so «this
  // was for the course» takes effect without a second click.
  async function saveNote() {
    try {
      await editTx({ id: tx.id, body: { user_note: note.trim() || null } }).unwrap();
      if (!note.trim()) { toast.success(t("tx.saved")); return; }
      toast.success(t("tx.savedEnriching"));
      try { await enrich(tx.id).unwrap(); toast.success(t("tx.aiNoted")); }
      catch { toast.error(t("tx.aiNoteFailed")); }
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card ai-block">
      <div className="ai-block-head">
        <span className="ai-block-title"><Icon name="spark" size={16} />{t("tx.aiBlockTitle")}</span>
        <button className="btn ai-recognize" disabled={enriching}
          onClick={async () => {
            try { await enrich(tx.id).unwrap(); toast.success(t("tx.aiEnrichedDone")); }
            catch (e) { toast.error(errText(e)); }
          }}>{enriching ? t("tx.analyzing") : tx.ai_enriched ? t("tx.recognizeAgain") : t("tx.recognize")}</button>
      </div>

      <WhyCategory txId={tx.id} />

      {tx.ai_note && (
        <figure className="ai-understands">
          <figcaption>{t("tx.aiFact.aiUnderstands")}</figcaption>
          <blockquote>{tx.ai_note}</blockquote>
        </figure>
      )}

      <div className="ai-chips">
        <span className={`ai-chip ${tx.ai_enriched ? "on" : ""}`}>
          <Icon name={tx.ai_enriched ? "check" : "info"} size={13} />
          {tx.ai_enriched ? t("tx.aiStatusEnriched") : t("tx.aiStatusNotEnriched")}
        </span>
        {tx.planned_title && (
          tx.planned_id
            ? <Link className="ai-chip link" to={`/subs/${tx.planned_id}`}><Icon name="repeat" size={13} />{tx.planned_title}</Link>
            : <span className="ai-chip"><Icon name="repeat" size={13} />{tx.planned_title}</span>
        )}
      </div>

      <div className="ai-note">
        <label className="label" htmlFor="tx-ai-note">{t("tx.label.noteForAi")}</label>
        <textarea id="tx-ai-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("tx.placeholder.noteForAi")} />
        <div className="ai-note-foot">
          <span className="ai-block-sub">{t("tx.noteHint")}</span>
          <button className={`btn sm ${noteDirty ? "primary" : ""}`} disabled={!noteDirty || savingNote || enriching} onClick={saveNote}>
            {t("tx.saveNote")}
          </button>
        </div>
      </div>

      {/* §AI-AUDIT sits directly ABOVE the chat: the chat is where most of these changes come from,
          so the record of them belongs next to their source. */}
      <AiChangeLog txId={tx.id} />
      <TxAiChat txId={tx.id} txName={tx.merchant ?? tx.comment ?? t("tx.chatFallback")} />
    </div>
  );
}

type ChatMsg = { role: "user" | "assistant"; content: string };

/**
 * The conversation about ONE operation: the person clarifies ("this was for the course"), the
 * model answers and may update the category or the transfer flag (applied server-side).
 *
 * §TX-CHAT (2026-08-12): the exchange is STORED. It used to live in this component's `useState`,
 * so it existed until the user navigated away and then was gone — strictly worse than the state
 * §CHAT-SYNC was created to end. Somebody would explain why a payment is not what it looks like,
 * the model would use it, and an hour later there was no evidence the explanation had ever
 * happened. Now it loads with the page, so the operation carries its own history: what was said
 * about it, and when.
 */
function TxAiChat({ txId, txName }: { txId: string; txName: string }) {
  const t = useT();
  const [chatTx, { isLoading: chatting }] = useChatTxMutation();
  const { data: history } = useGetTxChatQuery(txId);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);

  // Server history seeds the thread once. Not `messages = history` on every render: the optimistic
  // user turn is added locally the moment it is sent, and re-reading the server between the send
  // and its answer would make the question flicker out and back.
  useEffect(() => {
    if (history && messages.length === 0) setMessages(history as ChatMsg[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || chatting || sending.current) return;
    sending.current = true;
    const next: ChatMsg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    try {
      const r = await chatTx({ id: txId, messages: next }).unwrap();
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
      if (r.applied?.category_name) toast.success(t("tx.aiUpdatedCategory", { name: r.applied.category_name }));
      if (r.applied?.is_transfer) toast.success(t("tx.aiMarkedTransfer"));
      if (r.applied?.understanding) toast.success(t("tx.aiUpdatedUnderstanding"));
    } catch (e) {
      // Показуємо РЕАЛЬНУ причину (ліміт, ключ, збій моделі), а не глухе «спробуй ще раз» —
      // інакше діагностувати AI-помилку неможливо (див. `lib/errors.ts`).
      setMessages((m) => [...m, { role: "assistant", content: t("tx.chatReplyFailed", { error: errText(e) }) }]);
    } finally { sending.current = false; }
  }

  return (
    <div className="tx-chat">
      {/* An `Icon`, not an emoji: every other section head in the app uses one, and the emoji
          rendered glued to the text because the head is a flex row that collapses the space. */}
      <div className="tx-chat-head"><Icon name="advisor" size={15} />{t("tx.chatHead")}</div>
      {messages.length === 0 && !chatting && (
        <div className="tx-chat-hint">
          {t("tx.chatHint")}
        </div>
      )}
      {messages.length > 0 && (
        <div className="tx-chat-log">
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.role === "assistant" ? renderMarkdown(m.content) : m.content}
            </div>
          ))}
          {chatting && <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>}
        </div>
      )}
      <div className="tx-chat-input">
        <input placeholder={t("tx.chatInputPlaceholder", { name: txName })} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <button className="btn primary" onClick={() => send()} disabled={chatting || !input.trim()} aria-label={t("tx.chatSend")}>➤</button>
      </div>
    </div>
  );
}
