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
      const meta = JOB_META[j.kind];
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

  if (!active.length) return null;

  const first = active[0];
  return (
    <button
      type="button"
      className="ai-job-chip"
      onClick={() => navigate(JOB_META[first.kind].to)}
      title={t("jobs.running", { what: t(JOB_META[first.kind].label) })}
    >
      <Icon name="spark" size={14} />
      <span className="ajc-text">{t("jobs.running", { what: t(JOB_META[first.kind].label) })}</span>
      {active.length > 1 && <span className="ajc-more">+{active.length - 1}</span>}
    </button>
  );
}
