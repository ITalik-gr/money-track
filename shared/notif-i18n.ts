// Localized rendering of notification-feed text (P3.3).
//
// Why a shared module and not the client `t()` dictionaries: notification titles are
// GENERATED SERVER-SIDE and stored in the DB. If we stored the finished Ukrainian phrase,
// switching the UI language would leave the whole feed frozen in Ukrainian forever
// (PLATFORM.md §12.3). So the generators store a template `key` + raw `params` (JSON), and
// the phrase is composed at READ time in the current locale. Both sides render it:
//   • client  — the feed list re-renders live on a language switch;
//   • worker   — the TG push and the stored fallback `title`/`body` (for legacy rows and the
//                free-text `ai` kind) are composed in the owner's locale at send time.
// Keeping the templates in ONE pure module is the single-source rule (PLATFORM.md §14.2):
// there is no second place where a number could be formatted or a phrase worded differently.
//
// Money/date formatting is locale-aware and happens HERE, at render time — params carry raw
// minor-amount integers and unix timestamps, never pre-formatted strings, so "₴1,234" vs
// "1 234 ₴" follows the viewer's locale rather than whatever the cron happened to pick.

export type NotifLocale = "uk" | "en";

// Params are a flat JSON bag (serialized into `notifications.notif_params`). Entity names
// (merchant, category, plan/budget/goal name) pass through verbatim — they are user/bank data
// in whatever language the user named them, not dictionary keys.
export type NotifParams = Record<string, string | number | boolean | null>;

export type NotifTemplateKey =
  | "report" | "deadline_plan" | "deadline_credit" | "anomaly" | "win" | "budget"
  | "price_up" | "liquidity" | "big_tx" | "duplicate" | "health_drop"
  | "goal_risk" | "dead_sub" | "todo" | "job_done" | "cron_failed" | "budget_forecast"
  | "stale_import";

export interface RenderedNotif { title: string; body: string | null }

// ---- locale-aware primitives -------------------------------------------------

// Money is always UAH here (canonical roll-up to ₴ happened upstream). The symbol side
// follows the locale convention: trailing "₴" in Ukrainian, leading "₴" in English.
function money(locale: NotifLocale, minor: number): string {
  const n = Math.round((minor ?? 0) / 100);
  return locale === "uk"
    ? `${n.toLocaleString("uk-UA")} ₴`
    : `₴${n.toLocaleString("en-US")}`;
}

function dayMonth(locale: NotifLocale, unix: number): string {
  return new Date((unix ?? 0) * 1000).toLocaleDateString(
    locale === "uk" ? "uk-UA" : "en-US",
    { day: "numeric", month: "long" },
  );
}

// "today / tomorrow / in N days" — kept identical in meaning to the old inline expressions.
function when(locale: NotifLocale, days: number): string {
  if (locale === "uk") return days <= 0 ? "сьогодні" : days === 1 ? "завтра" : `через ${days} дн`;
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

// Small typed getters so a bad param shape degrades to a sane default instead of "undefined".
const s = (p: NotifParams, k: string, d = ""): string => (typeof p[k] === "string" ? p[k] as string : d);
const num = (p: NotifParams, k: string): number => (typeof p[k] === "number" ? p[k] as number : Number(p[k]) || 0);
const bool = (p: NotifParams, k: string): boolean => p[k] === true;

// ---- the templates -----------------------------------------------------------

export function renderNotif(locale: NotifLocale, key: NotifTemplateKey, p: NotifParams): RenderedNotif {
  const uk = locale === "uk";
  const m = (minor: number) => money(locale, minor);
  const dm = (unix: number) => dayMonth(locale, unix);

  switch (key) {
    case "report": {
      const period = s(p, "periodType") === "month"
        ? (uk ? "Місячний" : "Monthly")
        : (uk ? "Тижневий" : "Weekly");
      const kind = uk ? "репорт" : "report";
      return {
        title: `${period} ${kind} · ${dm(num(p, "from"))} – ${dm(num(p, "to"))}`,
        // Body is the AI summary — free text, kept verbatim in whatever locale it was written.
        body: s(p, "summary") || null,
      };
    }

    // §A6: a long generation the user started finished while they were elsewhere in the app —
    // or with the tab closed. `report` has its own richer template above; this covers the two
    // kinds whose result has no period to name.
    case "job_done": {
      // Заголовок складаємо цілком, а не з «що» + «готово»: українською рід підмета міняє
      // закінчення («План готовий», але «Порада готова»), і склейка дала б аграматичний рядок.
      const budget = s(p, "job") === "budget";
      // `auto` = задачу поставив розклад, а не людина (місячне оновлення поради 1-го числа).
      // Той самий текст на обидва випадки перетворював заплановану роботу на подію без причини:
      // «Порада готова» о 12:00 читалось як «щось само згенерувалось» (скарга 2026-08-01).
      if (bool(p, "auto")) {
        return {
          title: budget
            ? (uk ? "План бюджетів оновлено" : "Budget plan refreshed")
            : (uk ? "Пораду оновлено на новий місяць" : "Advice refreshed for the new month"),
          body: uk
            ? "Плановий щомісячний перерахунок — ти цього не запускав."
            : "Scheduled monthly refresh — you did not start this one.",
        };
      }
      return {
        title: budget
          ? (uk ? "План бюджетів готовий" : "Budget plan is ready")
          : (uk ? "Порада готова" : "Advice is ready"),
        body: uk
          ? "Згенерували у фоні — можна дивитись."
          : "Generated in the background — ready to view.",
      };
    }

    case "deadline_plan": {
      const w = when(locale, num(p, "days"));
      return {
        title: uk ? `${s(p, "title")} — списання ${w}` : `${s(p, "title")} — charge ${w}`,
        body: `${m(num(p, "amount"))} · ${dm(num(p, "at"))}`,
      };
    }

    case "deadline_credit": {
      const name = s(p, "title") || (uk ? "Кредитка" : "Credit card");
      const w = when(locale, num(p, "days"));
      const label = bool(p, "isMin")
        ? (uk ? "мін. платіж" : "min. payment")
        : (uk ? "борг" : "debt");
      const by = uk ? "до" : "by";
      return {
        title: uk ? `${name} — платіж ${w}` : `${name} — payment ${w}`,
        body: `${label} ${m(num(p, "amount"))} · ${by} ${dm(num(p, "at"))}`,
      };
    }

    case "anomaly": {
      const name = s(p, "name");
      const already = bool(p, "already");
      const pct = num(p, "pct");
      if (already) {
        return {
          title: uk ? `${name} — вже вище звичного` : `${name} — already above usual`,
          body: uk
            ? `Уже ${m(num(p, "spent"))} проти звичних ${m(num(p, "usual"))} за місяць (${pct}%).`
            : `Already ${m(num(p, "spent"))} vs usual ${m(num(p, "usual"))} this month (${pct}%).`,
        };
      }
      return {
        title: uk ? `${name} — темп вище звичного` : `${name} — pace above usual`,
        body: uk
          ? `Уже ${m(num(p, "spent"))}, за темпом місяць вийде ≈ ${m(num(p, "projected"))} проти звичних ${m(num(p, "usual"))} (${pct}%).`
          : `Already ${m(num(p, "spent"))}; at this pace the month will reach ≈ ${m(num(p, "projected"))} vs usual ${m(num(p, "usual"))} (${pct}%).`,
      };
    }

    case "win": {
      const name = s(p, "name");
      const pct = num(p, "pct");
      return {
        title: uk ? `${name} — нижче звичного на ${pct}%` : `${name} — ${pct}% below usual`,
        body: uk
          ? `За темпом вийде ≈ ${m(num(p, "projected"))} проти звичних ${m(num(p, "usual"))}. Різниця ${m(num(p, "saved"))}.`
          : `At this pace ≈ ${m(num(p, "projected"))} vs usual ${m(num(p, "usual"))}. Difference ${m(num(p, "saved"))}.`,
      };
    }

    case "budget": {
      const name = s(p, "name");
      const over = bool(p, "over");
      const title = uk
        ? (over ? `Бюджет «${name}» вичерпано` : `Бюджет «${name}» майже вичерпано`)
        : (over ? `Budget "${name}" exhausted` : `Budget "${name}" almost exhausted`);
      return {
        title,
        body: uk
          ? `${m(num(p, "spent"))} з ${m(num(p, "amount"))} (${num(p, "pct")}%).`
          : `${m(num(p, "spent"))} of ${m(num(p, "amount"))} (${num(p, "pct")}%).`,
      };
    }

    case "price_up": {
      const title = s(p, "title");
      const pct = num(p, "pct");
      const yr = uk ? "рік" : "yr";
      return {
        title: uk ? `${title} подорожчав на ${pct}%` : `${title} got ${pct}% more expensive`,
        body: uk
          ? `Було ${m(num(p, "old"))}, стало ${m(num(p, "new"))} (+${m(num(p, "delta"))} · ${m(num(p, "year"))}/${yr}).`
          : `Was ${m(num(p, "old"))}, now ${m(num(p, "new"))} (+${m(num(p, "delta"))} · ${m(num(p, "year"))}/${yr}).`,
      };
    }

    case "liquidity": {
      return {
        title: uk ? "Прогнозований провал ліквідності" : "Projected liquidity shortfall",
        body: uk
          ? `На ${dm(num(p, "at"))} планових списань більше, ніж подушки: не вистачить ≈ ${m(num(p, "short"))}. Подушка зараз ${m(num(p, "cushion"))}.`
          : `By ${dm(num(p, "at"))} planned charges exceed your cushion: short by ≈ ${m(num(p, "short"))}. Cushion now ${m(num(p, "cushion"))}.`,
      };
    }

    case "big_tx": {
      const merchant = s(p, "merchant") || (uk ? "без назви" : "no name");
      const category = s(p, "category") || (uk ? "без категорії" : "no category");
      const mult = s(p, "mult");
      return {
        title: uk ? `Велика витрата: ${merchant}` : `Large expense: ${merchant}`,
        body: uk
          ? `${m(num(p, "amount"))} — це ×${mult} до звичного чека в категорії «${category}» (${m(num(p, "avg"))}).`
          : `${m(num(p, "amount"))} — that's ×${mult} the usual check in category "${category}" (${m(num(p, "avg"))}).`,
      };
    }

    case "duplicate": {
      const merchant = s(p, "merchant");
      return {
        title: uk ? `Схоже на подвійне списання: ${merchant}` : `Looks like a double charge: ${merchant}`,
        body: uk
          ? `Дві операції по ${m(num(p, "amount"))} протягом доби. Перевір, чи це не помилка терміналу.`
          : `Two transactions of ${m(num(p, "amount"))} within a day. Check it's not a terminal error.`,
      };
    }

    case "health_drop": {
      const drop = num(p, "drop");
      return {
        title: uk ? `Індекс фінздоровʼя впав на ${drop} п.` : `Financial health index dropped ${drop} pts`,
        body: uk
          ? `Було ${num(p, "pastScore")} (${s(p, "pastDay")}), стало ${num(p, "latestScore")}. Відкрий «Стан фінансів» — там видно, яка складова просіла.`
          : `Was ${num(p, "pastScore")} (${s(p, "pastDay")}), now ${num(p, "latestScore")}. Open "Financial health" to see which part slipped.`,
      };
    }

    case "goal_risk": {
      const name = s(p, "name");
      const passed = bool(p, "passed");
      if (passed) {
        return {
          title: uk ? `Дедлайн цілі «${name}» минув` : `Goal "${name}" deadline passed`,
          body: uk
            ? `Зібрано ${m(num(p, "current"))} з ${m(num(p, "target"))} (${num(p, "progressPct")}%).`
            : `Saved ${m(num(p, "current"))} of ${m(num(p, "target"))} (${num(p, "progressPct")}%).`,
        };
      }
      return {
        title: uk ? `Ціль «${name}» не встигає` : `Goal "${name}" is falling behind`,
        body: uk
          ? `Зібрано ${num(p, "progressPct")}%, а часу минуло ${num(p, "elapsedPct")}%. Щоб устигнути — ${m(num(p, "perMonth"))}/міс (лишилось ${num(p, "daysLeft")} дн).`
          : `Saved ${num(p, "progressPct")}%, but ${num(p, "elapsedPct")}% of time elapsed. To make it — ${m(num(p, "perMonth"))}/mo (${num(p, "daysLeft")} days left).`,
      };
    }

    case "dead_sub": {
      const title = s(p, "title");
      const perMonth = num(p, "perMonth");
      return {
        title: uk ? `${title} — списань не видно` : `${title} — no charges seen`,
        body: perMonth > 0
          ? (uk
              ? `План на ${m(perMonth)}/міс активний понад 60 днів, але жодної операції до нього не привʼязано. Або підписки вже нема, або списання не розпізналось.`
              : `A ${m(perMonth)}/mo plan has been active over 60 days, but no transaction is linked to it. Either the subscription is gone, or charges aren't recognized.`)
          : (uk
              ? "План активний понад 60 днів без жодного фактичного списання."
              : "Plan active over 60 days with no actual charges."),
      };
    }

    case "todo": {
      const n = num(p, "n");
      return {
        title: uk ? `${n} операцій без категорії` : `${n} uncategorized transactions`,
        body: uk
          ? "За останні 30 днів. Поки вони без категорії — статистика, бюджети й поради рахують не все."
          : "In the last 30 days. While uncategorized, stats, budgets and advice don't count everything.",
      };
    }

    /**
     * A file-fed account has gone quiet — see `drafts-import.ts` for why silence here is the
     * dangerous kind. The account is NAMED because the reader may keep two, and the age is given
     * in days rather than as a date: "37 days" is a judgement, "07.07" is homework.
     */
    case "stale_import": {
      const account = String(p?.account ?? "");
      const days = num(p, "days");
      return {
        title: uk ? `Виписка «${account}» застаріла` : `Statement for "${account}" is stale`,
        body: uk
          ? `Останню операцію імпортовано ${days} дн. тому. Цей рахунок оновлюється лише файлом — поки виписки немає, витрати, бюджети й поради рахують не все.`
          : `The newest imported operation is ${days} days old. This account only updates from a file — until a statement is imported, spending, budgets and advice are counting an incomplete picture.`,
      };
    }

    /**
     * §BUDGET-FORECAST — the envelope is heading over, and there is still time to steer.
     *
     * Says the projected figure AND what is spent so far, in that order: the projection is the
     * actionable number, but showing it alone would invite reading it as money already gone. The
     * word "projected" is not decoration here — a forecast presented as a fact is a lie the app
     * tells once and then has to live with.
     */
    case "budget_forecast": {
      const name = s(p, "name");
      const pct = num(p, "pct");
      return {
        title: uk
          ? `«${name}» іде на ${pct}% бюджету`
          : `“${name}” is heading for ${pct}% of its budget`,
        body: uk
          ? `За поточним темпом місяць закриється на ${money(locale, num(p, "projected"))} при ліміті ${money(locale, num(p, "amount"))}. Витрачено поки що ${money(locale, num(p, "spent"))} — час іще є.`
          : `At the current pace the month closes at ${money(locale, num(p, "projected"))} against a ${money(locale, num(p, "amount"))} limit. Spent so far: ${money(locale, num(p, "spent"))} — there is still time.`,
      };
    }

    /**
     * Scheduled work that did not finish.
     *
     * Names the STEP and the reason, because the only thing worse than a weekly report failing is
     * a weekly report failing silently — "there is no report for last week" and "the generation
     * threw last Monday" look identical from the outside, and until now the app could not tell
     * them apart either. The error text is shown as-is, for the same reason §Error handling shows
     * the real cause: a limit, a missing key and a model outage need different responses.
     */
    case "cron_failed": {
      const step = s(p, "step");
      const reason = s(p, "reason");
      return {
        title: uk ? "Планова задача не виконалась" : "A scheduled task did not run",
        body: uk
          ? `«${step}» впала: ${reason}. Наступна спроба — за розкладом; запустити вручну можна на відповідному екрані.`
          : `“${step}” failed: ${reason}. The next attempt is on schedule; you can also run it by hand from its own screen.`,
      };
    }

    default: {
      // Exhaustiveness: a new template key must be handled here or `tsc` flags it.
      const _never: never = key;
      return { title: String(_never), body: null };
    }
  }
}
