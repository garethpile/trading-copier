import { useEffect, useState } from "react";
import { LoginForm } from "./components/LoginForm";
import { isAuthenticated, login, logout } from "./services/auth";
import { SignalIntakePage } from "./pages/SignalIntakePage";
import { TradeHistoryPage } from "./pages/TradeHistoryPage";

type View = "intake" | "history";

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>();
  const [view, setView] = useState<View>("intake");

  useEffect(() => {
    void isAuthenticated().then(setAuthed).catch(() => setAuthed(false));
  }, []);

  if (!authed) {
    return (
      <main className="container">
        <h1>Trading Copier</h1>
        <LoginForm
          onSubmit={async (username, password) => {
            setAuthError(undefined);
            try {
              await login(username, password);
              setAuthed(true);
            } catch (error) {
              setAuthError(String(error));
            }
          }}
          error={authError}
        />
      </main>
    );
  }

  return (
    <main className="container stack">
      <header className="row spread">
        <h1>Trading Copier</h1>
        <div className="row">
          <button onClick={() => setView("intake")} className={view === "intake" ? "active" : "ghost"}>
            Signal Intake
          </button>
          <button onClick={() => setView("history")} className={view === "history" ? "active" : "ghost"}>
            Trade History
          </button>
          <button
            className="ghost"
            onClick={() => {
              void logout();
              setAuthed(false);
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {view === "intake" ? <SignalIntakePage /> : <TradeHistoryPage />}
    </main>
  );
}
