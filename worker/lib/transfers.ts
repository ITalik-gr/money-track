// Детект переказів між власними рахунками. Дві стратегії, обидві ставлять is_transfer=1
// (щоб операція не потрапляла в статистику витрат/доходів):
//   1) ПАРА: протилежні рівні суми на РІЗНИХ рахунках у вузькому вікні часу.
//   2) ОДНОСТОРОННЄ (fallback): опис однозначно вказує на внутрішній рух власних коштів
//      (округлення балансу на банку, поповнення власного рахунку, «З … картки»),
//      навіть якщо друга сторона не заведена (напр. виписку банки не бекфілили).
// Ручний перемикач лишається за користувачем.
import type { Env } from "../env.ts";

const WINDOW_S = 15 * 60;       // ±15 хв — звичайна пара card-to-card
const WINDOW_JAR_S = 3 * 86400; // ±3 доби — округлення/поповнення на банку часто постяться пачкою

// Опис однозначно внутрішнього руху власних коштів (safe fallback для одностороннього
// маркування). Формулювання — з описів monobank для округлень і поповнень банки/рахунку.
// «переказ комусь» сюди НЕ входить (може бути витрата) — його лишаємо AI/користувачу.
export function descriptionIsTransfer(desc: string | null): boolean {
  const d = (desc ?? "").toLowerCase();
  if (!d) return false;
  return (
    d.startsWith("округлення балансу") ||
    d.includes("поповнення власного рахунку") ||
    d.includes("поповнення банки") ||
    d.includes("з power банки") ||
    d.includes("власний рахунок") ||
    /\bз .{1,20}картки\b/.test(d)   // «З Білої картки», «З Чорної картки»
  );
}

interface Row {
  id: string; account_id: string; amount: number; currency_code: number; time: number;
  desc: string; is_jar: number; is_transfer: number;
}

export async function detectTransfers(env: Env): Promise<number> {
  // Holds ВКЛЮЧЕНО у вибірку: моно лишає внутрішні рухи («Округлення балансу» на банку)
  // холдом надовго, тоді як вхідна сторона на банці постить одразу hold=0. З фільтром
  // hold=0 мінусова сторона не бачилась → пара не збиралась і обидва рядки лишались у
  // списку окремо. Сеттлмент перезаписує той самий id (repo.upsertMonoTx), тож подвійного
  // рахунку нема; зміну суми на сеттлменті там же й розпарюємо.
  const res = await env.DB.prepare(
    `SELECT t.id, t.account_id, t.amount, t.currency_code, t.time,
            LOWER(COALESCE(json_extract(t.raw_json, '$.description'), t.comment, t.merchant, '')) AS desc,
            CASE WHEN a.type = 'jar' THEN 1 ELSE 0 END AS is_jar,
            t.is_transfer
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.transfer_pair_id IS NULL AND t.amount <> 0
     ORDER BY t.time`,
  ).all<Row>();
  const rows = res.results ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Групуємо додатні за ключем валюта:|сума| для швидкого пошуку пари.
  const positives = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.amount > 0) {
      const key = `${r.currency_code}:${r.amount}`;
      (positives.get(key) ?? positives.set(key, []).get(key)!).push(r);
    }
  }

  const matched = new Set<string>();
  // Пари: обидві сторони отримають спільний transfer_pair_id = id відпливної (−) сторони,
  // щоб у списку показувати пару ОДНИМ рядком (ховаємо вхідну +сторону).
  const pairId = new Map<string, string>();

  // 1) Пари: протилежні рівні суми на різних рахунках у вікні часу. Вікно ширше, якщо
  //    хоч одна сторона — банка (jar) або опис вказує на внутрішній рух (округлення/поповнення).
  for (const r of rows) {
    if (r.amount >= 0 || matched.has(r.id)) continue;
    const key = `${r.currency_code}:${-r.amount}`;
    const candidates = positives.get(key);
    if (!candidates) continue;
    const pair = candidates.find((p) => {
      if (matched.has(p.id) || p.account_id === r.account_id) return false;
      const internal = r.is_jar || p.is_jar || descriptionIsTransfer(r.desc) || descriptionIsTransfer(p.desc);
      const window = internal ? WINDOW_JAR_S : WINDOW_S;
      return Math.abs(p.time - r.time) <= window;
    });
    if (pair) {
      matched.add(r.id);
      matched.add(pair.id);
      pairId.set(r.id, r.id);      // відпливна сторона — «канонічний» id пари
      pairId.set(pair.id, r.id);   // вхідна сторона вказує на той самий id
    }
  }

  // 2) Одностороннє: опис однозначно внутрішній — маркуємо навіть без знайденої пари
  //    (напр. виписку банки не бекфілили, тож є лише списання з картки на банку).
  for (const r of rows) {
    if (!matched.has(r.id) && descriptionIsTransfer(r.desc)) matched.add(r.id);
  }

  if (!matched.size) return 0;
  // Оновлюємо лише те, що РЕАЛЬНО змінюється: односторонні (pair=null) марки вже стоять
  // із вставки (repo) і pair_id не отримають ніколи, тож без цієї перевірки вони щоразу
  // переписувались наново — по одному D1-запиту на кожну, на КОЖЕН вебхук.
  const stmts = [];
  for (const id of matched) {
    const pair = pairId.get(id) ?? null;
    if (pair === null && byId.get(id)?.is_transfer === 1) continue;
    stmts.push(
      env.DB.prepare("UPDATE transactions SET is_transfer = 1, transfer_pair_id = ? WHERE id = ?")
        .bind(pair, id),
    );
  }
  if (!stmts.length) return 0;
  await env.DB.batch(stmts);
  return stmts.length;
}
