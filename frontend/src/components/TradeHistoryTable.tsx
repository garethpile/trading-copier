import { TradeRecord } from "../types";

type LegView = {
  leg: number;
  takeProfit: number;
  status: "EXECUTED" | "FAILED" | "UNKNOWN";
  runtimeState: "OPEN" | "CLOSED" | "UNKNOWN";
  executionId?: string;
  message?: string;
};

type FilterMode = "ACTIVE" | "CLOSED";

const toObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const toLegs = (providerResponse: unknown): LegView[] => {
  const obj = toObject(providerResponse);
  const legs = obj?.legs;
  if (!Array.isArray(legs)) return [];

  return legs.map((raw, idx) => {
    const item = toObject(raw) ?? {};
    const statusRaw = String(item.status ?? "UNKNOWN").toUpperCase();
    const status: LegView["status"] =
      statusRaw === "EXECUTED" || statusRaw === "FAILED" ? (statusRaw as LegView["status"]) : "UNKNOWN";

    return {
      leg: Number(item.leg ?? idx + 1),
      takeProfit: Number(item.takeProfit ?? 0),
      status,
      runtimeState:
        String(item.runtimeState ?? "UNKNOWN").toUpperCase() === "OPEN"
          ? "OPEN"
          : String(item.runtimeState ?? "UNKNOWN").toUpperCase() === "CLOSED"
            ? "CLOSED"
            : "UNKNOWN",
      executionId: typeof item.executionId === "string" ? item.executionId : undefined,
      message: typeof item.message === "string" ? item.message : undefined
    };
  });
};

const isClosedRequest = (item: TradeRecord): boolean => {
  const status = item.status.toUpperCase();
  if (status === "FAILED" || status === "REJECTED") return true;
  const legs = toLegs(item.providerResponse);
  if (legs.length === 0) return false;
  const activeLegExists = legs.some((leg) => leg.runtimeState !== "CLOSED" && leg.status === "EXECUTED");
  return !activeLegExists;
};

const requestPill = (item: TradeRecord): { label: string; className: string } => {
  if (isClosedRequest(item)) return { label: "CLOSED", className: "pill" };
  const status = item.status.toUpperCase();
  if (status === "EXECUTING") return { label: "IN FLIGHT", className: "pill warn" };
  if (status === "EXECUTED") return { label: "LIVE", className: "pill ok" };
  if (status === "FAILED") return { label: "FAILED", className: "pill bad" };
  if (status === "REJECTED") return { label: "REJECTED", className: "pill bad" };
  return { label: status, className: "pill" };
};

const legPillClass = (leg: LegView): string => {
  if (leg.status === "FAILED") return "pill bad";
  if (leg.runtimeState === "OPEN") return "pill ok";
  if (leg.runtimeState === "CLOSED") return "pill";
  return "pill";
};

const filterLegsByMode = (legs: LegView[], filter: FilterMode): LegView[] => {
  if (filter === "ACTIVE") {
    return legs.filter((leg) => !(leg.runtimeState === "CLOSED" || leg.status === "FAILED"));
  }
  return legs.filter((leg) => leg.runtimeState === "CLOSED" || leg.status === "FAILED");
};

export function TradeHistoryTable({
  items,
  filter,
  onFilterChange
}: {
  items: TradeRecord[];
  filter: FilterMode;
  onFilterChange: (mode: FilterMode) => void;
}) {
  const filtered = items.filter((item) => (filter === "ACTIVE" ? !isClosedRequest(item) : isClosedRequest(item)));

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row spread">
          <h3>Trade Requests</h3>
          <div className="pill-group" role="tablist" aria-label="Trade request filter">
            <button
              type="button"
              className={filter === "ACTIVE" ? "pill-btn active" : "pill-btn"}
              onClick={() => onFilterChange("ACTIVE")}
            >
              Active
            </button>
            <button
              type="button"
              className={filter === "CLOSED" ? "pill-btn active" : "pill-btn"}
              onClick={() => onFilterChange("CLOSED")}
            >
              Closed
            </button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <p>No {filter.toLowerCase()} trade requests.</p>
        </div>
      ) : null}

      {filtered.map((item) => {
        const allLegs = toLegs(item.providerResponse);
        const legs = filterLegsByMode(allLegs, filter);
        const state = requestPill(item);
        const sideClass = item.side === "BUY" ? "side-buy" : "side-sell";
        const requestSideClass = item.side === "BUY" ? "request-buy" : "request-sell";

        return (
          <article className={`card stack request-card ${requestSideClass}`} key={item.signalId}>
            <div className="row spread">
              <div>
                <h4 className="request-title">
                  {item.symbol} <span className={sideClass}>{item.side}</span>
                </h4>
                <div className="request-meta">{new Date(item.createdAt).toLocaleString()}</div>
              </div>
              <span className={state.className}>{state.label}</span>
            </div>

            <div className="grid two request-grid">
              <div>
                <strong>Signal ID:</strong> {item.signalId}
              </div>
              <div>
                <strong>Account:</strong> {item.targetAccount}
              </div>
              <div>
                <strong>Entry (ref):</strong> {item.entry}
              </div>
              <div>
                <strong>Stop Loss:</strong> {item.stopLoss}
              </div>
              <div>
                <strong>Lot Size:</strong> {item.lotSize}
              </div>
              <div>
                <strong>Execution IDs:</strong> {item.executionId ?? "-"}
              </div>
            </div>

            <div className="stack">
              <strong>{filter === "ACTIVE" ? "Open Legs (Grouped per Request)" : "Closed Legs (Grouped per Request)"}</strong>
              {legs.length === 0 ? (
                <div className="leg-row">
                  <span className="pill">N/A</span>
                  <span>{filter === "ACTIVE" ? "No open legs." : "No closed legs."}</span>
                </div>
              ) : (
                legs.map((leg) => (
                  <div className="leg-row" key={`${item.signalId}-leg-${leg.leg}`}>
                    <span className={legPillClass(leg)}>TP{leg.leg}</span>
                    <span>TP: {leg.takeProfit}</span>
                    <span>
                      State: {leg.runtimeState} ({leg.status})
                    </span>
                    <span>Execution: {leg.executionId ?? "-"}</span>
                  </div>
                ))
              )}
            </div>

            {item.errorMessage ? <p className="error">{item.errorMessage}</p> : null}
          </article>
        );
      })}
    </div>
  );
}
