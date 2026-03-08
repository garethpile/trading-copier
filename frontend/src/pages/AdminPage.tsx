import { useEffect, useState } from "react";
import { enableSocketFeature, getSocketFeatureStatus, testConnectivity } from "../services/api";
import { ConnectivityTestResponse, SocketFeatureEnableResponse, SocketFeatureStatusResponse } from "../types";

const configuredAccounts: string[] = (
  import.meta.env.VITE_TARGET_ACCOUNTS ?? "a5231bf5-8713-44b6-846d-4c7f43a5bf30"
)
  .split(",")
  .map((v: string) => v.trim())
  .filter((v: string) => Boolean(v));

export function AdminPage() {
  const [accountId, setAccountId] = useState(configuredAccounts[0] ?? "");
  const [status, setStatus] = useState<SocketFeatureStatusResponse | null>(null);
  const [enableResult, setEnableResult] = useState<SocketFeatureEnableResponse | null>(null);
  const [connectivityResult, setConnectivityResult] = useState<ConnectivityTestResponse | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const isSocketEnabled = status?.status === "ENABLED";
  const statusClass = (value: string) =>
    value === "OK" || value === "SUCCESS" || value === "ENABLED" ? "status-ok" : "status-bad";

  const loadStatus = async () => {
    if (!accountId) return;
    try {
      setLoading(true);
      setError(undefined);
      setStatus(await getSocketFeatureStatus(accountId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [accountId]);

  return (
    <div className="stack">
      <div className="card stack">
        <h2>MetaCopier Connectivity</h2>
        <div className="row">
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={async () => {
              try {
                setLoading(true);
                setError(undefined);
                setConnectivityResult(await testConnectivity());
              } catch (e) {
                setConnectivityResult({
                  status: "FAILED",
                  provider: "MetaCopier",
                  message: "Connectivity test failed",
                  error: String(e)
                });
              } finally {
                setLoading(false);
              }
            }}
          >
            Test Connectivity
          </button>
        </div>
        {connectivityResult ? (
          <div>
            <strong>Status:</strong>{" "}
            <span className={statusClass(connectivityResult.status)}>{connectivityResult.status}</span>
            <br />
            <strong>Provider:</strong> {connectivityResult.provider}
            <br />
            <strong>Message:</strong> {connectivityResult.message}
            {connectivityResult.error ? (
              <>
                <br />
                <strong>Error:</strong> {connectivityResult.error}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card stack">
        <h2>MetaCopier Socket</h2>
        <label>
          Target Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {configuredAccounts.map((account) => (
              <option value={account} key={account}>
                {account}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <button type="button" className="ghost" onClick={() => void loadStatus()} disabled={loading}>
            Refresh Status
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                setLoading(true);
                setError(undefined);
                const result = await enableSocketFeature(accountId);
                setEnableResult(result);
                await loadStatus();
              } catch (e) {
                setError(String(e));
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading || !accountId || isSocketEnabled}
          >
            {isSocketEnabled ? "Socket Already Enabled" : "Enable Socket Feature"}
          </button>
        </div>

        {status ? (
          <div>
            <strong>Socket Status:</strong> <span className={statusClass(status.status)}>{status.status}</span>
            <br />
            <strong>Account ID:</strong> {status.accountId}
          </div>
        ) : null}

        {enableResult ? (
          <div>
            <strong>Enable Result:</strong>{" "}
            <span className={statusClass(enableResult.success ? "SUCCESS" : "FAILED")}>
              {enableResult.success ? "SUCCESS" : "FAILED"}
            </span>
            <br />
            <strong>Message:</strong> {enableResult.message}
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}
