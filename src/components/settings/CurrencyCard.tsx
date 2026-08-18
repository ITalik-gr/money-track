/**
 * §BASE-CUR — the unit every rolled-up number on every screen is expressed in.
 *
 * Sits in the "Account" tab beside the language switch on purpose: they are the same kind of
 * setting — how the app talks to this reader — and they share a default. Someone who has never
 * chosen a currency inherits one from their language, which is why "follow my language" is a
 * REAL option here and not just the absence of a choice: a reader who picked dollars and then
 * changed their mind has to be able to say so.
 */
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { api, useGetBaseCurrencyQuery, useSetBaseCurrencyMutation } from "../../store/api.ts";
import { store } from "../../store/index.ts";
import { clearBaseCurrency, getBaseCurrency, setBaseCurrency } from "../../lib/currency.ts";
import { asBaseCurrency, BASE_CURRENCIES, currencySign, currencyCode } from "../../../shared/currency.ts";

export function CurrencyCard() {
  const t = useT();
  const { data } = useGetBaseCurrencyQuery();
  const [save, { isLoading }] = useSetBaseCurrencyMutation();
  const stored = asBaseCurrency(data?.stored ?? undefined) ?? null;
  const effective = asBaseCurrency(data?.currency) ?? getBaseCurrency();

  // Every cached figure is denominated in the OLD unit, so the caches go — all of them. A partial
  // invalidation here is the worst outcome available: half the screen in dollars, half in
  // hryvnia, both labelled with the same sign.
  const apply = async (cur: number | null) => {
    await save({ currency: cur }).unwrap().catch(() => undefined);
    const next = asBaseCurrency(cur);
    if (next) setBaseCurrency(next); else clearBaseCurrency();
    store.dispatch(api.util.resetApiState());
  };

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="stats" size={16} />{t("setup.currencyTitle")}</div>
      <p className="set-card-sub">{t("setup.currencySub")}</p>
      <div className="seg" style={{ marginTop: 12 }}>
        {BASE_CURRENCIES.map((c) => (
          <button key={c} className={`seg-btn ${stored === c ? "active" : ""}`} disabled={isLoading}
            onClick={() => apply(c)}>
            {currencySign(c)} {currencyCode(c)}
          </button>
        ))}
        <button className={`seg-btn ${stored === null ? "active" : ""}`} disabled={isLoading}
          onClick={() => apply(null)}>
          {t("setup.currencyAuto")}
        </button>
      </div>
      {/* The effective unit is stated whenever it is not the stored choice — which is exactly the
          two cases a reader would otherwise read as a bug: "follow my language", and a currency
          whose exchange rate we do not have yet (the server falls back and says so). */}
      {stored !== effective && (
        <p className="set-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
          {t("setup.currencyEffective", { cur: `${currencySign(effective)} ${currencyCode(effective)}` })}
        </p>
      )}
    </div>
  );
}
