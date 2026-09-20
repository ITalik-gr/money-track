import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Layout } from "./components/layout/Layout.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Transactions } from "./pages/Transactions.tsx";
import { TxDetail } from "./pages/TxDetail.tsx";
import { Add } from "./pages/Add.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Stats } from "./pages/Stats.tsx";
import { Merchant } from "./pages/Merchant.tsx";
import { Reports, ReportDetail } from "./pages/Reports.tsx";
import { Wrapped } from "./pages/Wrapped.tsx";
import { Advisor } from "./pages/Advisor.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Plan } from "./pages/Plan.tsx";
import { Business } from "./pages/Business.tsx";
import { Category } from "./pages/Category.tsx";
import { Subscription } from "./pages/Subscription.tsx";
import { Categories } from "./pages/Categories.tsx";
import { Goals } from "./pages/Goals.tsx";
import { Subscriptions } from "./pages/Subscriptions.tsx";
import { Events } from "./pages/Events.tsx";
import { EventDetail } from "./pages/EventDetail.tsx";
import { Notifications } from "./pages/Notifications.tsx";
import { Setup } from "./pages/Setup.tsx";
import { Login } from "./pages/Login.tsx";
import { Landing } from "./pages/Landing.tsx";
import { TelegramLogin } from "./pages/TelegramLogin.tsx";
import { telegramInitData } from "./lib/telegram.ts";
import { useState } from "react";
import { useGetMeQuery } from "./store/api.ts";
import { useFopVisible } from "./components/fop/gate.ts";

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
