import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Layout } from "./components/layout/Layout.tsx";
import { telegramInitData } from "./lib/telegram.ts";
import { lazy, Suspense, useState, type ComponentType } from "react";
import { useGetMeQuery } from "./store/api.ts";
import { useFopVisible } from "./components/fop/gate.ts";


/**
 * Route-level code splitting (2026-09-25). Every page used to be imported eagerly, so the first
 * load — including the landing a logged-out visitor sees — shipped ONE 919 kB chunk (249 kB gzip)
 * holding all 25 pages. Each page is now its own chunk, fetched when its route is first opened;
 * only the layout stays in the entry chunk. The dashboard is lazy TOO, on purpose: it pulls in
 * Recharts (the 399 kB `charts` chunk), and eagerly it made every logged-out visitor of the landing
 * download a charting library they never see. For a returning user the cost is nil — the PWA
 * precache holds every chunk, so the dashboard comes from the service worker, not the network.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyPage<K extends string, P extends Record<string, any> = Record<string, never>>(
  load: () => Promise<Record<K, ComponentType<P>>>, name: K,
) {
  const C = lazy<ComponentType<P>>(() => load().then((m) => ({ default: m[name] as ComponentType<P> })));
  // `fallback={null}`: the layout (nav, header) is already on screen; a spinner for a chunk that
  // usually arrives in tens of milliseconds would flash more than it informs.
  return function Page(props: P) {
    return <Suspense fallback={null}><C {...props} /></Suspense>;
  };
}
const Transactions = lazyPage(() => import("./pages/Transactions.tsx"), "Transactions");
const TxDetail = lazyPage(() => import("./pages/TxDetail.tsx"), "TxDetail");
const Add = lazyPage(() => import("./pages/Add.tsx"), "Add");
const Accounts = lazyPage(() => import("./pages/Accounts.tsx"), "Accounts");
const Stats = lazyPage(() => import("./pages/Stats.tsx"), "Stats");
const Merchant = lazyPage(() => import("./pages/Merchant.tsx"), "Merchant");
const Reports = lazyPage(() => import("./pages/Reports.tsx"), "Reports");
const ReportDetail = lazyPage(() => import("./pages/Reports.tsx"), "ReportDetail");
const Wrapped = lazyPage(() => import("./pages/Wrapped.tsx"), "Wrapped");
const Advisor = lazyPage(() => import("./pages/Advisor.tsx"), "Advisor");
const Chat = lazyPage(() => import("./pages/Chat.tsx"), "Chat");
const Plan = lazyPage(() => import("./pages/Plan.tsx"), "Plan");
const Business = lazyPage(() => import("./pages/Business.tsx"), "Business");
const Category = lazyPage(() => import("./pages/Category.tsx"), "Category");
const Subscription = lazyPage(() => import("./pages/Subscription.tsx"), "Subscription");
const Categories = lazyPage(() => import("./pages/Categories.tsx"), "Categories");
const Goals = lazyPage(() => import("./pages/Goals.tsx"), "Goals");
const Subscriptions = lazyPage(() => import("./pages/Subscriptions.tsx"), "Subscriptions");
const Events = lazyPage(() => import("./pages/Events.tsx"), "Events");
const EventDetail = lazyPage(() => import("./pages/EventDetail.tsx"), "EventDetail");
const Notifications = lazyPage(() => import("./pages/Notifications.tsx"), "Notifications");
const Dashboard = lazyPage(() => import("./pages/Dashboard.tsx"), "Dashboard");
const Setup = lazyPage(() => import("./pages/Setup.tsx"), "Setup");
const Login = lazyPage(() => import("./pages/Login.tsx"), "Login");
const Landing = lazyPage(() => import("./pages/Landing.tsx"), "Landing");
const TelegramLogin = lazyPage(() => import("./pages/TelegramLogin.tsx"), "TelegramLogin");

/** §FOP-GATE — the route half of the gate; `useFopVisible` is its single source of truth. */
function BusinessRoute() {
  const visible = useFopVisible();
  const { data: me } = useGetMeQuery();
  // Waits for `/me` before deciding: redirecting on a not-yet-loaded session would bounce the
  // owner off his own page on every cold load.
  if (!me) return null;
  return visible ? <Business /> : <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "tx", element: <Transactions /> },
      { path: "tx/:id", element: <TxDetail /> },
      { path: "accounts", element: <Accounts /> },
      { path: "stats", element: <Stats /> },
      { path: "merchant/:name", element: <Merchant /> },
      { path: "reports", element: <Reports /> },
      // The year in one screen — read-only, assembled from endpoints that already existed.
      { path: "wrapped", element: <Wrapped /> },
      { path: "reports/:id", element: <ReportDetail /> },
      { path: "advisor", element: <Advisor /> },
      { path: "chat", element: <Chat /> },
      { path: "add", element: <Add /> },
      { path: "plan", element: <Plan /> },
      // §0.1 — the business is its own organism, so it is its own page, not a card on /plan.
      // §FOP-GATE — and while the module is unfinished, only the owner has that page: a typed or
      // bookmarked path lands on the dashboard rather than on a screen whose every request 404s.
      { path: "business", element: <BusinessRoute /> },
      // §BIZ-SPLIT — the page was `/fop` until 2026-09-21, when the business became the page and
      // the tax became a feature inside it. Kept as a redirect rather than deleted: the owner's
      // own setup notes link to it, and a dead bookmark on the one page he was asked to check is
      // a bug report about the wrong thing.
      { path: "fop", element: <Navigate to="/business" replace /> },
      { path: "categories", element: <Categories /> },
      // §CATEGORY-PAGE — the permalink. Below the list route, and a distinct path, so neither
      // shadows the other however the router is reordered later.
      { path: "categories/:id", element: <Category /> },
      { path: "goals", element: <Goals /> },
      { path: "subs", element: <Subscriptions /> },
      // §SUB-PAGE — one subscription, the permalink. Same shape as `categories/:id`: below the
      // list route and a distinct path, so neither can shadow the other.
      { path: "subs/:id", element: <Subscription /> },
      { path: "events", element: <Events /> },
      { path: "events/:id", element: <EventDetail /> },
      { path: "notifications", element: <Notifications /> },
      { path: "setup", element: <Setup /> },
    ],
  },
]);

// Logged-out gate (P5.2): a marketing landing by default, the login form on request. An OAuth
// callback returning `?error=` jumps straight to Login so the reason is visible, not the landing.
function LoggedOut() {
  const [showLogin, setShowLogin] = useState(
    () => new URLSearchParams(window.location.search).has("error"),
  );
  function back() {
    // Strip ?error= on the way out, or a reload would bounce straight back into the form
    // (showLogin seeds itself from that param) and "back" would look like it did nothing.
    window.history.replaceState(null, "", window.location.pathname);
    setShowLogin(false);
  }
  // Login is now reached only by an OAuth callback that came back with `?error=` — the landing's
  // sign-in button goes straight to Google. So this is an error surface, not a step in the flow.
  return showLogin ? <Login onBack={back} /> : <Landing />;
}

export function App() {
  const { data, isLoading, refetch } = useGetMeQuery();
  if (isLoading) return null;
  if (!data?.authenticated) {
    // Inside Telegram the landing page is a dead end: its sign-in button goes to Google, and
    // Google cannot complete in a webview (`lib/telegram.ts`). So the Mini App gets its own gate,
    // which signs in from the launch payload and, failing that, says what to do about it.
    return telegramInitData() ? <TelegramLogin onSignedIn={refetch} /> : <LoggedOut />;
  }
  return <RouterProvider router={router} />;
}
