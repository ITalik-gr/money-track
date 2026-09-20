/**
 * `/tax/*` — ФОП: the reserve, the obligations, the annual limit, the income book (docs/TAX.md).
 *
 * One file owns the whole first segment (C7), so the literal-above-parameterised rule is visible
 * here rather than in a mount order. Transport and validation only: every figure comes from
 * `lib/finance/tax.ts`, and the single SQL statement about business income lives in `repo/tax.ts`.
 */
import { apiRoutes, idParam, numParam } from "./_shared.ts";
import { localParts, localQuarterStart, localYearStart, localYmd } from "../../lib/finance/time.ts";
import {
  readProfile, writeProfile, refreshObligations, taxStatus, fopAvailable,
} from "../../lib/finance/tax.ts";
import type { TaxProfile } from "../../lib/finance/tax-rates.ts";
import * as taxRepo from "../../repo/tax.ts";
import { taxBaseUah, RATE_SCALE } from "../../lib/finance/nbu.ts";
import { currencyCode } from "../../../shared/currency.ts";
import { st } from "../../lib/platform/i18n.ts";
import { businessOverview } from "../../lib/finance/business.ts";
import { quarterSummary } from "../../lib/finance/tax-report.ts";
import * as watch from "../../lib/finance/tax-watch.ts";
import type {
  TaxStatus, TaxProfile as TaxProfileDto, TaxLedger, TaxBackfillResult,
  BusinessOverview, RegWatch, TaxPaymentCandidates,
} from "../../../shared/api/tax.ts";

export const tax = apiRoutes();

const now = () => Math.floor(Date.now() / 1000);

/**
 * §FOP-GATE — the whole surface is the owner's while the module is unfinished.
 *
 * 404 rather than 403: a 403 admits the surface exists and would still put a toast on every
 * screen that asks about the business (`apiErrorMiddleware` toasts any failed request), whereas
 * the client simply does not mount those blocks for a non-owner. One middleware over the prefix,
 * not nineteen checks — a per-handler gate is a gate the twentieth handler will be missing.
 */
tax.use("/tax/*", async (c, next) => {
  if (!fopAvailable(c.env)) return c.json({ error: "not_found" }, 404);
  await next();
});

/**
 * The whole picture, in one request.
 *
 * ⚠️ The accruals are refreshed BEFORE the read, not on a schedule. An open quarter's liability
 * moves with every receipt, so a nightly job would mean the number on screen is yesterday's — and
 * the one place a stale tax figure is guaranteed to be read is the screen someone opened to check
 * it. It is a handful of arithmetic over one period, not a batch.
 */
tax.get("/tax/status", async (c) => {
  await refreshObligations(c.env.DB, now());
  return c.json(await taxStatus(c.env.DB, now()) satisfies TaxStatus);
});

tax.get("/tax/profile", async (c) => {
  return c.json(await readProfile(c.env.DB) satisfies TaxProfileDto);
});

tax.put("/tax/profile", async (c) => {
  const body = await c.req.json<Partial<TaxProfile>>();
  const current = await readProfile(c.env.DB);
  const group = body.group ?? current.group;
  if (![1, 2, 3].includes(group)) {
    return c.json({ error: st(c.get("locale"), "errTaxGroup") }, 400);
  }
  const next: TaxProfile = {
    business: body.business ?? current.business,
    enabled: body.enabled ?? current.enabled,
    group: group as TaxProfile["group"],
    vat: body.vat ?? current.vat,
    // A council rate is money per month, so a negative one is a typo, not a discount. The legal
    // ceiling is applied in `ratesFor`, which is where the rate that produced it also lives.
    single_override: body.single_override != null ? Math.max(0, Math.round(body.single_override)) : null,
    esv_exempt: body.esv_exempt ?? current.esv_exempt,
  };
  await writeProfile(c.env.DB, next);
  // Rewrite the accruals immediately: changing the group changes what is owed for the OPEN period,
  // and leaving the old figure on screen until something else happened to refresh it would show a
  // liability the user has just told us is not theirs.
  await refreshObligations(c.env.DB, now());
  return c.json(next satisfies TaxProfileDto);
});

/**
 * The income book: one row per business receipt, with the rate that valued it.
 *
 * Defaults to the year to date, which is the period an accountant asks for. §TAX-FX means the rate
 * travels with the row — a base figure whose rate has to be looked up separately cannot be checked.
 */
tax.get("/tax/ledger", async (c) => {
  const url = new URL(c.req.url);
  const t = now();
  const from = numParam(url, "from", localYearStart(t));
  const to = numParam(url, "to", t);
  const rows = await taxRepo.incomeLedger(c.env.DB, from, to, t);
  return c.json({
    from, to, rows,
    total_uah: rows.reduce((n, r) => n + (r.currency_code === 980 ? r.amount : r.tax_base_uah ?? 0), 0),
  } satisfies TaxLedger);
});

/**
 * Freeze the hryvnia base of foreign-currency receipts that do not have one yet.
 *
 * A small batch per call, and the client repeats while `remaining > 0` — the same shape as
 * `enrichPending`. Each row is one outbound request to the NBU, and a year of invoices would
 * otherwise be one handler holding open a connection long enough to be killed halfway, with no
 * record of how far it got.
 */
tax.post("/tax/backfill-rates", async (c) => {
  const rows = await taxRepo.receiptsWithoutBase(c.env.DB, 15);
  let filled = 0;
  for (const r of rows) {
    const base = await taxBaseUah(c.env.DB, r.amount, r.currency_code, r.time);
    // §TAX-FX: a failed fetch leaves the row alone. A guessed rate inside a tax figure is worse
    // than a missing one — the first is wrong and confident, the second is visibly incomplete.
    if (base != null) { await taxRepo.setTaxBase(c.env.DB, r.id, base); filled++; }
  }
  const rest = await taxRepo.receiptsWithoutBase(c.env.DB, 200);
  return c.json({ filled, remaining: rest.length } satisfies TaxBackfillResult);
});

/**
 * §TAX-DUE — the operations that could be the payment of this obligation.
 *
 * A literal segment under a parameterised one, which C7 allows because they do not overlap:
 * `:id/candidates` and `:id/paid` are different endings of the same shape.
 */
tax.get("/tax/obligations/:id/candidates", async (c) => {
  const id = idParam(c);
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  const o = await taxRepo.obligationById(c.env.DB, id);
  if (!o) return c.json({ error: st(c.get("locale"), "errBadId") }, 404);
  return c.json({
    obligation: { id: o.id, kind: o.kind, period: o.period, amount: o.amount, due_date: o.due_date },
    candidates: await taxRepo.paymentCandidates(c.env.DB, o.amount, o.due_date),
  } satisfies TaxPaymentCandidates);
});

/** §TAX-DUE — «paid» is a LINK to the operation that paid it, never a bare checkbox. */
tax.post("/tax/obligations/:id/paid", async (c) => {
  const id = idParam(c);
  // A malformed id used to bind as NULL, update no row, and still answer 200 with a status object
  // in which the obligation was plainly still unpaid — a write that did nothing and said it worked.
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  const body = await c.req.json<{ tx_id?: string | null }>().catch(() => ({ tx_id: null }));
  // The link is a real foreign key, and inside the Durable Object foreign keys are ENFORCED — so
  // an id that names nothing would surface as an uncaught 500 («internal_error, ref …»), which
  // tells the user nothing about the one thing they got wrong. Checked here, named here.
  if (body.tx_id && !(await taxRepo.transactionExists(c.env.DB, body.tx_id))) {
    return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  }
  // A well-formed id for an obligation that does not exist is what a stale client list produces —
  // and the accruals are pruned now, so a row CAN legitimately disappear between two reads.
  if (!(await taxRepo.markPaid(c.env.DB, id, body.tx_id ?? null, body.tx_id ? now() : null))) {
    return c.json({ error: st(c.get("locale"), "errBadId") }, 404);
  }
  return c.json(await taxStatus(c.env.DB, now()) satisfies TaxStatus);
});

/** §TAX-BASE — `null` clears the override and hands the question back to the account. */
tax.post("/tax/transactions/:id/business", async (c) => {
  const body = await c.req.json<{ business: 0 | 1 | null }>();
  // An UPDATE that matched nothing is not an error in SQL, so an unknown id answered `{ok:true}`.
  if (!(await taxRepo.setBusiness(c.env.DB, c.req.param("id"), body.business))) {
    return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  }
  return c.json({ ok: true });
});

tax.post("/tax/accounts/:id/business", async (c) => {
  const body = await c.req.json<{ business: 0 | 1 }>();
  if (!(await taxRepo.setAccountBusiness(c.env.DB, c.req.param("id"), body.business ? 1 : 0))) {
    return c.json({ error: st(c.get("locale"), "errAccountNotFound") }, 404);
  }
  // The account's answer is inherited by every row that never got its own (§TAX-BASE), so the
  // quarter's income can change with this one write — refresh before the client reads it back.
  await refreshObligations(c.env.DB, now());
  return c.json({ ok: true });
});

/** The quarter's own boundaries, for a client that wants to label the period it is showing. */
tax.get("/tax/quarter", async (c) => {
  const t = now();
  return c.json({ from: localQuarterStart(t), to: localQuarterStart(t, 1) });
});


// ─── the business (docs/TAX.md §0.1) ────────────────────────────────────────────────────────────

/**
 * Everything `/fop` shows about the business itself, in ONE request.
 *
 * Deliberately not five endpoints: every figure is over the same population and the same quarter
 * boundaries, and two cards that fetched separately could disagree about one quarter — which is
 * the failure `Stats.tsx` keeps its shared request to avoid.
 */
tax.get("/tax/business", async (c) => {
  const quarters = numParam(new URL(c.req.url), "quarters", 6);
  // Clamped, not rejected: a stale link asking for 400 quarters should show the default, not an
  // error, and each quarter is several aggregate scans (`numParam`, §Обробка помилок).
  const n = Math.min(Math.max(quarters, 1), 12);
  return c.json(await businessOverview(c.env.DB, now(), n, c.get("locale")) satisfies BusinessOverview);
});

// ─── §TAX-WATCH ─────────────────────────────────────────────────────────────────────────────────

tax.get("/tax/watch", async (c) => {
  return c.json({
    sources: await watch.listSources(c.env.DB),
    requisites: await watch.listRequisites(c.env.DB),
  } satisfies RegWatch);
});

/**
 * Check the sources now.
 *
 * The cron does this daily; this is the button for «I heard something changed». It returns per
 * source what happened, INCLUDING the failures — a watch that silently checks nothing is worse
 * than no watch, because it reports «no changes» forever (§TAX-WATCH).
 */
tax.post("/tax/watch/check", async (c) => {
  return c.json({ results: await watch.checkAll(c.env.DB, now()) });
});

tax.post("/tax/watch/sources", async (c) => {
  const body = await c.req.json<{ url?: string; label?: string; topic?: string; region?: string }>();
  const url = (body.url ?? "").trim();
  // This value becomes an outbound request from the worker, so it is the one field here that must
  // not be taken on trust (docs/PERIMETER.md). The predicate lives with the fetch that uses it —
  // `isWatchableUrl` — so the rule cannot be stated twice and drift.
  if (!watch.isWatchableUrl(url)) {
    return c.json({ error: st(c.get("locale"), "errTaxSourceUrl") }, 400);
  }
  await watch.addSource(c.env.DB, { url, label: (body.label ?? url).slice(0, 120), topic: body.topic ?? null, region: body.region ?? null }, now());
  return c.json({ sources: await watch.listSources(c.env.DB), requisites: await watch.listRequisites(c.env.DB) } satisfies RegWatch);
});

tax.post("/tax/watch/sources/:id/unmute", async (c) => {
  const id = idParam(c);
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  await watch.unmuteSource(c.env.DB, id);
  return c.json({ ok: true });
});

tax.delete("/tax/watch/sources/:id", async (c) => {
  const id = idParam(c);
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  await watch.removeSource(c.env.DB, id);
  return c.json({ ok: true });
});

/**
 * Save the user's own requisites.
 *
 * ⚠️ `verified: true` is a HUMAN act — «I have just looked at the source and this is right». It is
 * never set by any code path that fetched something, which is what makes «the page changed after
 * you checked» mean anything at all.
 */
tax.put("/tax/watch/requisites", async (c) => {
  const body = await c.req.json<{
    kind: string; iban?: string | null; recipient?: string | null; edrpou?: string | null;
    purpose?: string | null; source_id?: number | null; verified?: boolean;
  }>();
  if (!["single_tax", "military_levy", "social_contribution"].includes(body.kind)) {
    return c.json({ error: st(c.get("locale"), "errTaxKind") }, 400);
  }
  await watch.upsertRequisite(c.env.DB, { ...body, verified: !!body.verified }, now());
  return c.json({ sources: await watch.listSources(c.env.DB), requisites: await watch.listRequisites(c.env.DB) } satisfies RegWatch);
});

/**
 * §TAX-FX — the income book, as a CSV an accountant can open.
 *
 * Lives here rather than in `export.ts` because that file owns `/export/*` (C7: one file, one
 * prefix) and this is `/tax/*`. The duplication is one dialect helper, and the alternative was to
 * put ФОП logic behind a prefix that knows nothing about it.
 *
 * ⚠️ The RATE travels with the row, in its own two columns. A hryvnia figure whose rate has to be
 * looked up elsewhere is a figure nobody can check — and this is the one export whose numbers a
 * third party (an accountant, an inspector) will be asked to verify.
 *
 * The dialect follows `/export/transactions.csv` for the same reason it does there: an RFC file
 * with a decimal POINT opens as one column on a Ukrainian locale, and the amounts stop summing.
 */
/**
 * §TAX-DUE — the quarter summary, as a CSV. The ledger says what came in; this says what was
 * accrued and what was settled, which is the second thing an accountant asks for.
 *
 * Read from the STORED obligations (`tax-report.ts`), never recomputed: a paid quarter keeps the
 * figure it was paid at, and a summary that cannot be reconciled against what was filed is a
 * second plausible set of numbers rather than a check.
 */
tax.get("/tax/summary.csv", async (c) => {
  const url = new URL(c.req.url);
  const t = now();
  const year = numParam(url, "year", localParts(t).y, { min: 2000, max: 2100 });
  const rows = await quarterSummary(c.env.DB, year);
  const loc = c.get("locale");

  const rfc = url.searchParams.get("dialect") === "rfc";
  const sep = rfc ? "," : ";";
  const num = (n: number) => (rfc ? (n / 100).toFixed(2) : (n / 100).toFixed(2).replace(".", ","));
  const header = [
    st(loc, "csvQuarter"), st(loc, "csvIncome"), st(loc, "csvReceipts"),
    st(loc, "csvSingleTax"), st(loc, "csvLevy"), st(loc, "csvEsv"),
    st(loc, "csvPaid"), st(loc, "csvOutstanding"),
  ];
  const lines = [header.join(sep)];
  for (const r of rows) {
    lines.push([
      r.quarter, num(r.income), String(r.receipts), num(r.single_tax), num(r.military_levy),
      num(r.social_contribution), num(r.paid), num(r.outstanding),
    ].join(sep));
  }
  // Same dialect decision as the ledger: an RFC file with a decimal POINT opens as one column on
  // a Ukrainian locale and the amounts stop summing.
  const csv = "\ufeff" + (rfc ? "" : `sep=${sep}\r\n`) + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="fop-summary-${year}.csv"`,
    },
  });
});

tax.get("/tax/ledger.csv", async (c) => {
  const url = new URL(c.req.url);
  const t = now();
  const from = numParam(url, "from", localYearStart(t));
  const to = numParam(url, "to", t);
  const rows = await taxRepo.incomeLedger(c.env.DB, from, to, t);
  const loc = c.get("locale");

  const rfc = url.searchParams.get("dialect") === "rfc";
  const sep = rfc ? "," : ";";
  const num = (n: number, dp = 2) => (rfc ? n.toFixed(dp) : n.toFixed(dp).replace(".", ","));
  const numeric = rfc ? /^-?\d+(\.\d+)?$/ : /^-?\d+(,\d+)?$/;
  const needsQuote = new RegExp(`["${sep === ";" ? ";" : ","}\\n\\r]`);
  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV formula injection: the merchant column is text a counterparty typed on a transfer, and
    // this file is opened by someone else's accountant. Same defence as `/export/transactions.csv`.
    if (/^[=+\-@\t\r]/.test(s) && !numeric.test(s)) s = `'${s}`;
    return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    st(loc, "csvDate"), st(loc, "csvMerchant"), st(loc, "csvAmount"), st(loc, "csvCurrency"),
    st(loc, "csvTaxRate"), st(loc, "csvTaxRateDate"), st(loc, "csvTaxBase"),
  ];
  const lines = [header.map(esc).join(sep)];
  for (const r of rows) {
    const base = r.currency_code === 980 ? r.amount : r.tax_base_uah;
    lines.push([
      localYmd(r.time),                       // §APP_TZ — the Kyiv date, like every other export
      r.merchant ?? "",
      num(r.amount / 100),
      currencyCode(r.currency_code),
      // Hryvnia rows carry no rate, and printing 1 would state a conversion that never happened.
      r.currency_code === 980 ? "" : r.rate == null ? "" : num(r.rate / RATE_SCALE, 4),
      r.currency_code === 980 ? "" : r.effective_date ?? "",
      // An unresolved base is left BLANK, never zero: a zero would sum into the total and quietly
      // understate declared income, which is the direction with a penalty attached (§TAX-FX).
      base == null ? "" : num(base / 100),
    ].map(esc).join(sep));
  }

  const csv = "﻿" + (rfc ? "" : `sep=${sep}\r\n`) + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="fop-income-${localYmd(from)}-${localYmd(to)}.csv"`,
    },
  });
});
