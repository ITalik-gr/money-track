import { useState } from "react";
import { useLocale, useT } from "../i18n/index.ts";
import type { Locale } from "../i18n/index.ts";
import { Icon } from "../components/ui/Icon.tsx";
import { baseSign } from "../lib/currency.ts";

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

  // Demo entry state (B1). `GET /demo` seeds ~350 transactions into a fresh Durable Object before
  // it can redirect, and as a plain <a> that shows as several seconds of blank page — the first
  // thing a visitor sees is a browser that looks hung. So the click is intercepted, the wait is
  // named, and failures (daily sandbox ceiling, seeding error) get a sentence instead of a white
  // screen. The href stays real: without JS, or on a shared /demo link, the redirect form runs.
  const [demoState, setDemoState] = useState<"idle" | "loading">("idle");
  const [demoError, setDemoError] = useState<string | null>(null);

  async function startDemo(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
    e.preventDefault();
    if (demoState === "loading") return;
    setDemoState("loading");
    setDemoError(null);
    try {
      const res = await fetch("/demo?json=1", { credentials: "same-origin" });
      if (res.ok) {
        // Full navigation, not a router push: the demo cookie now exists, and the app has to
        // boot with it (App.tsx decides logged-in vs landing from /me at mount).
        window.location.assign("/");
        return;
      }
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      setDemoError(body?.reason === "daily_limit" ? t("landing.demoLimit") : t("landing.demoFailed"));
    } catch {
      setDemoError(t("landing.demoFailed"));
    }
    setDemoState("idle");
  }

  const features: [string, string][] = [
    [t("landing.f1Title"), t("landing.f1Body")],
    [t("landing.f2Title"), t("landing.f2Body")],
    [t("landing.f3Title"), t("landing.f3Body")],
  ];

  return (
    <div className="landing">
      <header className="lp-top">
        <div className="lp-brand">
          <span className="mark">{baseSign()}</span>
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
            {/* Both are Worker routes. Sign-in stays a plain link (OAuth is a redirect flow);
                the demo is intercepted so the seeding wait is visible — see `startDemo`. */}
            <a
              className={`btn primary lg${demoState === "loading" ? " is-busy" : ""}`}
              href="/demo"
              onClick={startDemo}
              aria-busy={demoState === "loading"}
            >
              {demoState === "loading" ? (
                <>
                  <span className="lp-spin" aria-hidden="true" />
                  {t("landing.demoPreparing")}
                </>
              ) : (
                <>{t("landing.tryDemo")} →</>
              )}
            </a>
            {/* Straight to Google — there is no password any more, so an intermediate login
                screen would just be a page with one button on it. */}
            <a className="btn lg" href="/auth/google/start">{t("landing.signInGoogle")}</a>
          </div>
          {/* The wait is a few seconds of seeding, so say what is happening rather than leaving
              a spinner to speak for itself. `role="status"` announces both states to a reader. */}
          <p className={`lp-note${demoError ? " is-error" : ""}`} role="status">
            {demoError ?? (demoState === "loading" ? t("landing.demoPreparingNote") : t("landing.demoNote"))}
          </p>
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
        <p style={{maxWidth: '820px'}}>{t("landing.aiNote")}</p>
      </section>

      {/* Author link: this page is a portfolio piece, so the person behind it has to be one click
          away. `rel="me"` states the identity relationship; noreferrer keeps the outbound click
          from carrying this app's URL along. */}
      <footer className="lp-foot">
        <p>{t("landing.footer")}</p>
        <p className="lp-author">
          {t("landing.authorPre")}{" "}
          <a href="https://italik.dev/" target="_blank" rel="me noreferrer noopener">
            italik.dev<Icon name="arrowUpRight" size={12} />
          </a>
        </p>
      </footer>
    </div>
  );
}
