import { useLocale, useT } from "../i18n/index.ts";
import type { Locale } from "../i18n/index.ts";
import { Icon } from "../components/ui/Icon.tsx";

const LOCALES: Locale[] = ["uk", "en"];

// Public landing for logged-out visitors (P5.2). A recruiter should see this, not a login form.
// Two calls to action: the demo (open, no sign-up) and sign-in (invite-only real accounts).
//
// Rebuilt 2026-07-26 (user feedback: "по дизайну так собі"). What was wrong and what replaced it:
//   - everything was centred in one narrow column, so the page had no rhythm and the eye had
//     nowhere to land → asymmetric hero: the claim on the left, a diagram of it on the right;
//   - two dense grey disclosure paragraphs sat directly under the CTA, killing the momentum right
//     where the visitor decides → one short line stays, the full disclosure moved down to a
//     dedicated block near the footer where reading it is a choice;
//   - the "what your account needs" card floated alone at half width → it is now a proper
//     two-column section, one column per key;
//   - three identical bordered boxes read as a template → numbered cards with an accent rule.
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
        <div className="lp-top-right">
          <div className="lang-seg" role="group" aria-label="Language">
            {LOCALES.map((l) => (
              <button key={l} type="button" className={l === locale ? "on" : ""} aria-pressed={l === locale} onClick={() => setLocale(l)}>
                {l === "uk" ? "UA" : "EN"}
              </button>
            ))}
          </div>
          <a className="btn sm ghost lp-top-signin" href="/auth/google/start">{t("landing.signIn")}</a>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow">{t("landing.eyebrow")}</span>
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
        </div>

        {/* The product claim, drawn instead of asserted: one canonical layer feeding both the
            screen and the model. This is the slot a real screenshot takes over later — until
            there is one, a diagram beats an empty frame or a fake dashboard. */}
        <figure className="lp-flow" aria-label={t("landing.flowAria")}>
          <div className="lp-flow-src">
            <span className="lp-flow-tag">{t("landing.flowSourceTag")}</span>
            <span className="lp-flow-name">stats.ts</span>
            <span className="lp-flow-desc">{t("landing.flowSourceDesc")}</span>
          </div>
          <div className="lp-flow-split" aria-hidden="true"><span /><span /></div>
          <div className="lp-flow-outs">
            <div className="lp-flow-out">
              <Icon name="stats" size={15} />
              <b>{t("landing.flowUi")}</b>
              <span>{t("landing.flowUiDesc")}</span>
            </div>
            <div className="lp-flow-out">
              <Icon name="spark" size={15} />
              <b>{t("landing.flowAi")}</b>
              <span>{t("landing.flowAiDesc")}</span>
            </div>
          </div>
          <figcaption className="lp-flow-foot">{t("landing.flowFoot")}</figcaption>
        </figure>
      </section>

      <section className="lp-features">
        {features.map(([title, body], i) => (
          <div key={i} className="lp-feature card">
            <span className="lp-feature-n">{String(i + 1).padStart(2, "0")}</span>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <section className="lp-keys card">
        <h2>{t("landing.keysTitle")}</h2>
        <p className="lp-keys-lead">{t("landing.keysLead")}</p>
        <div className="lp-keys-grid">
          <div className="lp-key">
            <span className="lp-key-h"><Icon name="accounts" size={15} />{t("landing.keyMonoTitle")}</span>
            <p>{t("landing.keyMonoBody")}</p>
          </div>
          <div className="lp-key">
            <span className="lp-key-h"><Icon name="spark" size={15} />{t("landing.keyAiTitle")}</span>
            <p>{t("landing.keyAiBody")}</p>
          </div>
        </div>
      </section>

      {/* Disclosure, deliberately on the landing and not buried in settings: the visitor should
          know what leaves the app BEFORE connecting a bank account. Placed here rather than under
          the CTA — it is a thing to read, not a thing to skim past on the way to the button. */}
      <section className="lp-disclosure">
        <Icon name="info" size={15} />
        <p>{t("landing.aiNote")}</p>
      </section>

      <footer className="lp-foot">{t("landing.footer")}</footer>
    </div>
  );
}
