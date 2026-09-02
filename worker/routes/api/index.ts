// Core REST API for the dashboard. All money is minor units; the client divides by 100.
//
// This file owns the request-wide middleware and MOUNTS the domain modules; every handler lives
// in a sibling file. It deliberately declares no route of its own — `api.ts` used to be the place
// a handler landed when nobody decided where it belonged, and a file that still accepted one
// would collect the next one too.
//
// **Mount order.** Hono matches in registration order, and the literal-before-parameterised rule
// (`/transactions/frequent` above `/transactions/:id`) was bought with a real outage. Modules are
// grouped by FIRST PATH SEGMENT, so one file owns a whole prefix and no two modules can compete
// for a path — which is what makes that rule checkable by reading a single file rather than by
// reasoning about the order below.
import { apiRoutes } from "./_shared.ts";
import { resolveLocale } from "../../lib/platform/i18n.ts";
// `catNameSql` is deliberately absent here and everywhere under `routes/`: it produces SQL, and
// the route layer no longer writes any.

import { accounts } from "./accounts.ts";
import { advisor } from "./advisor.ts";
import { rules } from "./rules.ts";
import { aiChanges } from "./ai-changes.ts";
import { analytics } from "./analytics.ts";
import { budgets } from "./budgets.ts";
import { categories } from "./categories.ts";
import { chats } from "./chats.ts";
import { dataExport } from "./export.ts";
import { events } from "./events.ts";
import { feedback } from "./feedback.ts";
import { goals } from "./goals.ts";
import { insights } from "./insights.ts";
import { jobs } from "./jobs.ts";
import { knowledge } from "./knowledge.ts";
import { notifications } from "./notifications.ts";
import { planned } from "./planned.ts";
import { push } from "./push.ts";
import { reports } from "./reports.ts";
import { settings } from "./settings.ts";
import { transactions } from "./transactions.ts";
import { transfers } from "./transfers.ts";

export const api = apiRoutes();

// Resolve the owner's UI locale once per request (P3.4). Category display names are stored in
// Ukrainian; when the owner runs the app in English they are translated SERVER-SIDE via
// `catNameSql`/`localizeCatName`, so the client stays unchanged. `uk` sessions pay nothing —
// `catNameSql` is a no-op for them.
//
// It sits ABOVE the mounts on purpose: parent middleware runs for mounted sub-apps too, so this
// is the single place the lookup happens for all of them.
api.use("*", async (c, next) => {
  // The reader's own language first (`x-mt-locale`, threaded in by `UserDO.appEnv`), the stored
  // preference second. `ownerLocale` alone answered "uk" for everyone who never opened Settings —
  // including every demo visitor, whose whole screen is English.
  c.set("locale", await resolveLocale(c.env));
  await next();
});

// ---- domain modules ---------------------------------------------------------

api.route("/", accounts);
api.route("/", insights);
api.route("/", advisor);
api.route("/", rules);
api.route("/", aiChanges);
api.route("/", analytics);
api.route("/", budgets);
api.route("/", categories);
api.route("/", chats);
api.route("/", dataExport);
api.route("/", events);
api.route("/", feedback);
api.route("/", goals);
api.route("/", jobs);
api.route("/", knowledge);
api.route("/", notifications);
api.route("/", planned);
api.route("/", push);
api.route("/", reports);
api.route("/", settings);
api.route("/", transactions);
api.route("/", transfers);
