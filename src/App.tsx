import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/layout/Layout.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Transactions } from "./pages/Transactions.tsx";
import { TxDetail } from "./pages/TxDetail.tsx";
import { Add } from "./pages/Add.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Stats } from "./pages/Stats.tsx";
import { Merchant } from "./pages/Merchant.tsx";
import { Reports, ReportDetail } from "./pages/Reports.tsx";
import { Advisor } from "./pages/Advisor.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Plan } from "./pages/Plan.tsx";
import { Categories } from "./pages/Categories.tsx";
import { Goals } from "./pages/Goals.tsx";
import { Subscriptions } from "./pages/Subscriptions.tsx";
import { Events } from "./pages/Events.tsx";
import { EventDetail } from "./pages/EventDetail.tsx";
import { Notifications } from "./pages/Notifications.tsx";
import { Setup } from "./pages/Setup.tsx";
import { Login } from "./pages/Login.tsx";
import { Landing } from "./pages/Landing.tsx";
import { useState } from "react";
import { useGetMeQuery } from "./store/api.ts";

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
      { path: "reports/:id", element: <ReportDetail /> },
      { path: "advisor", element: <Advisor /> },
      { path: "chat", element: <Chat /> },
      { path: "add", element: <Add /> },
      { path: "plan", element: <Plan /> },
      { path: "categories", element: <Categories /> },
      { path: "goals", element: <Goals /> },
      { path: "subs", element: <Subscriptions /> },
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
  const { data, isLoading } = useGetMeQuery();
  if (isLoading) return null;
  if (!data?.authenticated) return <LoggedOut />;
  return <RouterProvider router={router} />;
}
