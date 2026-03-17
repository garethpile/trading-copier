import { useEffect, useState } from "react";
import { LoginForm } from "./components/LoginForm";
import { isAuthenticated, logout } from "./services/auth";
import { SignalIntakePage } from "./pages/SignalIntakePage";
import { TradeHistoryPage } from "./pages/TradeHistoryPage";
import { AdminPage } from "./pages/AdminPage";
import { SecuritySettings } from "./components/SecuritySettings";

type View = "intake" | "history" | "admin" | "security";

const pageTitle: Record<View, string> = {
  intake: "Signal Intake",
  history: "Trade History",
  admin: "Admin",
  security: "Security"
};

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [view, setView] = useState<View>("intake");
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    void isAuthenticated().then(setAuthed).catch(() => setAuthed(false));
  }, []);

  if (!authed) {
    return (
      <main className="container">
        <h1>Trading Copier</h1>
        <LoginForm onAuthenticated={() => setAuthed(true)} />
      </main>
    );
  }

  return (
    <main className="container stack">
      <header className="row spread">
        <div className="row app-header-title">
          <h1>Trading Copier</h1>
          <span className="screen-heading">{pageTitle[view]}</span>
        </div>
        <div className="row">
          <button onClick={() => setView("intake")} className={view === "intake" ? "active" : "ghost"}>
            Signal Intake
          </button>
          <button onClick={() => setView("history")} className={view === "history" ? "active" : "ghost"}>
            Trade History
          </button>
          <div className="profile-menu">
            <button
              type="button"
              className="ghost profile-icon"
              onClick={() => setProfileOpen((prev) => !prev)}
              aria-label="Profile menu"
            >
              <span>👤</span>
            </button>
            {profileOpen ? (
              <div className="profile-dropdown card stack">
                <button
                  type="button"
                  className={view === "admin" ? "active" : "ghost"}
                  onClick={() => {
                    setView("admin");
                    setProfileOpen(false);
                  }}
                >
                  Admin
                </button>
                <button
                  type="button"
                  className={view === "security" ? "active" : "ghost"}
                  onClick={() => {
                    setView("security");
                    setProfileOpen(false);
                  }}
                >
                  Security
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    void logout();
                    setAuthed(false);
                  }}
                >
                  Sign Out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {view === "intake" ? <SignalIntakePage /> : null}
      {view === "history" ? <TradeHistoryPage /> : null}
      {view === "admin" ? <AdminPage /> : null}
      {view === "security" ? <SecuritySettings /> : null}
    </main>
  );
}
