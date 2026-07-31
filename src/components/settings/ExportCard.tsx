import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";

// L10 — «вивантажити все». Дані живуть в ОДНОМУ Durable Object і бекапів немає; CSV-експорт
// віддає лише операції, тож найгірший сценарій («обʼєкт зник») не був закритий нічим.
//
// Обидва посилання — звичайні `<a href>`, а не fetch+Blob: браузер сам покаже прогрес і сам
// збереже файл за `content-disposition`, а дамп на кілька мегабайтів не треба тримати в памʼяті
// вкладки. Ціна — не можна показати спінер; воно того варте.
export function ExportCard() {
  const t = useT();
  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="export" size={16} />{t("setup.exportTitle")}</div>
      <p className="set-card-sub">{t("setup.exportSub")}</p>
      <div className="stack" style={{ marginTop: 12 }}>
        <a className="btn" href="/api/export/all.json" download>
          <Icon name="export" size={15} />{t("setup.exportAll")}
        </a>
        <a className="btn ghost" href="/api/export/transactions.csv" download>
          {t("setup.exportCsv")}
        </a>
      </div>
      <p className="set-card-sub" style={{ margin: "12px 0 0" }}>{t("setup.exportNote")}</p>
    </div>
  );
}
