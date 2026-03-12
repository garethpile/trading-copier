import { useEffect, useState } from "react";
import { fetchTargetAccountsConfig, fetchTradeHistory } from "../services/api";
import { TargetAccountsConfig, TradeRecord } from "../types";
import { TradeHistoryTable } from "../components/TradeHistoryTable";

export function TradeHistoryPage() {
  const [items, setItems] = useState<TradeRecord[]>([]);
  const [accountsConfig, setAccountsConfig] = useState<TargetAccountsConfig | null>(null);
  const [accountFilter, setAccountFilter] = useState<"DEMO" | "LIVE" | "ALL">("ALL");
  const [filter, setFilter] = useState<"ACTIVE" | "CLOSED">("ACTIVE");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError(undefined);
      setItems(await fetchTradeHistory());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void fetchTargetAccountsConfig()
      .then((config) => {
        setAccountsConfig(config);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  const configuredAccounts = accountsConfig?.accounts ?? [];
  const modeAccounts = accountsConfig?.modeAccounts ?? {};
  const demoAccount = modeAccounts.DEMO ?? configuredAccounts[0] ?? "";
  const liveAccount = modeAccounts.LIVE ?? configuredAccounts[1] ?? configuredAccounts[0] ?? "";
  const selectedAccount = accountFilter === "LIVE" ? liveAccount : accountFilter === "DEMO" ? demoAccount : "";
  const scopedItems = selectedAccount ? items.filter((item) => item.targetAccount === selectedAccount) : items;
  const accountModeByAccount: Record<string, string> = {};
  if (demoAccount) accountModeByAccount[demoAccount] = "DEMO";
  if (liveAccount) {
    accountModeByAccount[liveAccount] =
      demoAccount && liveAccount === demoAccount ? "DEMO/LIVE" : "LIVE";
  }

  return (
    <div className="stack">
      {error ? <p className="error">{error}</p> : null}
      <div className="row spread">
        <h2>History</h2>
        <div className="row">
          <button onClick={load} disabled={loading}>
            Refresh
          </button>
          <div className="pill-group" role="tablist" aria-label="Account filter">
            <button
              type="button"
              className={accountFilter === "LIVE" ? "pill-btn active" : "pill-btn"}
              onClick={() => setAccountFilter("LIVE")}
            >
              Live
            </button>
            <button
              type="button"
              className={accountFilter === "DEMO" ? "pill-btn active" : "pill-btn"}
              onClick={() => setAccountFilter("DEMO")}
            >
              Demo
            </button>
            <button
              type="button"
              className={accountFilter === "ALL" ? "pill-btn active" : "pill-btn"}
              onClick={() => setAccountFilter("ALL")}
            >
              All
            </button>
          </div>
        </div>
      </div>
      <TradeHistoryTable
        items={scopedItems}
        filter={filter}
        onFilterChange={setFilter}
        accountModeByAccount={accountModeByAccount}
      />
    </div>
  );
}
