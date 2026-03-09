import { ExecuteTradeResponse } from "../types";

export function ExecutionResultPanel({ result }: { result: ExecuteTradeResponse }) {
  return (
    <div className="card stack">
      <h3>Execution Result</h3>
      <div>
        <strong>Status:</strong> {result.status}
      </div>
      <div>
        <strong>Signal ID:</strong> {result.signalId ?? "-"}
      </div>
      <div>
        <strong>Execution ID:</strong> {result.executionId ?? "-"}
      </div>
      <div>
        <strong>Provider:</strong> {result.provider ?? "-"}
      </div>
      <div>
        <strong>Message:</strong> {result.message}
      </div>
      {result.errors?.length ? (
        <div>
          <strong>Leg Errors:</strong>
          <ul>
            {result.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
