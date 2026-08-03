# Security Policy

Money Track handles personal financial data — bank transactions, balances, and API tokens for
banking and AI providers. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting](https://github.com/ITalik-gr/money-track/security/advisories/new)
(Security → Report a vulnerability). Include what you can:

- what the flaw allows an attacker to do,
- the steps or request sequence that trigger it,
- whether it needs an authenticated session, and whose.

This is a single-maintainer hobby project, so there is no paid bounty and no guaranteed response
time — but reports are read, and anything that lets one user reach another user's data is treated
as the highest priority.

## What is in scope

The parts most worth looking at, because they are where the real boundaries are:

- **Cross-tenant access.** Each user's financial data lives in their own Durable Object, keyed by
  `idFromName(userId)`. Anything that lets a request reach a different user's object is critical.
- **Session handling.** Sessions are stateless HMAC tokens (`__Host-` prefixed cookie) carrying a
  `token_version` that the directory can invalidate. Forgery, fixation, or a revocation bypass all
  qualify.
- **Owner-only resources.** Deployment secrets (bank token, AI key, webhook secret, Telegram bot)
  belong to the deploying owner, never to invited users. A path that lets a non-owner fall back to
  them is a cross-tenant issue — this class of bug has been found and fixed here twice.
- **Stored credentials.** User bank/AI keys are AES-GCM encrypted with a master key held only as a
  Worker secret, and are never returned to the client, even masked.
- **Webhook and bot endpoints.** Bank webhooks use a signed per-user path; the Telegram webhook is
  gated by a secret token plus a chat allowlist.

## Known and accepted limitations

These are deliberate trade-offs, documented so you don't spend time reporting them as findings:

- **Session revocation takes up to ~60 seconds** to propagate. Access checks are cached per isolate
  to keep a database read off the hot path.
- **Error responses include the underlying cause.** Without it, a failing model call, an expired
  key, or a rate limit is undiagnosable. If this project ever serves users beyond a trusted circle,
  the detail should move behind an owner flag.
- **Rate limiting is per-isolate**, not global — the counter window lives in isolate memory. A WAF
  rule in front of `/api/*` is the appropriate complement for a real deployment.
- **There are no backups.** Data lives in a single Durable Object per user; only manual CSV export
  exists. Do not run this as the sole record of anything you cannot afford to lose.

## If you self-host

Read `CLAUDE.md` §Ops before deploying. In particular: set a **separate** AI API key for the demo
sandbox with its own provider-side spend limit, never reuse the owner key, and never rotate
`SECRETS_MASTER_KEY` — doing so makes every stored user credential permanently unreadable.
