import { useT } from "../../i18n/index.ts";

const MARKER = /\[img:([0-9a-f-]{36})\]/g;

export const stripImages = (content: string) => content.replace(MARKER, "").trim();

/** The pictures of a sent turn. The marker is the only thing stored in the transcript (§CHAT-IMG). */
export function MsgImages({ content }: { content: string }) {
  const tr = useT();
  const ids = [...content.matchAll(MARKER)].map((m) => m[1]);
  if (!ids.length) return null;
  return (
    <div className="chat-msg-imgs">
      {ids.map((id) => (
        <a key={id} href={`/api/chats/images/${id}`} target="_blank" rel="noopener noreferrer">
          <img src={`/api/chats/images/${id}`} alt={tr("chat.imageAlt")} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
