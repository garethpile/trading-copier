import { useEffect, useState } from "react";
import { fetchTradeHistory } from "../services/api";
import { TradeRecord } from "../types";
import { TradeHistoryTable } from "../components/TradeHistoryTable";

export function TradeHistoryPage() {
  const [items, setItems] = useState<TradeRecord[]>([]);
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
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="stack">
      <div className="row">
        <h2>History</h2>
        <button onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <TradeHistoryTable items={items} filter={filter} onFilterChange={setFilter} />
    </div>
  );
}
