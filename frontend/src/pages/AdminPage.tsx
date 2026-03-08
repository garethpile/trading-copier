import { ReactNode, useEffect, useState } from "react";
import {
  enableSocketFeature,
  fetchLotSizeConfig,
  fetchTargetAccountsConfig,
  getSocketFeatureStatus,
  testConnectivity,
  updateLotSizeConfig,
  updateTargetAccountsConfig
} from "../services/api";
import {
  ConnectivityTestResponse,
  LotSizeConfig,
  SocketFeatureEnableResponse,
  SocketFeatureStatusResponse,
  TargetAccountsConfig
} from "../types";

function CollapsibleCard({
  title,
  children,
  defaultOpen = false,
  className
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={`card collapsible-card ${className ?? ""}`.trim()} open={defaultOpen}>
      <summary className="collapsible-summary">
        <h2>{title}</h2>
        <span className="collapse-icon" aria-hidden="true" />
      </summary>
      <div className="stack">{children}</div>
    </details>
  );
}

export function AdminPage() {
  const [accountsConfig, setAccountsConfig] = useState<TargetAccountsConfig | null>(null);
  const [accountId, setAccountId] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [status, setStatus] = useState<SocketFeatureStatusResponse | null>(null);
  const [enableResult, setEnableResult] = useState<SocketFeatureEnableResponse | null>(null);
  const [connectivityResult, setConnectivityResult] = useState<ConnectivityTestResponse | null>(null);
  const [error, setError] = useState<string | undefined>();

  const [managementError, setManagementError] = useState<string | undefined>();
  const [managementMessage, setManagementMessage] = useState<string | undefined>();
  const [lotConfig, setLotConfig] = useState<LotSizeConfig | null>(null);
  const [newPair, setNewPair] = useState("");
  const [newPairLotSize, setNewPairLotSize] = useState("0.01");

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
    void fetchLotSizeConfig()
      .then(setLotConfig)
      .catch((e) => setManagementError(String(e)));
  }, []);

  useEffect(() => {
    void fetchTargetAccountsConfig()
      .then((config) => {
        setAccountsConfig(config);
        if (!accountId && config.accounts.length > 0) {
          setAccountId(config.accounts[0]);
        }
      })
      .catch((e) => setManagementError(String(e)));
  }, []);

  useEffect(() => {
    if (!accountId && accountsConfig?.accounts.length) {
      setAccountId(accountsConfig.accounts[0]);
      return;
    }
    void loadStatus();
  }, [accountId]);

  return (
    <div className="stack">
      <div className="admin-grid">
        <CollapsibleCard title="MetaCopier Socket" defaultOpen className="admin-card-half">
        <strong>Target Accounts</strong>
        {accountsConfig ? (
          <>
            {accountsConfig.accounts.map((account) => (
              <div className="row" key={account}>
                <input value={account} readOnly />
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    setAccountsConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            accounts: prev.accounts.filter((a) => a !== account)
                          }
                        : prev
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <input
                placeholder="Account ID"
                value={newAccountId}
                onChange={(e) => setNewAccountId(e.target.value)}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const nextId = newAccountId.trim();
                  if (!nextId) return;
                  setAccountsConfig((prev) =>
                    prev
                      ? {
                          ...prev,
                          accounts: Array.from(new Set([...prev.accounts, nextId]))
                        }
                      : { accounts: [nextId] }
                  );
                  setNewAccountId("");
                }}
              >
                Add Account
              </button>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                if (!accountsConfig) return;
                try {
                  setLoading(true);
                  setManagementError(undefined);
                  setManagementMessage(undefined);
                  const saved = await updateTargetAccountsConfig(accountsConfig);
                  setAccountsConfig(saved);
                  setAccountId((prev) => (saved.accounts.includes(prev) ? prev : saved.accounts[0] ?? ""));
                  setManagementMessage("Target accounts saved");
                } catch (e) {
                  setManagementError(String(e));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
            >
              Save Target Accounts
            </button>
          </>
        ) : (
          <p>Loading target accounts...</p>
        )}

        <label>
          Target Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {(accountsConfig?.accounts ?? []).map((account) => (
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

        {managementMessage ? <p>{managementMessage}</p> : null}
        {managementError ? <p className="error">{managementError}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        </CollapsibleCard>

        <CollapsibleCard title="MetaCopier Connectivity" className="admin-card-half">
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
        </CollapsibleCard>

        <CollapsibleCard title="Management - Lot Sizes" className="admin-card-full">
        {lotConfig ? (
          <>
            <label>
              Default Lot Size (fallback)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={lotConfig.defaultLotSize}
                onChange={(e) =>
                  setLotConfig((prev) =>
                    prev
                      ? {
                          ...prev,
                          defaultLotSize: Number(e.target.value)
                        }
                      : prev
                  )
                }
              />
            </label>
            <div className="stack">
              <strong>Pair Lot Sizes</strong>
              {Object.entries(lotConfig.symbolLotSizes)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([symbol, lot]) => (
                  <div className="row" key={symbol}>
                    <input value={symbol} readOnly />
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={lot}
                      onChange={(e) =>
                        setLotConfig((prev) =>
                          prev
                            ? {
                                ...prev,
                                symbolLotSizes: {
                                  ...prev.symbolLotSizes,
                                  [symbol]: Number(e.target.value)
                                }
                              }
                            : prev
                        )
                      }
                    />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        setLotConfig((prev) => {
                          if (!prev) return prev;
                          const next = { ...prev.symbolLotSizes };
                          delete next[symbol];
                          return {
                            ...prev,
                            symbolLotSizes: next
                          };
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
            </div>
            <div className="row">
              <input
                placeholder="Pair (e.g. GBPUSD)"
                value={newPair}
                onChange={(e) => setNewPair(e.target.value.toUpperCase())}
              />
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={newPairLotSize}
                onChange={(e) => setNewPairLotSize(e.target.value)}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const symbol = newPair.trim().toUpperCase();
                  const lot = Number(newPairLotSize);
                  if (!symbol || !Number.isFinite(lot)) return;
                  setLotConfig((prev) =>
                    prev
                      ? {
                          ...prev,
                          symbolLotSizes: {
                            ...prev.symbolLotSizes,
                            [symbol]: lot
                          }
                        }
                      : prev
                  );
                  setNewPair("");
                }}
              >
                Add Pair
              </button>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!lotConfig) return;
                try {
                  setLoading(true);
                  setManagementError(undefined);
                  setManagementMessage(undefined);
                  const saved = await updateLotSizeConfig(lotConfig);
                  setLotConfig(saved);
                  setManagementMessage("Lot size config saved");
                } catch (e) {
                  setManagementError(String(e));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
            >
              Save Lot Sizes
            </button>
          </>
        ) : (
          <p>Loading lot size config...</p>
        )}
        </CollapsibleCard>
      </div>
    </div>
  );
}
