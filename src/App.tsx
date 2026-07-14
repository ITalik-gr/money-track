import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
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
import { Setup } from "./pages/Setup.tsx";
import { Login } from "./pages/Login.tsx";
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
      { path: "setup", element: <Setup /> },
    ],
  },
]);

export function App() {
  const { data, isLoading } = useGetMeQuery();
  if (isLoading) return null;
  if (!data?.authenticated) return <Login />;
  return <RouterProvider router={router} />;
}
