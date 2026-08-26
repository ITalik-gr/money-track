/**
 * The one AI branch of the notification feed: the model looks at the CANONICAL snapshot
 * (`collectFinanceSnapshot` — the same source the Advisor and the Chat read) and names, in a
 * human sentence, something that is already computed. It does NOT compute; that is both the point
 * and the safeguard.
 *
 * Lifted out of `notify.ts` on 2026-08-27 under lint C3, alongside `drafts-budget`/`drafts-import`.
 * The move was forced by the three guards added that day, and they are the reason this file is
 * worth reading: the feed had shipped «Rent due in 11 days, cushion covers only 0.8 months total»
 * for a rent the user pays on the 20th. Nothing in the payload said 11, or 20, or anything about
 * rent's schedule at all — the rent is not a `planned_payment`, so it is in no `upcoming_charges`
 * row, and the model read the user's own prose in `situation` as a timetable.
 *
 * Every figure in that sentence was under 100, i.e. below the floor of `numbersAreGrounded`. A
 * prompt rule is not a check (§Правила), so each defect got one:
 *   • the CALENDAR   → `timeClaimsAreGrounded` against the anchors the payload actually states;
 *   • the LANGUAGE   → `scriptMatchesLocale` (the feed carried English headlines over Ukrainian
 *                      bodies — one card, two languages);
 *   • the REPETITION → `repeatsRecentTopic` (the same thought two days apart in other words) and
 *                      `already_announced_today` (the same thought as a deterministic event that
 *                      fired in this very run).
 */
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { resolveLocale } from "../platform/i18n.ts";
import {
  collectNumbers, numbersAreGrounded, timeClaimsAreGrounded, scriptMatchesLocale,
} from "../ai/grounding.ts";
import { localYmd } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

const isoDay = (unix: number) => localYmd(unix);

/**
 * AI-ініціатива: модель дивиться на ГОТОВИЙ канонічний знімок (`collectFinanceSnapshot` —
 * те саме джерело, що Порадник і Чат) і формулює 1-2 спостереження людською мовою.
 *
 * 🔒 Модель НЕ рахує — вона лише називає те, що вже пораховано канонічно. Це головна
 * різниця з «тупими алертами» й водночас запобіжник: вигадану цифру тут ніде взяти,
 * бо в промті прямо заборонено рахувати нові числа.
 */

/** Скільки днів одна тема AI-спостереження вважається «вже сказаною». */
const AI_TOPIC_COOLDOWN_DAYS = 14;
/** Ключ у `app_state`: доба, в яку AI-прохід уже відбувся. */
const AI_LAST_DAY_KEY = "notify_ai_day";

/**
 * Стабільний ключ ТЕМИ спостереження з його заголовка.
 *
 * Числа й пунктуацію викидаємо навмисно: та сама думка щодня приходить із трохи іншою сумою
 * («запасу на 7,5 місяця» → «запасу на 7,3 місяця»), і саме через це вона щоранку виглядала
 * як нова подія й летіла в Telegram. Лишається сама фраза — вона і є темою.
 */
function aiTopicKey(title: string): string {
  const norm = title.toLowerCase().replace(/[\d]+/g, " ").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  // FNV-1a: короткий детермінований ключ, який влазить у `entity_id` і однаковий між рестартами.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Is this the same THOUGHT as one already published, wearing other words?
 *
 * `aiTopicKey` hashes the title with the numbers stripped, so it catches «запасу на 7,5 місяця» →
 * «запасу на 7,3 місяця» and nothing else. On real data the feed carried «Cushion lasts 24 days at
 * current burn» on the 24th and «Rent due in 11 days, cushion covers only 0.8 months total» on the
 * 26th — one thought, two headlines, two different hashes, and a reader who sees the app repeating
 * itself two days apart stops reading it.
 *
 * ⚠️ ONE shared content word is enough. Those two headlines share exactly one — «cushion» — and a
 * threshold of two would have let the pair through, which is how a guard ends up passing the case
 * it was written for. In a headline of six words a noun this long IS the subject.
 * ⚠️ Which makes the STOPLIST the load-bearing part: without it «витрати» would make every
 * observation a repeat of every other. It holds only words that say nothing about WHICH topic the
 * headline is about; a word naming a category, an account or a merchant never belongs here.
 * ⚠️ Over-rejecting costs silence, and the prompt already says an empty array is a correct answer.
 * Under-rejecting costs the feed's credibility, which is the only reason anyone opens it.
 */
const TOPIC_STOPWORDS = new Set([
  "витрати", "витрат", "витрачаєш", "спенд", "місяць", "місяця", "місяців", "гривень",
  "більше", "менше", "цього", "минулого", "тепер", "більша", "більший", "менша",
  "бюджет", "бюджету", "бюджеті", "понад", "знову", "зросла", "зросли", "зросло",
  "дорожча", "дорожче", "стало", "стали", "лишилось", "лишається",
  "spending", "monthly", "month", "months", "still", "again", "every", "there", "which",
  "current", "total", "money", "budget", "above", "below", "grew", "rose",
]);
function contentWords(title: string): Set<string> {
  return new Set<string>(
    title.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/)
      .filter((w) => w.length >= 5 && !TOPIC_STOPWORDS.has(w)),
  );
}
export function repeatsRecentTopic(title: string, recent: string[]): boolean {
  const words = contentWords(title);
  for (const r of recent) {
    for (const w of contentWords(r)) if (words.has(w)) return true;
  }
  return false;
}

export async function draftAiObservations(env: Env, now: number, already: string[] = []): Promise<Draft[]> {
  if (!env.ANTHROPIC_API_KEY) return [];
  const day = isoDay(now);
  // 💸 Запобіжник вартості: `dedup_key` захищає лише від дублів У БАЗІ, а виклик моделі
  // стався б однаково. Без цієї перевірки кнопка «Перевірити зараз» палила б токени на
  // кожен клік. За добу — рівно один прохід.
  //
  // Маркер лежить в `app_state`, а не виводиться з наявних рядків `ai:<день>:%`: прохід, з якого
  // не вийшло жодного рядка (усі спостереження відсіяв дедуп тем або `numbersAreGrounded`), теж
  // коштував грошей, а за старою перевіркою виглядав як «сьогодні ще не рахували» — і наступний
  // виклик у той самий день платив удруге.
  if (await getState(env.DB, AI_LAST_DAY_KEY) === day) return [];

  const { collectFinanceSnapshot } = await import("../ai/advisor.ts");
  const { generateNotifyObservations } = await import("../ai/generate.ts");

  // Теми останніх двох тижнів — і як підказка моделі («не переказуй це знову»), і як фільтр
  // нижче. Промт сам по собі не гарантія (§Правила: інструкція ≠ перевірка), тож обидва шари.
  const recent = await env.DB.prepare(
    `SELECT title, entity_id FROM notifications
     WHERE kind = 'ai' AND created_at >= ? ORDER BY created_at DESC LIMIT 30`,
  ).bind(now - AI_TOPIC_COOLDOWN_DAYS * 86400).all<{ title: string; entity_id: string | null }>();
  const recentRows = recent.results ?? [];
  const seenTopics = new Set(recentRows.map((r) => r.entity_id ?? aiTopicKey(r.title)));
  const recentTitles = recentRows.map((r) => r.title);

  // ЄДИНЕ джерело контексту — той самий знімок, що бачать Порадник і Чат (§Інваріанти).
  // Не будувати збіднений контекст вручну: саме це колись дало «домислену подушку $780».
  const snap = await collectFinanceSnapshot(env);
  const payload = {
    ...(snap.context as object),
    recent_observation_titles: recentRows.map((r) => r.title),
    // What the DETERMINISTIC branches are saying in this very run. The prompt has always told the
    // model not to duplicate a budget breach or a deadline — and it had no way to know which ones
    // fired: «Utilities bill jumped 53% above budget» landed beside the budget event that says
    // exactly that, with the same number. The branches run before this one, so the answer is
    // simply available (`already` is passed in by `generateNotifications`).
    already_announced_today: already,
  };
  const { result } = await generateNotifyObservations(env, payload);
  await setState(env.DB, AI_LAST_DAY_KEY, day);

  // Числа з payload — еталон для перевірки нижче.
  const known = new Set<number>();
  collectNumbers(snap.context, known);
  // §TIME-CTX: the calendar the payload actually states. Anything outside it is a date the model
  // made up — see `timeClaimsAreGrounded`.
  const anchorDays = new Set(snap.timeAnchors.days);
  const anchorMonths = new Set(snap.timeAnchors.months);
  const loc = await resolveLocale(env);

  const out: Draft[] = [];
  for (const o of result.observations ?? []) {
    if (out.length >= 2) break;                    // ліміт на добу — стрічка не має тонути в балачках моделі
    const title = o.title?.trim();
    if (!title) continue;
    const text = `${title} ${o.body ?? ""}`;
    // 🔒 Відкидаємо спостереження з сумою, якої в знімку нема (див. `numbersAreGrounded`).
    if (!numbersAreGrounded(text, known)) {
      console.warn("notify/ai: відкинуто спостереження з непідтвердженим числом:", title);
      continue;
    }
    // 🔒 …and the same for the CALENDAR, which the money guard cannot see: its floor of 100 let
    // «Rent due in 11 days» through for a rent due in 25, because every figure in that sentence
    // was a small one.
    if (!timeClaimsAreGrounded(text, anchorDays, anchorMonths)) {
      console.warn("notify/ai: відкинуто спостереження з вигаданою датою:", title);
      continue;
    }
    // 🔒 One card, one language. The prompts are English (§LANG-ARCH) and only a final directive
    // asks for the reader's language, so the feed shipped English headlines over Ukrainian bodies.
    if (!scriptMatchesLocale(text, loc)) {
      console.warn("notify/ai: відкинуто спостереження не тією мовою:", title);
      continue;
    }
    const topic = aiTopicKey(title);
    if (seenTopics.has(topic) || repeatsRecentTopic(title, recentTitles)) {
      console.warn("notify/ai: тема вже була за останні 14 днів, пропускаю:", title);
      continue;
    }
    seenTopics.add(topic);                         // і в межах однієї відповіді теж
    recentTitles.push(title);
    out.push({
      kind: "ai",
      title: title.slice(0, 120),
      body: (o.body ?? "").trim().slice(0, 400) || null,
      severity: o.severity === "warn" ? "warn" : "info",
      // Тема живе в `entity_id`: без неї дедуп довелося б рахувати із заголовка при кожному
      // читанні, а заголовок ще й обрізається до 120 символів.
      entity_type: "ai_topic", entity_id: topic,
      dedup_key: `ai:${day}:${out.length}`,
    });
  }
  return out;
}
