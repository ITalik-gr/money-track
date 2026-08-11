// Response shapes of `/api/chats/*` — adviser conversations, stored server-side so a question
// asked on the phone is there on the laptop. See `./analytics.ts` for why this file exists.
//
// Note what is NOT here: the reply itself still arrives over `/api/advisor/chat/stream` as NDJSON
// (`src/lib/aiStream.ts`), because a stream has no response shape to declare. These endpoints own
// the transcript; that one owns the answer.

/** One turn. The same two roles the model API uses — there is no third kind of message. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A row of the conversation rail. Carries no messages: the rail only draws titles. */
export interface ChatSummary {
  id: string;
  title: string;
  updated_at: number;
  message_count: number;
}

/** One conversation, opened. */
export interface ChatDetail extends ChatSummary {
  messages: ChatTurn[];
}

/**
 * §TX-CHAT — every turn already exchanged about one transaction (`GET /transactions/:id/chat`).
 *
 * Same shape as an advisor conversation's turns, because it IS one — stored in `chats` with
 * `kind='tx'` (migration 0040) rather than in a table of its own.
 */
export type TxChatHistory = ChatTurn[];
