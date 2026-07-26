// Інлайн-повідомлення «цей блок не завантажився». Ставиться там, де сторінка інакше
// показала б порожнечу без пояснення (Статистика, Порадник, дрили). Текст помилки —
// завжди через `errText()`, ніколи `String(e)` (див. `lib/errors.ts`).
import { Icon } from "./Icon.tsx";
import { errText } from "../lib/errors.ts";
import { useT } from "../i18n/index.ts";

interface Props {
  /** Помилка з RTK Query (`error` з хука) або будь-що з catch. */
  error: unknown;
  /** Що саме не завантажилось — «Статистику», «поради». Іде в перше речення. */
  what?: string;
  /** Повторити запит (`refetch` з хука), якщо є. */
  onRetry?: () => void;
}

export function ErrorNote({ error, what, onRetry }: Props) {
  const t = useT();
  if (!error) return null;
  return (
    <div className="err-note" role="alert">
      <Icon name="alert" size={15} />
      <div className="err-note-body">
        <div className="err-note-title">{t("errnote.title", { what: what ?? t("errnote.defaultWhat") })}</div>
        <div className="err-note-msg">{errText(error)}</div>
      </div>
      {onRetry && <button className="btn sm" onClick={onRetry}>{t("errnote.retryBtn")}</button>}
    </div>
  );
}
