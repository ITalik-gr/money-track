import { useState } from "react";
import { useLocale, useT } from "../i18n/index.ts";
import type { Locale } from "../i18n/index.ts";
import { Icon } from "../components/ui/Icon.tsx";
import { baseSign } from "../lib/currency.ts";

// Screenshots, three sizes and one rule per size — the same split the repo already used before
// this page existed: the ~4000px originals stay in `src/images/` (gitignored — committing them
// would put megabytes of duplicates in the history), README gets 2000px JPEGs in
// `docs/screenshots/`, and what SHIPS to a visitor is a 2200px WebP in `public/shots/` at q72:
// 42–69 KB each, so all six together weigh less than one original.
// Regenerate: `cwebp -q 72 -resize 2200 0 src/images/<n>.jpg -o public/shots/<n>.webp`.
// They sit outside the service worker's precache on purpose (its glob is js/css/html/svg/png/
// woff2) — a signed-in user should never pay to cache the marketing page's pictures.
const LOCALES: Locale[] = ["uk", "en"];
const REPO = "https://github.com/ITalik-gr/money-track";
const MCP_URL = "https://money.italik.dev/mcp";

// Section links. The `href` is the real fragment, so each is a shareable URL and middle-click
// still opens a copy; the handler only replaces the jump with an animation.
const NAV = [
  ["how", "landing.navHow"],
  ["inside", "landing.navInside"],
  ["mcp", "landing.navMcp"],
  ["start", "landing.navStart"],
] as const;

// Public landing for logged-out visitors — the product's front door, not a login form.
//
// Rebuilt 2026-08-26. It had drifted a month and a half behind the product — it still said real
// accounts were invite-only (sign-up has been OPEN since 2026-07-31), and said nothing about MCP,
// budgets that remember, income as a schedule, or the notification feed.
//
// ⚠️ **It no longer presents itself as a portfolio project** (owner, 2026-08-26). The framing was
// on the badge, in the footer and in the privacy lead, and it undersells what the visitor is
// looking at: a page that opens by explaining what it is FOR is a page nobody trusts with a bank
// token. The source link survives — in the footer, where it is a thing to find on the way out.
// ⚠️ **PrivatBank is not named here either.** The provider exists in the code, but it reaches only
// a ФОП account and has never run against the live API, so the ways in are monobank and a
// statement file. A landing that lists a bank the app cannot actually sync is the one lie the
// rest of this page is built to avoid.
//
// The design brief was «дуже аі слоп виглядає», and the fix is structural rather than cosmetic:
//   · REAL SCREENSHOTS instead of drawn product. The old page asserted the dashboard in a diagram;
//     the demo is one click away, so anything drawn is a promise the app has to keep twice.
//   · A NARRATIVE, not a bag of features: how money gets in → how it files itself → what you can
//     ask it. The feature grid comes after that, when "which of these do I care about" is a
//     question the visitor can actually answer.
//   · One change of ground (the dark AI panel) instead of eight identical bordered boxes. Three
//     equal cards in a row is the shape that reads as generated.
// The single diagram that survived is the one claim a screenshot cannot make: the screen and the
// model read the same canonical layer, which is why the advice cannot contradict the chart.
export function Landing() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");

  // Same two writes `Layout` does, and for the same reason: the meta tag has to follow, or the
  // browser/PWA chrome keeps the previous theme's colour until a reload.
  function toggleTheme() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#0b0f14" : "#f3f5f8");
    try { localStorage.setItem("mt-theme", next); } catch { /* private mode — the toggle still works for this visit */ }
    setDark(!dark);
  }

  // Smooth scroll, hand-rolled — and that is not a preference. In this app BODY is the scrolling
  // box (`html, body { height: 100% }` + `body { overflow-x: hidden }`), and Chrome's smooth
  // scrolling does nothing on it: the plain fragment link does not move the page at all, and
  // `scrollIntoView({ behavior: "smooth" })` returns without scrolling or erroring. Writing
  // `scrollTop` directly is the one thing that works — so the easing is ours. Everything about the
  // failure is silent, which is why this comment names it: the next person will otherwise "fix"
  // this back into the one-liner that looks obviously correct and does nothing.
  function jumpTo(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const el = document.getElementById(id);
    if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.replaceState(null, "", `#${id}`);
    const sc = document.body;
    const from = sc.scrollTop;
    const to = Math.max(0, Math.min(el.getBoundingClientRect().top + from - 24, sc.scrollHeight - sc.clientHeight));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sc.scrollTop = to;
      return;
    }
    // Duration grows with distance but is capped: a fixed one makes the short hop sluggish and
    // the full-page one feel like the page is stuck.
    const dur = Math.min(680, 200 + Math.abs(to - from) * 0.12);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      sc.scrollTop = from + (to - from) * (1 - Math.pow(1 - p, 3)); // ease-out cubic, as the tokens do
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Demo entry state. `GET /demo` seeds ~350 transactions into a fresh Durable Object before it can
  // redirect, and as a plain <a> that shows as several seconds of blank page — the first thing a
  // visitor sees is a browser that looks hung. So the click is intercepted, the wait is named, and
  // failures (daily sandbox ceiling, seeding error) get a sentence instead of a white screen. The
  // href stays real: without JS, or on a shared /demo link, the redirect form runs.
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

  const demoBtn = (extra?: string) => (
    <a
      className={`btn primary lg${demoState === "loading" ? " is-busy" : ""}${extra ? ` ${extra}` : ""}`}
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
  );

  // The wait is a few seconds of seeding, so say what is happening rather than leaving a spinner to
  // speak for itself. `role="status"` announces both states to a screen reader.
  const demoNote = (
    <p className={`lp-note${demoError ? " is-error" : ""}`} role="status">
      {demoError ?? (demoState === "loading" ? t("landing.demoPreparingNote") : t("landing.demoNote"))}
    </p>
  );

  const steps: [string, string, string[]][] = [
    [t("landing.s1Title"), t("landing.s1Body"), [t("landing.s1Tag1"), t("landing.s1Tag2"), t("landing.s1Tag3"), t("landing.s1Tag4")]],
    [t("landing.s2Title"), t("landing.s2Body"), [t("landing.s2Tag1"), t("landing.s2Tag2"), t("landing.s2Tag3"), t("landing.s2Tag4")]],
    [t("landing.s3Title"), t("landing.s3Body"), [t("landing.s3Tag1"), t("landing.s3Tag2"), t("landing.s3Tag3"), t("landing.s3Tag4")]],
  ];

  const features: [Parameters<typeof Icon>[0]["name"], string, string][] = [
    ["stats", t("landing.fAnalyticsTitle"), t("landing.fAnalyticsBody")],
    ["plan", t("landing.fBudgetTitle"), t("landing.fBudgetBody")],
    ["repeat", t("landing.fBillsTitle"), t("landing.fBillsBody")],
    ["target", t("landing.fGoalsTitle"), t("landing.fGoalsBody")],
    ["bell", t("landing.fSignalTitle"), t("landing.fSignalBody")],
    ["export", t("landing.fOwnTitle"), t("landing.fOwnBody")],
  ];

  return (
    <div className="landing">
      <div className="lp-glow" aria-hidden="true" />

      <header className="lp-top lp-w">
        <div className="lp-brand">
          <span className="mark">{baseSign()}</span>
          <span className="name">money<span className="dot">·</span>track</span>
        </div>
        <nav className="lp-nav" aria-label={t("landing.navAria")}>
          {NAV.map(([id, key]) => (
            <a key={id} className="lp-nav-link" href={`#${id}`} onClick={(e) => jumpTo(e, id)}>{t(key)}</a>
          ))}
        </nav>
        <div className="lp-top-right">
          <div className="lang-seg" role="group" aria-label="Language">
            {LOCALES.map((l) => (
              <button key={l} type="button" className={l === locale ? "on" : ""} aria-pressed={l === locale} onClick={() => setLocale(l)}>
                {l === "uk" ? "UA" : "EN"}
              </button>
            ))}
          </div>
          <button type="button" className="lp-theme" onClick={toggleTheme} aria-label={t("landing.theme")}>
            <Icon name={dark ? "sun" : "moon"} size={16} />
          </button>
          <a className="btn sm ghost lp-top-signin" href="/auth/google/start">{t("landing.signIn")}</a>
        </div>
      </header>

      <section className="lp-hero lp-w">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow"><b>{t("landing.eyebrowLead")}</b> {t("landing.eyebrow")}</span>
          {/* The accented span is the claim itself, not decoration — it is the half of the sentence
              the rest of the page spends its time proving. */}
          <h1>{t("landing.h1a")} <em>{t("landing.h1b")}</em></h1>
          <p className="lp-sub">{t("landing.sub")}</p>
          <div className="lp-cta">
            {demoBtn()}
            {/* Straight to Google — there is no password any more, so an intermediate login screen
                would be a page with one button on it. */}
            <a className="btn lg" href="/auth/google/start">{t("landing.signInGoogle")}</a>
          </div>
          {demoNote}
        </div>

        {/* The demo's own dashboard, at the demo's own seeded data. Width/height are on the tag so
            the hero does not reflow when it decodes — the CTA sits right under it on a phone. */}
        <figure className="lp-shot lp-shot-hero">
          <img src="/shots/dashboard.webp" width={2200} height={1291} alt={t("landing.shotDashAlt")} />
          <figcaption>{t("landing.shotDashCap")}</figcaption>
        </figure>
      </section>

      <div className="lp-w">
        <section className="lp-stack" aria-label={t("landing.stackLabel")}>
          <span className="lp-stack-label">{t("landing.stackLabel")}</span>
          <div className="lp-stack-item"><b>Cloudflare Worker</b><span>{t("landing.stack1")}</span></div>
          <div className="lp-stack-item"><b>Durable Object / user</b><span>{t("landing.stack2")}</span></div>
          <div className="lp-stack-item"><b>React 19 · PWA</b><span>{t("landing.stack3")}</span></div>
          <div className="lp-stack-item"><b>Claude Haiku + Sonnet</b><span>{t("landing.stack4")}</span></div>
        </section>

        <section className="lp-sec" id="how">
          <header className="lp-sec-head">
            <span className="lp-kicker">{t("landing.howKicker")}</span>
            <h2>{t("landing.howTitle")}</h2>
            <p className="lp-lead">{t("landing.howLead")}</p>
          </header>
          <ol className="lp-steps">
            {steps.map(([title, body, tags], i) => (
              <li key={i} className="lp-step">
                <span className="lp-step-n">{String(i + 1).padStart(2, "0")}</span>
                <h3>{title}</h3>
                <p>{body}</p>
                <ul className="lp-tags">
                  {tags.map((tag) => <li key={tag} className="lp-tag">{tag}</li>)}
                </ul>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-sec" id="inside">
          <header className="lp-sec-head">
            <span className="lp-kicker">{t("landing.featKicker")}</span>
            <h2>{t("landing.featTitle")}</h2>
            <p className="lp-lead">{t("landing.featLead")}</p>
          </header>
          <div className="lp-features">
            {features.map(([icon, title, body]) => (
              <article key={title} className="lp-feature">
                <span className="lp-feature-ico"><Icon name={icon} size={16} /></span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      {/* The one inverted band on the page. Full-bleed, so it sets its own measure. */}
      <section className="lp-ai">
        <div className="lp-w lp-ai-grid">
          <div>
            <span className="lp-kicker">{t("landing.aiKicker")}</span>
            <h2>{t("landing.aiTitle")}</h2>
            <p className="lp-lead">{t("landing.aiLead")}</p>
            <ul className="lp-points">
              <li className="lp-point">
                <Icon name="check" size={15} />
                <div><b>{t("landing.aiP1Title")}</b><span>{t("landing.aiP1Body")}</span></div>
              </li>
              <li className="lp-point">
                <Icon name="check" size={15} />
                <div><b>{t("landing.aiP2Title")}</b><span>{t("landing.aiP2Body")}</span></div>
              </li>
              <li className="lp-point">
                <Icon name="check" size={15} />
                <div><b>{t("landing.aiP3Title")}</b><span>{t("landing.aiP3Body")}</span></div>
              </li>
            </ul>
          </div>

          {/* The product claim drawn instead of asserted: one canonical layer feeding both the
              screen and the model. A screenshot cannot show this — two outputs that agree look
              exactly like two outputs computed twice. */}
          <figure className="lp-flow" aria-label={t("landing.flowAria")}>
            <div className="lp-flow-src">
              <span className="lp-flow-tag">{t("landing.flowSourceTag")}</span>
              <span className="lp-flow-name">lib/finance/stats.ts</span>
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
        </div>

        {/* The claim, as it actually renders. Every figure in that answer came out of the demo's
            own ledger and passed the grounding check before the text reached the screen — which is
            precisely the thing the paragraph above can only assert. Cropped to the answer: the
            empty half of a chat window is not part of the point. */}
        <figure className="lp-w lp-shot lp-ai-shot">
          <img src="/shots/chat.webp" width={2200} height={808} loading="lazy" alt={t("landing.shotChatAlt")} />
          <figcaption>{t("landing.shotChatCap")}</figcaption>
        </figure>
      </section>

      <section className="lp-sec lp-w">
        <header className="lp-sec-head">
          <span className="lp-kicker">{t("landing.shotsKicker")}</span>
          <h2>{t("landing.shotsTitle")}</h2>
          <p className="lp-lead">{t("landing.shotsLead")}</p>
        </header>
        <div className="lp-shots-grid">
          <figure className="lp-shot">
            <img src="/shots/statistics.webp" width={2200} height={1292} loading="lazy" alt={t("landing.shotStatsAlt")} />
            <figcaption>{t("landing.shotStatsCap")}</figcaption>
          </figure>
          <figure className="lp-shot">
            <img src="/shots/transactions.webp" width={2200} height={1292} loading="lazy" alt={t("landing.shotTxAlt")} />
            <figcaption>{t("landing.shotTxCap")}</figcaption>
          </figure>
          <figure className="lp-shot">
            <img src="/shots/subscriptions.webp" width={2200} height={1293} loading="lazy" alt={t("landing.shotSubsAlt")} />
            <figcaption>{t("landing.shotSubsCap")}</figcaption>
          </figure>
          <figure className="lp-shot">
            <img src="/shots/report.webp" width={2200} height={1291} loading="lazy" alt={t("landing.shotReportAlt")} />
            <figcaption>{t("landing.shotReportCap")}</figcaption>
          </figure>
        </div>
      </section>

      <div className="lp-w">
        <section className="lp-sec" id="mcp">
          <header className="lp-sec-head">
            <span className="lp-kicker">{t("landing.mcpKicker")}</span>
            <h2>{t("landing.mcpTitle")}</h2>
            <p className="lp-lead">{t("landing.mcpLead")}</p>
          </header>
          <div className="lp-mcp-grid">
            <div>
              <div className="lp-code">
                <span className="lp-code-label">{t("landing.mcpUrlLabel")}</span>
                <code>{MCP_URL}</code>
              </div>
              <p className="lp-lead">{t("landing.mcpBody")}</p>
            </div>
            <ul className="lp-mcp-list">
              <li><Icon name="check" size={14} />{t("landing.mcpB1")}</li>
              <li><Icon name="check" size={14} />{t("landing.mcpB2")}</li>
              <li><Icon name="check" size={14} />{t("landing.mcpB3")}</li>
              <li><Icon name="check" size={14} />{t("landing.mcpB4")}</li>
            </ul>
          </div>
        </section>

        <section className="lp-sec" id="start">
          <header className="lp-sec-head">
            <span className="lp-kicker">{t("landing.keysKicker")}</span>
            <h2>{t("landing.keysTitle")}</h2>
            <p className="lp-lead">{t("landing.keysLead")}</p>
          </header>
          <div className="lp-keys-grid">
            <div className="lp-key">
              <span className="lp-key-h">
                <Icon name="accounts" size={15} />{t("landing.keyMonoTitle")}
                <span className="lp-key-opt">{t("landing.optional")}</span>
              </span>
              <p>{t("landing.keyMonoBody")}</p>
            </div>
            <div className="lp-key">
              <span className="lp-key-h">
                <Icon name="spark" size={15} />{t("landing.keyAiTitle")}
                <span className="lp-key-opt">{t("landing.optional")}</span>
              </span>
              <p>{t("landing.keyAiBody")}</p>
            </div>
            <div className="lp-key">
              <span className="lp-key-h">
                <Icon name="advisor" size={15} />{t("landing.keyTgTitle")}
                <span className="lp-key-opt">{t("landing.optional")}</span>
              </span>
              <p>{t("landing.keyTgBody")}</p>
            </div>
          </div>
        </section>

        <section className="lp-sec">
          <header className="lp-sec-head">
            <span className="lp-kicker">{t("landing.privKicker")}</span>
            <h2>{t("landing.privTitle")}</h2>
            <p className="lp-lead">{t("landing.privLead")}</p>
          </header>
          <div className="lp-priv-grid">
            <div className="lp-priv-item"><b>{t("landing.priv1Title")}</b><span>{t("landing.priv1Body")}</span></div>
            <div className="lp-priv-item"><b>{t("landing.priv2Title")}</b><span>{t("landing.priv2Body")}</span></div>
            <div className="lp-priv-item"><b>{t("landing.priv3Title")}</b><span>{t("landing.priv3Body")}</span></div>
            <div className="lp-priv-item"><b>{t("landing.priv4Title")}</b><span>{t("landing.priv4Body")}</span></div>
          </div>
          {/* Deliberately on the landing and not buried in settings: the visitor should know what
              leaves the app BEFORE connecting a bank account. */}
          <div className="lp-disclosure">
            <Icon name="info" size={15} />
            <p>{t("landing.aiNote")}</p>
          </div>
        </section>

        <section className="lp-final">
          <h2>{t("landing.ctaTitle")}</h2>
          <p>{t("landing.ctaBody")}</p>
          <div className="lp-cta">
            {demoBtn()}
            <a className="btn lg" href="/auth/google/start">{t("landing.signInGoogle")}</a>
          </div>
          {demoNote}
        </section>

        <footer className="lp-foot">
          <p>{t("landing.footer")}</p>
          {/* `rel="me"` states the identity relationship; noreferrer keeps the outbound click from
              carrying this app's URL along. The source link sits here rather than in the header:
              it is a thing to find on the way out, not one of the four places to go. */}
          <span className="lp-author">
            <a className="lp-src" href={REPO} target="_blank" rel="noreferrer noopener">
              {t("landing.source")}<Icon name="arrowUpRight" size={12} />
            </a>
            {t("landing.authorPre")}{" "}
            <a href="https://italik.dev/" target="_blank" rel="me noreferrer noopener">
              italik.dev<Icon name="arrowUpRight" size={12} />
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
