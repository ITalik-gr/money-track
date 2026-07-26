import { useLocale, useT } from "../i18n/index.ts";
import type { Locale } from "../i18n/index.ts";

const LOCALES: Locale[] = ["uk", "en"];

// Public landing for logged-out visitors (P5.2). A recruiter should see this, not a login form.
// Two calls to action: the demo (open, no sign-up) and sign-in (invite-only real accounts).
export function Landing() {
  const t = useT();
  const { locale, setLocale } = useLocale();

  const features: [string, string][] = [
    [t("landing.f1Title"), t("landing.f1Body")],
    [t("landing.f2Title"), t("landing.f2Body")],
    [t("landing.f3Title"), t("landing.f3Body")],
  ];

  return (
    <div className="landing">
      <header className="lp-top">
        <div className="lp-brand">
          <span className="mark">₴</span>
          <span className="name">money<span className="dot">·</span>track</span>
        </div>
        <div className="lang-seg" role="group" aria-label="Language">
          {LOCALES.map((l) => (
            <button key={l} type="button" className={l === locale ? "on" : ""} aria-pressed={l === locale} onClick={() => setLocale(l)}>
              {l === "uk" ? "UA" : "EN"}
            </button>
          ))}
        </div>
      </header>

      <section className="lp-hero">
        <h1>{t("landing.h1")}</h1>
        <p className="lp-sub">{t("landing.sub")}</p>
        <div className="lp-cta">
          {/* Plain links, not fetches: both are Worker routes that redirect. */}
          <a className="btn primary lg" href="/demo">{t("landing.tryDemo")} →</a>
          {/* Straight to Google — there is no password any more, so an intermediate login
              screen would just be a page with one button on it. */}
          <a className="btn lg" href="/auth/google/start">{t("landing.signInGoogle")}</a>
        </div>
        <p className="lp-note">{t("landing.demoNote")}</p>
        {/* Disclosure, deliberately on the landing and not buried in settings: the visitor
            should know what leaves the app BEFORE connecting a bank account. */}
        <p className="lp-note">{t("landing.aiNote")}</p>
      </section>

      <section className="lp-keys card">
        <h3>{t("landing.keysTitle")}</h3>
        <p>{t("landing.keysBody")}</p>
      </section>

      <section className="lp-features">
        {features.map(([title, body], i) => (
          <div key={i} className="lp-feature card">
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <footer className="lp-foot">{t("landing.footer")}</footer>
    </div>
  );
}
