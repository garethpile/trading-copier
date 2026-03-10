import { ParsedTrade } from "../types";

interface Props {
  trade: ParsedTrade;
  warnings: string[];
  targetAccount: string;
  executionMode: "DEMO" | "LIVE";
  lotSize: number;
  note: string;
}

export function ParsedTradeReview(props: Props) {
  const { trade, warnings, targetAccount, executionMode, lotSize, note } = props;

  return (
    <div className="card stack">
      <h3>Parsed Trade Review</h3>
      <div className="grid two">
        <div>
          <strong>Symbol:</strong> {trade.symbol}
        </div>
        <div>
          <strong>Side:</strong> {trade.side}
        </div>
        <div>
          <strong>Order Type:</strong> {trade.orderType}
        </div>
        <div>
          <strong>Entry (reference):</strong> {trade.entry}
        </div>
        <div>
          <strong>Stop Loss:</strong> {trade.stopLoss}
        </div>
        <div>
          <strong>Take Profits:</strong> {trade.takeProfits.join(", ")}
        </div>
        <div>
          <strong>Comment:</strong> {trade.comment ?? "-"}
        </div>
      </div>

      {warnings.length > 0 ? (
        <div>
          <strong>Warnings</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <strong>Execution mode:</strong>{" "}
        {trade.orderType === "LIMIT"
          ? "Limit order (entry price from signal)"
          : "Market order (current price at execution time)"}
      </div>

      <div className="grid two">
        <div>
          <strong>Execution Mode:</strong> {executionMode}
        </div>
        <div>
          <strong>Target Account:</strong> {targetAccount}
        </div>
        <div>
          <strong>Lot Size:</strong> {lotSize}
        </div>
        <div>
          <strong>Note:</strong> {note || "-"}
        </div>
      </div>
    </div>
  );
}
