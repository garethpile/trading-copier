import { ParsedTrade } from "../types";

interface Props {
  trade: ParsedTrade;
  warnings: string[];
  targetAccount: string;
  lotSize: number;
  note: string;
  accounts: string[];
  onTargetAccountChange: (value: string) => void;
  onLotSizeChange: (value: number) => void;
  onNoteChange: (value: string) => void;
  onExecute: () => Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
}

export function ParsedTradeReview(props: Props) {
  const {
    trade,
    warnings,
    targetAccount,
    lotSize,
    note,
    accounts,
    onTargetAccountChange,
    onLotSizeChange,
    onNoteChange,
    onExecute,
    onCancel,
    disabled
  } = props;

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
        <strong>Execution mode:</strong> Market order (current price at execution time)
      </div>

      <label>
        Target Account
        <select value={targetAccount} onChange={(e) => onTargetAccountChange(e.target.value)}>
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account}
            </option>
          ))}
        </select>
      </label>

      <label>
        Lot Size
        <input
          type="number"
          step="0.01"
          value={lotSize}
          onChange={(e) => onLotSizeChange(Number(e.target.value))}
          min={0.01}
        />
      </label>

      <label>
        Note
        <input value={note} onChange={(e) => onNoteChange(e.target.value)} placeholder="Optional note" />
      </label>

      <div className="row">
        <button onClick={onExecute} disabled={disabled}>
          Approve & Execute
        </button>
        <button onClick={onCancel} className="ghost" type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
