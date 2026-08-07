// L6 — the tasks we ask the model to perform that have no feature file of their own.
//
// Everything with a home already went to it in phase 5: OCR to `receipt.ts`, categorisation and
// text parsing to `enrich.ts`, the report to `report.ts`, the insight to `insight.ts`. What is
// left is the CONVERSATIONAL surface — the adviser, the per-transaction chat, the budget chat,
// the group verdict, the feed observations — plus the shapes those answers come back in.
//
// Two rules that live with these calls rather than with the transport:
//  • **A number from the model that reaches the UI needs a deterministic check beside it**
//    (`numbersAreGrounded`). The prompt already forbade inventing sums; the model produced two
//    different figures for one thing in a single notification anyway.
//  • **The model does not know what it already said.** Repetition is cured by an EXPLICIT list of
//    what has been covered, not by asking it to "be interesting".
import type { Env } from "../../env.ts";
import { callHaikuMessages, runToolConversation, webSearchTool, type AnthropicContentBlock, type ChatMsg, type ChatTool, type OnText, type ToolExecutor } from "./ai.ts";
import { isDemoEnv } from "../platform/demo.ts";
import { buildKnowledgeCorpus } from "./knowledge/index.ts";
import { callHaikuJson, callHaikuMessagesJson } from "./json.ts";
import { buildSystemPrefix, replyLangDirective } from "./prompt.ts";
import { getTaskModel } from "./models.ts";
import type { AnthropicUsage } from "./cost.ts";
import type { StructuredInsight } from "./insight.ts";

export async function chatAdvice(
  env: Env,
  context: unknown,
  messages: ChatMsg[],
  opts?: { tools?: ChatTool[]; executor?: ToolExecutor; onText?: OnText },
): Promise<{ text: string; usage: AnthropicUsage }> {
  const today = new Date().toISOString().slice(0, 10);
  // Demo: no server-side web_search (billed per search on top of tokens) and a shorter tool loop.
  // The prompt must match what is actually sent — describing a tool the request does not carry
  // makes the model try to call it and waste a turn. `demoClamp` still strips it as a backstop.
  const demo = isDemoEnv(env);
  const toolNote = opts?.tools?.length
    ? `Сьогодні ${today}. У тебе Є ІНСТРУМЕНТИ (tools) для запитів до ПОВНОЇ бази операцій користувача (не лише контекст вище): ` +
      "query_spend (сума витрат/доходу за період з фільтром по категорії/мерчанту й групуванням), find_transactions (знайти конкретні " +
      "операції), list_categories (перелік категорій). ВИКОРИСТОВУЙ їх, коли фіксованого контексту не вистачає — напр. питання про " +
      "конкретний період/категорію/мерчанта в минулому («скільки на таксі влітку торік», «мої найбільші покупки в грудні»). Сам обчислюй " +
      "дати періодів (YYYY-MM-DD) відносно сьогодні. НЕ вигадуй числа — якщо треба точні дані поза контекстом, виклич інструмент. " +
      "Операції з інструментів теж можна цитувати як [tx:ID|підпис]. " +
      (demo
        ? ""
        : "Ще Є web_search — пошук в офіційних джерелах (курс НБУ, тарифи, податки, ціни) для АКТУАЛЬНИХ фактів " +
          "про світ, яких нема в тренувальних даних; використовуй його ЛИШЕ для зовнішніх фактів (не для особистих " +
          "операцій користувача) і посилайся на джерело. ")
    : "";
  // §A5: стабільний блок (корпус знань + персона/правила) з cache_control ttl:1h — байт-ідентичний
  // між викликами й користувачами, тож читається з кешу ≈0.1×. Динамічний контекст — окремим блоком
  // ПІСЛЯ (не кешується). Це ще й здешевлює: персона раніше слалась щоразу без кешу.
  const stableRules =
    "Ти — досвідчений персональний фінансовий менеджер користувача у застосунку Money Track (не безликий бот, а радник " +
    "«зі стажем», який веде саме ЙОГО гроші). Відповідай українською, по-людськи, по суті. Твоя робота — не лише " +
    "констатувати цифри, а РАДИТИ РІШЕННЯ: куди спрямувати гроші, платити зараз чи почекати, що різати першим, як " +
    "розтягнути подушку, коли безпечно витратити. Думай як менеджер, що дбає про клієнта: пріоритети, тайминг, ризик. " +
    "Коли питання просте — стисло; коли складне чи користувач просить розібратись/порадити — відповідай ДЕТАЛЬНО й " +
    "структуровано (короткий висновок → пояснення на його числах → 2-4 конкретні дієві кроки з ефектом у грн). " +
    "⚠️ КОШТИ (критично — не плутай): liquid_cushion_uah — реальна ліквідна ПОДУШКА (готівка/картки/банки), це головне " +
    "число для «скільки протягну». debt_uah — використаний кредитний ЛІМІТ (це БОРГ, а не «мінус запас»). " +
    "investment_reserve_uah — крипта/брокер: остання лінія оборони, НЕ подушка й НЕ входить у runway; не радь її чіпати, " +
    "поки ситуація не критична. own_funds_uah = подушка − борг (нетто). accounts — рахунки з роллю та описом (note): " +
    "враховуй їх, не домислюй сум поза контекстом. runway_months = подушка / burn. " +
    "⚠️ ПЕРІОДИ: monthly_burn_uah та avg_month_uah — це вже СЕРЕДНЄ НА МІСЯЦЬ; spent_90d_uah — сума за 90 днів. " +
    "Порівнюючи з доходом чи burn — бери місячні числа; НЕ називай 90-денну суму місячною. recent_oneoff — разові " +
    "витрати (податки/лікар): не проектуй їх як регулярні. upcoming_charges — найближчі списання (in_days): спирайся на " +
    "них для порад про тайминг платежів. " +
    "Форматування — markdown: **жирний** для акцентів, списки «- », короткі підзаголовки. " +
    "Якщо в контексті є transactions:[{id,label}] і доречно послатися на конкретну операцію — цитуй її як " +
    "[tx:ID|короткий підпис] (напр. [tx:abc|MrGrill 150₴]); застосунок зробить із цього клікабельний чип. " +
    "📊 ВІЗУАЛІЗАЦІЇ — використовуй ОЩАДЛИВО, лише коли вони справді допомагають зрозуміти (порівняння кількох чисел, " +
    "розклад, план по місяцях). НЕ додавай графік/таблицю до кожної відповіді й ніколи — коли достатньо речення. " +
    "Максимум одна візуалізація на відповідь, лише з реальних чисел контексту.\\n" +
    "• Міні-графік (горизонтальні бари для порівняння): рядок «[chart:Заголовок]», далі по рядку «Підпис|число» " +
    "(число у грн, без символів), закрий «[/chart]». Приклад: [chart:Витрати по категоріях]\\nПродукти|4500\\nКафе|3200\\n[/chart]. Макс 6 рядків.\\n" +
    "• Таблиця (коли треба кілька колонок, напр. план погашення чи ліміт vs факт): рядок «[table:Заголовок]», далі " +
    "рядок заголовків «Кол1|Кол2|Кол3», далі рядки даних так само через «|», закрий «[/table]». Макс 6 рядків даних, 4 колонки.";
  const system: AnthropicContentBlock[] = [
    // Корпус = вбудовані доки + користувацький шар (нотатки/заміни з `knowledge_docs`).
    // Блок лишається СТАБІЛЬНИМ між викликами (детермінований порядок), тож prompt-cache
    // працює як раніше; текст міняється лише коли користувач сам відредагував документ.
    { type: "text", text: (await buildKnowledgeCorpus(env.DB)) + "\n\n---\n\n" + stableRules, cache_control: { type: "ephemeral", ttl: "1h" } },
    {
      type: "text",
      text:
        toolNote +
        "Ось повний фінансовий контекст користувача (суми в грн): " + JSON.stringify(context) +
        ". Спирайся ЛИШЕ на ці дані; якщо потрібної інформації нема — скажи чесно, не вигадуй транзакцій чи чисел." +
        (await replyLangDirective(env, "conversation")),
    },
  ];
  const model = await getTaskModel(env, "chat");
  // §AGENT: якщо передано інструменти — ведемо агентний діалог; інакше звичайний виклик.
  if (opts?.tools?.length && opts.executor) {
    // §A3: додаємо серверний web_search (варіант за моделлю) — актуальні курси/тарифи/ціни.
    const serverTools = demo ? [] : [webSearchTool(model)];
    // Each turn is a separate billed request AND a separate `demoAiGate` hit, so a demo sandbox
    // gets a shorter loop: 6 turns of one question could eat half its whole session allowance.
    const maxTurns = demo ? 3 : 6;
    const { text, usage } = await runToolConversation(env, system, messages, opts.tools, opts.executor, 1500, model, maxTurns, serverTools, opts.onText);
    return { text: text.trim(), usage };
  }
  // §R6/§CTX: детальні відповіді менеджера — більший ліміт виводу.
  const { text, usage } = await callHaikuMessages(env, system, messages, 1500, model, opts?.onText);
  return { text: text.trim(), usage };
}


// Інлайн-чат по КОНКРЕТНІЙ операції: людяна відповідь + опційне оновлення розуміння
// (категорія / прапорець переказу). Модель міняє категорію лише за чіткої підстави з розмови.
export interface TxChatResult {
  reply: string;                 // 1-3 речення живою мовою (можна легкий markdown)
  category_id?: number | null;   // id з переліку — ЛИШЕ якщо треба змінити категорію
  is_transfer?: boolean;         // true, якщо стало ясно, що це переказ між своїми
  understanding?: string | null; // оновлений короткий здогад «що це»
}

export async function txChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: TxChatResult; usage: AnthropicUsage }> {
  const base = await buildSystemPrefix(
    env,
    "це діалог користувача про КОНКРЕТНУ банківську операцію (її контекст — нижче). Допоможи зрозуміти чи " +
      "уточнити операцію, відповідай стисло українською. Якщо користувач прямо каже, ЩО це (напр. «це відпочинок», " +
      "«це продукти», «поверни в кафе»), або з розмови стало однозначно ясно — онови категорію (враховуй синоніми: " +
      "відпочинок/дозвілля→Розваги, їжа→Продукти тощо). Відповідай ВИКЛЮЧНО валідним JSON: {reply (1-3 речення, " +
      "можна **жирний**), category_id (id основної категорії з переліку — ЛИШЕ якщо треба змінити; інакше пропусти поле), " +
      "is_transfer (true якщо стало ясно, що це переказ між своїми рахунками; інакше пропусти поле), " +
      "understanding (оновлений короткий здогад «що це» або null)}. НЕ міняй категорію без чіткої підстави з розмови. " +
      "У контексті є user_note (нотатка користувача до операції) та user_profile (опис користувача) — ОБОВʼЯЗКОВО " +
      "враховуй їх: якщо користувач уже пояснив, що це, спирайся на це, а не ігноруй. " +
      "Якщо це НАДХОДЖЕННЯ і користувач каже, що це його зарплата / дохід / вивід власних коштів (напр. вивів " +
      "криптозарплату переказом від людини) — постав «Зарплата» (чи названий дохід) і опиши розуміння саме так; " +
      "НЕ називай це «Подарунком» і не пиши «переказ від приватної особи», якщо користувач прямо сказав інше.",
  );
  const system: AnthropicContentBlock[] = [
    ...base,
    // This inline chat had NO language directive at all (found while fixing B6) — its prose
    // answer simply inherited the Ukrainian prompt regardless of who was reading.
    { type: "text", text: "Контекст операції (суми в її валюті): " + JSON.stringify(ctx) + (await replyLangDirective(env, "conversation")) },
  ];
  return callHaikuMessagesJson<TxChatResult>(env, system, messages, 700, await getTaskModel(env, "chat"));
}





// AI-планувальник бюджету (§ візія): з історії витрат + ситуації користувача пропонує
// місячні ліміти-конверти по кожній категорії з коротким обґрунтуванням.
export interface BudgetPlan {
  proposals: { category_id: number; limit_uah: number; reason: string }[];
  overall: string;
}

export async function proposeBudgetLimits(
  env: Env,
  payload: unknown,
): Promise<{ result: BudgetPlan; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — фінансовий планувальник. На основі ситуації користувача (situation), його чисел " +
        "(власні кошти, місячний burn, runway у місяцях) та середніх витрат по категоріях за 3 місяці " +
        "(categories: [{id, name, avg_month_uah, current_limit_uah}]) запропонуй розумні МІСЯЧНІ ліміти-конверти " +
        "по КОЖНІЙ поданій категорії (те саме id). Якщо runway малий або мета — економія, пропонуй реалістичне " +
        "скорочення дискреційних витрат (розваги, кафе, підписки, одяг), але не ріж надмірно базові (продукти, " +
        "комуналка, здоровʼя). Ліміти — цілі числа в гривнях, не завищені й не нульові. Відповідай ВИКЛЮЧНО " +
        "валідним JSON: {proposals:[{category_id, limit_uah, reason}], overall} — reason 1 короткою фразою " +
        "(укр.), overall — 1-2 речення про логіку плану. Без markdown.",
    },
  ];
  return callHaikuJson<BudgetPlan>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "budget"));
}

// Спільний структурований «факт» для стилізованого рендеру (гроші/категорії/дельти).
export interface AiFact {
  label: string;
  amount?: number | null;    // грн (major), число або null
  category?: string | null;  // назва категорії, якщо доречно
  delta_pct?: number | null; // зміна проти минулого періоду, +/-
  tone?: "pos" | "neg" | "neutral" | null;
}

// Дія, яку можна виконати прямо з поради (§дієві поради).
export interface AdviceAction {
  type: "create_budget";
  label: string;              // текст кнопки
  category_id?: number | null;
  category_name?: string | null;
  amount_uah?: number | null; // для create_budget — ліміт у грн
}

// Структуровані фінансові поради під ситуацію користувача (§advisor).
export interface AdviceResult {
  runway_comment: string;                         // 1-2 речення про запас/скільки протягнеш
  summary: string;                                // короткий підсумок ситуації
  facts: AiFact[];                                // 2-5 ключових фактів для стилізації
  suggestions: { title: string; detail: string; action?: AdviceAction | null }[]; // 3-5 кроків
}

// Спостереження для стрічки сповіщень (Центр сповіщень, kind='ai'). Модель НЕ рахує —
// вона лише називає людською мовою те, що вже пораховано канонічно (collectFinanceSnapshot).
// Це і є різниця з «тупим алертом»: не «поріг перевищено», а що змінилось і що з цим робити.
export interface NotifyObservation { title: string; body: string; severity?: string }
export async function generateNotifyObservations(
  env: Env,
  payload: unknown,
): Promise<{ result: { observations?: NotifyObservation[] }; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — особистий фінансовий помічник. Дивишся на знімок фінансів користувача і формулюєш " +
        "0-2 КОРОТКІ спостереження для стрічки сповіщень. " +
        "⚠️ ГОЛОВНЕ: використовуй ВИКЛЮЧНО числа з payload. НЕ рахуй нових сум, НЕ множ, НЕ оцінюй «на око», " +
        "НЕ вигадуй цифр, яких у payload немає — краще без числа, ніж із вигаданим. " +
        "Кожну суму, яку пишеш, ти маєш могти показати пальцем у payload; сума, якої там нема, " +
        "автоматично відкидає все спостереження. " +
        "🚫 ЖОДНИХ приблизних форм: не «5000+», не «близько 3 тис», не «~4000» — або точне число з payload, або без числа. " +
        "🚫 ОДНА СУМА ПРО ОДНЕ: якщо назвав суму в title, у body повторюй ЇЇ САМУ, а не іншу оцінку того самого " +
        "(«N підписок дають 4820 ₴/міс … це 5000+ ₴/міс» — груба помилка, дві різні цифри про одне). " +
        "🚫 НЕ приписуй сумі періоду, якого нема в payload («сума X за 27 днів», якщо период інший): пиши період так, як він поданий. " +
        "⚠️ ПЕРІОДИ: monthly_burn_uah уже усереднений НА МІСЯЦЬ; у категорій є і spent_90d_uah, і avg_month_uah — " +
        "для порівнянь бери avg_month_uah, не називай 90-денну суму місячною. " +
        "Спостереження має бути ДІЄВИМ: не «витрати зросли», а що саме змінилось і що варто зробити. " +
        "НЕ дублюй те, про що вже є окремі сповіщення: перевищений бюджет, дедлайн підписки, подорожчання, " +
        "аномалія темпу категорії, провал ліквідності, індекс здоровʼя. Шукай те, чого детермінований " +
        "детект НЕ ловить: зміну структури витрат, накопичений ефект дрібних сум, звʼязок між категоріями, " +
        "наслідок ситуації користувача (situation). " +
        "Якщо нічого справді вартого уваги немає — поверни порожній масив. Це нормальна й правильна відповідь: " +
        "мовчання краще за шум. " +
        // Спостереження генеруються ЩОДНЯ на майже незмінному знімку, тож без цього блоку модель
        // щоранку переказує ту саму думку іншими словами («на скільки вистачить запасу»), і
        // Telegram перетворюється на щоденну розсилку однієї фрази. Дедуп за змістом стоїть і в
        // коді (`notify.ts`), але він ловить лише однакове формулювання — тему ловити тут.
        "🚫 НЕ ПОВТОРЮЙСЯ: у payload є recent_observation_titles — теми, про які ти вже писав " +
        "останні два тижні. Не переказуй їх іншими словами (навіть якщо число трохи змінилось) — " +
        "шукай НОВЕ. Якщо нового нема, порожній масив краще за перефразування. " +
        "МОВА: природна українська. title — іменникова фраза, як заголовок новини " +
        "(«Кредитний борг зʼїдає подушку», а НЕ «Мініатюрний дохід vs квартира не робить»). " +
        "Жодних англійських слів і внутрішніх термінів у тексті: не «optional/discretionary», а " +
        "«необовʼязкові витрати»; не «burn», а «витрати на місяць»; не «runway», а «запас/на скільки вистачить». " +
        "title ≤ 60 символів, body ≤ 200 символів, без markdown. " +
        'Відповідай ВИКЛЮЧНО валідним JSON: {"observations":[{"title","body","severity":"info"|"warn"}]}' +
        (await replyLangDirective(env)),
    },
  ];
  return callHaikuJson<{ observations?: NotifyObservation[] }>(
    env, system, [{ type: "text", text: JSON.stringify(payload) }], 700, await getTaskModel(env, "notify"),
  );
}


export async function generateAdvice(
  env: Env,
  payload: unknown,
): Promise<{ result: AdviceResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — особистий фінансовий радник. На основі опису ситуації користувача (situation) та його чисел " +
        "(власні кошти, місячний burn, runway у місяцях, топ-категорії, топ-мерчанти) дай практичні поради " +
        "українською. ⚠️ ПЕРІОДИ: monthly_burn_uah вже усереднений НА МІСЯЦЬ; суми top_categories/top_merchants/by_event " +
        "подано і за 90 днів (spent_90d_uah), і на місяць (avg_month_uah). Для порад і порівнянь із доходом/burn " +
        "спирайся на avg_month_uah, а НЕ на 90-денну суму — не називай накопичене за 3 місяці місячним. " +
        "🚫 НЕ «ПО КНИЖЦІ»: ПОВАЖАЙ situation як тверде обмеження. Якщо користувач без роботи / між роботами / шукає — " +
        "НЕ радь абстрактно «збільшити дохід», «додати джерело доходу», «закласти дохід у бюджет». Замість цього: " +
        "подовження runway, ріж optional/discretionary, використання ліквідної подушки. Не давай generic-порад, які " +
        "пасують будь-кому — кожна порада має спиратись на КОНКРЕТНІ його числа/категорії. " +
        "💰 КОШТИ ЧЕСНО: liquid_cushion_uah — реальний запас (заощадження/плюсові рахунки); debt_uah — борг по кредитці. " +
        "own_funds_uah (нетто) може бути ВІД'ЄМНИМ через борг — це НЕ «мінус запас», реальна подушка окремо. Runway рахуй/трактуй " +
        "від подушки. 🏦 РАХУНКИ: у payload accounts — рахунки з роллю (role) та ОПИСОМ (note). role='investment' (крипта/брокер) " +
        "у investment_reserve_uah — це НЕ ліквідна подушка й НЕ входить у runway; згадуй його як окремий резерв/останню лінію, " +
        "не пропонуй продавати інвестиції, поки ситуація не критична. Враховуй note кожного рахунку як контекст. " +
        "recent_oneoff — разові витрати місяця (податки, лікар): НЕ вважай їх регулярними й не проектуй у майбутнє. " +
        "У payload є citable_operations:[{id,label}] — коли згадуєш конкретну операцію в summary чи suggestions.detail, " +
        "встав після назви токен [tx:ID] з відповідним id (напр. «Rozetka [tx:abc]»). Лише наявні id, не вигадуй, 1-2 доречні. " +
        "Будь конкретним і емпатичним, без води й без markdown. Відповідай ВИКЛЮЧНО валідним JSON: " +
        "{runway_comment, summary, " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (число або null), tone ('pos'|'neg'|'neutral')}] (2-5 ключових фактів), " +
        "suggestions:[{title, detail, action}]} — 3-5 порад, кожна дієва (що саме скоротити/зробити і ефект у грн). " +
        "action — або null, або {type:'create_budget', label, category_id (з top_categories), category_name, amount_uah} " +
        "коли доречно запропонувати ліміт-конверт на категорію. Суми — у гривнях." +
        (await replyLangDirective(env)),
    },
  ];
  return callHaikuJson<AdviceResult>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "advisor"));
}


// §3: діалог про бюджети — AI пропонує/коригує ліміти в розмові й пояснює ЧОМУ.
export interface BudgetChatResult {
  reply: string;
  proposals?: { category_id: number; limit_uah: number; reason: string }[];
}
export async function budgetChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: BudgetChatResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — помічник із бюджетування. Веди діалог українською про МІСЯЧНІ бюджети-конверти по категоріях. " +
        "Контекст (нижче) має categories:[{id,name,avg_month_uah,current_limit_uah,importance}], own_funds_uah, " +
        "monthly_burn_uah, situation. Радь РЕАЛІСТИЧНІ ліміти на основі avg_month_uah і вагомості: essential " +
        "(обов'язкові) не ріж різко; optional (необов'язкові) можна стискати сильніше. Пояснюй ЧОМУ саме стільки. " +
        "Коли пропонуєш конкретні ліміти — клади їх у proposals, щоб користувач прийняв одним тапом. " +
        "Відповідай ВИКЛЮЧНО валідним JSON: {reply (2-5 речень, можна **жирний**), " +
        "proposals:[{category_id (лише з переліку), limit_uah (ціле грн), reason (коротко чому)}] " +
        "(порожній масив, якщо це просто відповідь без нових пропозицій лімітів)}." +
        (await replyLangDirective(env, "conversation")),
    },
    { type: "text", text: "Контекст: " + JSON.stringify(ctx) },
  ];
  return callHaikuMessagesJson<BudgetChatResult>(env, system, messages, 1400, await getTaskModel(env, "budget"));
}


// §GR2: оцінка групи/події — вплив на бюджет, чи дорого, чи варте. Структурований JSON,
// може цитувати конкретні транзакції групи як [tx:ID|короткий підпис] (фронт зробить чип).
export async function evaluateGroup(
  env: Env,
  payload: unknown,
): Promise<{ result: StructuredInsight; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — фінансовий асистент. Оціни конкретну ГРУПУ витрат користувача (подорож/подія/проєкт) за поданими " +
        "числами (суми в грн): скільки коштувала, як це відносно місячного burn і запасу (runway), чи це дорого, " +
        "куди пішло найбільше, чи є аномалії. Якщо в payload є transactions:[{id,label}] — можеш послатися на " +
        "помітну операцію у facts.label чи note як [tx:ID|короткий підпис] (напр. [tx:abc|MrGrill 150₴]). " +
        "Відповідай ВИКЛЮЧНО валідним JSON без markdown: {headline (1 речення — головний висновок про групу), " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (null зазвичай), " +
        "tone ('pos'|'neg'|'neutral')}] (2-5), note (1 коротка порада або висновок «дорого/норм» або null)}.",
    },
  ];
  return callHaikuJson<StructuredInsight>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 800, await getTaskModel(env, "group"));
}
