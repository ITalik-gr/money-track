/**
 * §A6 — клієнтська половина фонових AI-генерацій.
 *
 * Що це вирішує: порадник/звіт/бюджет-план ідуть 30-60 с. Раніше на цей час користувач був
 * прикутий до сторінки — піти означало «не побачити результат», хоча сервер його зберігав.
 * Тепер задача живе на сервері, а тут — рівно те, чого бракувало: індикатор, що щось іде,
 * і повідомлення, коли скінчилось.
 *
 * Поллінг СВІДОМО умовний: опитуємо, лише поки є активна задача, плюс один раз на монтуванні
 * (саме він і ловить «закрив вкладку на середині» — задача дорахувалась без нас). Постійний
 * інтервал заради події, яка стається раз на день, — це податок на кожного користувача.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDispatch } from "react-redux";
import { Icon } from "../ui/Icon.tsx";
import { api, useGetJobsQuery, useMarkJobSeenMutation, type AiJob, type AiJobKind } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { useT } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/index.ts";

const POLL_MS = 4000;
/** Старша за це завершена задача тост уже не показує — лише тихо позначається показаною. */
const STALE_TOAST_SEC = 6 * 3600;

/** Куди вести з чіпа і який тег оновити, коли задача завершилась. */
const JOB_META: Record<AiJobKind, { to: string; tag: "Advice" | "Report" | "Budget"; label: TranslationKey }> = {
  advisor: { to: "/advisor", tag: "Advice", label: "jobs.advisor" },
  report: { to: "/reports", tag: "Report", label: "jobs.report" },
  budget: { to: "/plan", tag: "Budget", label: "jobs.budget" },
};

const isActive = (j: AiJob) => j.status === "queued" || j.status === "running";

/**
 * The job's screen and tag — or `undefined` for a kind this build has no screen for.
 *
 * A mass run (`noop_batch` today, a re-sweep later) is a real row in the same list, and indexing
 * `JOB_META` blindly turned an unrecognised kind into `undefined.tag` — one unknown row would
 * throw inside the effect and take the toasts for every OTHER job down with it. An unknown kind
 * is a row this shell has nothing to say about, which is not the same as a broken shell.
 */
const metaFor = (kind: AiJob["kind"]) =>
  (JOB_META as Partial<Record<string, (typeof JOB_META)[AiJobKind]>>)[kind];

export function AiJobChip() {
  const t = useT();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [markSeen] = useMarkJobSeenMutation();

  // `pollingInterval: 0` вимикає таймер повністю; початковий запит при монтуванні відбувається
  // однаково. Тому цикл такий: змонтувались → спитали раз → якщо щось іде, увімкнули таймер →
  // скінчилось, вимкнули. Порожній акаунт не робить жодного зайвого запиту.
  const [poll, setPoll] = useState(0);
  const { data } = useGetJobsQuery(undefined, { pollingInterval: poll });
  const jobs = data?.items ?? [];
  const active = jobs.filter(isActive);
  useEffect(() => { setPoll(active.length ? POLL_MS : 0); }, [active.length]);

  // Пам'ятаємо, що вже показали: сервер тримає `seen_at`, але між подією і підтвердженням є
  // цикл рендеру, і без локального замка той самий тост встигав вискочити двічі.
  const announced = useRef<Set<number>>(new Set());

  useEffect(() => {
    for (const j of jobs) {
      if (isActive(j) || j.seen_at != null || announced.current.has(j.id)) continue;
      announced.current.add(j.id);
      // Давню задачу гасимо мовчки. Тост означає «щойно скінчилось»; вивалити стос
      // повідомлень про позавчорашні генерації при першому ж вході — це не новина, а шум,
      // і слід про них у будь-якому разі лишився у стрічці сповіщень.
      if (j.finished_at != null && Date.now() / 1000 - j.finished_at > STALE_TOAST_SEC) {
        markSeen(j.id);
        continue;
      }
      const meta = metaFor(j.kind);
      // Nothing to announce and nowhere to send them: mark it seen so it does not queue up
      // behind every later toast, and leave the notification feed to carry the trace.
      if (!meta) { markSeen(j.id); continue; }
      if (j.status === "done") {
        // Інвалідуємо ТІЛЬКИ тег свого виду: результат уже в базі, лишилось попросити той
        // екран перечитати його. Глобальний ресет перетягнув би всю сторінку без причини.
        dispatch(api.util.invalidateTags([meta.tag]));
        // З посиланням: тост, що каже «готово» і лишає шукати сторінку самому, — це half-fix
        // тієї самої проблеми, заради якої робилась черга.
        toast.success(t("jobs.done", { what: t(meta.label) }), meta.to);
      } else {
        // §Обробка помилок: показуємо справжню причину, а не «спробуй ще раз» — інакше
        // вичерпаний ліміт і збій моделі виглядають однаково.
        toast.error(j.error || t("jobs.failed", { what: t(meta.label) }), meta.to);
      }
      markSeen(j.id);
    }
  }, [jobs, dispatch, markSeen, t]);

  // The chip names ONE running job, so it can only show a kind it has a name for.
  const shown = active.filter((j) => metaFor(j.kind));
  if (!shown.length) return null;

  const first = shown[0];
  const firstMeta = metaFor(first.kind)!;
  return (
    <button
      type="button"
      className="ai-job-chip"
      onClick={() => navigate(firstMeta.to)}
      title={t("jobs.running", { what: t(firstMeta.label) })}
    >
      <Icon name="spark" size={14} />
      <span className="ajc-text">{t("jobs.running", { what: t(firstMeta.label) })}</span>
      {shown.length > 1 && <span className="ajc-more">+{shown.length - 1}</span>}
    </button>
  );
}
