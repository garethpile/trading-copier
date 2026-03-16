import { ReactNode, useEffect, useMemo, useState } from "react";
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
  SymbolConfig,
  SocketFeatureStatusResponse,
  TargetAccountsConfig
} from "../types";

const sortSymbolConfigs = (input: Record<string, SymbolConfig>): Record<string, SymbolConfig> =>
  Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));

const resolveAccountMapping = (symbolConfig: SymbolConfig, accountId: string, sourceSymbol: string): string =>
  symbolConfig.accountDestinationSymbols?.[accountId] ?? symbolConfig.destinationBrokerSymbol ?? sourceSymbol;

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
  const [lotConfig, setLotConfig] = useState<LotSizeConfig | null>(null);
  const [newAccountId, setNewAccountId] = useState("");
  const [newPair, setNewPair] = useState("");
  const [newPairLotSize, setNewPairLotSize] = useState("0.01");

  const [socketStatusByAccount, setSocketStatusByAccount] = useState<Record<string, SocketFeatureStatusResponse>>({});
  const [socketErrorByAccount, setSocketErrorByAccount] = useState<Record<string, string>>({});
  const [socketActionMessageByAccount, setSocketActionMessageByAccount] = useState<Record<string, string>>({});

  const [connectivityResult, setConnectivityResult] = useState<ConnectivityTestResponse | null>(null);
  const [connectivityLoading, setConnectivityLoading] = useState(false);
  const [managementError, setManagementError] = useState<string | undefined>();
  const [managementMessage, setManagementMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const executionMode = accountsConfig?.executionMode ?? "DEMO";
  const statusClass = (value: string) =>
    value === "OK" || value === "SUCCESS" || value === "ENABLED" ? "status-ok" : "status-bad";

  const runConnectivityTest = async () => {
    try {
      setConnectivityLoading(true);
      setManagementError(undefined);
      setConnectivityResult(await testConnectivity());
    } catch (error) {
      setConnectivityResult({
        status: "FAILED",
        provider: "MetaCopier",
        message: "Connectivity test failed",
        error: String(error)
      });
    } finally {
      setConnectivityLoading(false);
    }
  };

  const accountRoles = useMemo(() => {
    const roles: Record<string, string[]> = {};
    const demo = accountsConfig?.modeAccounts?.DEMO;
    const live = accountsConfig?.modeAccounts?.LIVE;
    for (const accountId of accountsConfig?.accounts ?? []) {
      const next: string[] = [];
      if (accountId === demo) next.push("DEMO");
      if (accountId === live) next.push("LIVE");
      roles[accountId] = next;
    }
    return roles;
  }, [accountsConfig]);

  const refreshSocketStatus = async (accountId: string) => {
    if (!accountId) return;
    try {
      const status = await getSocketFeatureStatus(accountId);
      setSocketStatusByAccount((prev) => ({ ...prev, [accountId]: status }));
      setSocketErrorByAccount((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
    } catch (error) {
      setSocketErrorByAccount((prev) => ({ ...prev, [accountId]: String(error) }));
    }
  };

  const saveLotConfig = async (message = "Lot sizes saved") => {
    if (!lotConfig) return;
    try {
      setLoading(true);
      setManagementError(undefined);
      setManagementMessage(undefined);
      const saved = await updateLotSizeConfig({
        ...lotConfig,
        symbols: sortSymbolConfigs(lotConfig.symbols)
      });
      setLotConfig({
        ...saved,
        symbols: sortSymbolConfigs(saved.symbols)
      });
      setManagementMessage(message);
    } catch (error) {
      setManagementError(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLotSizeConfig()
      .then((config) =>
        setLotConfig({
          ...config,
          symbols: sortSymbolConfigs(config.symbols)
        })
      )
      .catch((error) => setManagementError(String(error)));
  }, []);

  useEffect(() => {
    void fetchTargetAccountsConfig()
      .then((config) => {
        setAccountsConfig(config);
        void Promise.all(config.accounts.map((accountId) => refreshSocketStatus(accountId)));
      })
      .catch((error) => setManagementError(String(error)));
  }, []);

  useEffect(() => {
    void runConnectivityTest();
  }, []);

  return (
    <div className="stack">
      <div className="admin-grid">
        <CollapsibleCard title="MetaCopier Connectivity" defaultOpen className="admin-card-full">
          <div className="row">
            <button
              type="button"
              className="ghost"
              disabled={connectivityLoading}
              onClick={() => void runConnectivityTest()}
            >
              {connectivityLoading ? "Testing..." : "Test Connectivity"}
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

        <CollapsibleCard title="Execution Routing" defaultOpen className="admin-card-full">
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
                      setAccountsConfig((prev) => {
                        if (!prev) return prev;
                        const nextAccounts = prev.accounts.filter((a) => a !== account);
                        if (nextAccounts.length === 0) return prev;
                        return {
                          ...prev,
                          accounts: nextAccounts,
                          modeAccounts: {
                            DEMO:
                              prev.modeAccounts?.DEMO === account
                                ? nextAccounts[0]
                                : prev.modeAccounts?.DEMO ?? nextAccounts[0],
                            LIVE:
                              prev.modeAccounts?.LIVE === account
                                ? nextAccounts[1] ?? nextAccounts[0]
                                : prev.modeAccounts?.LIVE ?? nextAccounts[1] ?? nextAccounts[0]
                          }
                        };
                      })
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
                    setAccountsConfig((prev) => {
                      if (!prev) {
                        return {
                          accounts: [nextId],
                          executionMode: "DEMO",
                          modeAccounts: { DEMO: nextId, LIVE: nextId }
                        };
                      }
                      const nextAccounts = Array.from(new Set([...prev.accounts, nextId]));
                      return {
                        ...prev,
                        accounts: nextAccounts,
                        modeAccounts: {
                          DEMO: prev.modeAccounts?.DEMO ?? nextAccounts[0],
                          LIVE: prev.modeAccounts?.LIVE ?? nextAccounts[1] ?? nextAccounts[0]
                        }
                      };
                    });
                    setNewAccountId("");
                  }}
                >
                  Add Account
                </button>
              </div>

              <div className="row">
                <label style={{ flex: 1 }}>
                  Demo Account
                  <select
                    value={accountsConfig.modeAccounts?.DEMO ?? accountsConfig.accounts[0] ?? ""}
                    onChange={(e) =>
                      setAccountsConfig((prev) =>
                        prev
                          ? {
                              ...prev,
                              modeAccounts: {
                                ...prev.modeAccounts,
                                DEMO: e.target.value
                              }
                            }
                          : prev
                      )
                    }
                  >
                    {accountsConfig.accounts.map((account) => (
                      <option key={`demo-${account}`} value={account}>
                        {account}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ flex: 1 }}>
                  Live Account
                  <select
                    value={accountsConfig.modeAccounts?.LIVE ?? accountsConfig.accounts[1] ?? accountsConfig.accounts[0] ?? ""}
                    onChange={(e) =>
                      setAccountsConfig((prev) =>
                        prev
                          ? {
                              ...prev,
                              modeAccounts: {
                                ...prev.modeAccounts,
                                LIVE: e.target.value
                              }
                            }
                          : prev
                      )
                    }
                  >
                    {accountsConfig.accounts.map((account) => (
                      <option key={`live-${account}`} value={account}>
                        {account}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                Telegram/Web Execution Mode
                <select
                  value={executionMode}
                  onChange={(e) =>
                    setAccountsConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            executionMode: e.target.value === "LIVE" ? "LIVE" : "DEMO"
                          }
                        : prev
                    )
                  }
                >
                  <option value="DEMO">DEMO</option>
                  <option value="LIVE">LIVE</option>
                </select>
              </label>

              <button
                type="button"
                className="ghost"
                disabled={loading}
                onClick={async () => {
                  if (!accountsConfig) return;
                  try {
                    setLoading(true);
                    setManagementError(undefined);
                    setManagementMessage(undefined);
                    const saved = await updateTargetAccountsConfig(accountsConfig);
                    setAccountsConfig(saved);
                    setManagementMessage(`Target accounts saved. Mode: ${saved.executionMode ?? "DEMO"}`);
                    await Promise.all(saved.accounts.map((accountId) => refreshSocketStatus(accountId)));
                  } catch (error) {
                    setManagementError(String(error));
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                Save Target Accounts
              </button>
            </>
          ) : (
            <p>Loading target accounts...</p>
          )}
        </CollapsibleCard>

        {(accountsConfig?.accounts ?? []).map((accountId) => {
          const status = socketStatusByAccount[accountId];
          const roles = accountRoles[accountId] ?? [];
          const isSocketEnabled = status?.status === "ENABLED";

          return (
            <CollapsibleCard
              key={accountId}
              title={`Account Details${roles.length > 0 ? ` (${roles.join("/")})` : ""}`}
              defaultOpen
              className="admin-card-half"
            >
              <div>
                <strong>Account ID:</strong> {accountId}
              </div>

              <div className="row">
                <button type="button" className="ghost" disabled={loading} onClick={() => void refreshSocketStatus(accountId)}>
                  Refresh Socket Status
                </button>
                <button
                  type="button"
                  disabled={loading || isSocketEnabled}
                  onClick={async () => {
                    try {
                      setLoading(true);
                      setSocketErrorByAccount((prev) => {
                        const next = { ...prev };
                        delete next[accountId];
                        return next;
                      });
                      const result = await enableSocketFeature(accountId);
                      setSocketActionMessageByAccount((prev) => ({ ...prev, [accountId]: result.message }));
                      await refreshSocketStatus(accountId);
                    } catch (error) {
                      setSocketErrorByAccount((prev) => ({ ...prev, [accountId]: String(error) }));
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  {isSocketEnabled ? "Socket Already Enabled" : "Enable Socket Feature"}
                </button>
              </div>

              {status ? (
                <div>
                  <strong>Socket Status:</strong> <span className={statusClass(status.status)}>{status.status}</span>
                </div>
              ) : null}
              {socketActionMessageByAccount[accountId] ? <p>{socketActionMessageByAccount[accountId]}</p> : null}
              {socketErrorByAccount[accountId] ? <p className="error">{socketErrorByAccount[accountId]}</p> : null}

              <strong>Symbol Mapping (for this account)</strong>
              {lotConfig ? (
                <>
                  {Object.entries(lotConfig.symbols)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([symbol, symbolConfig]) => (
                      <div className="row" key={`${accountId}-${symbol}`}>
                        <input value={symbol} readOnly />
                        <input
                          value={resolveAccountMapping(symbolConfig, accountId, symbol)}
                          onChange={(e) =>
                            setLotConfig((prev) => {
                              if (!prev) return prev;
                              const value = e.target.value.toUpperCase().trim();
                              const existing = prev.symbols[symbol];
                              const accountDestinationSymbols = {
                                ...(existing.accountDestinationSymbols ?? {}),
                                [accountId]: value
                              };
                              return {
                                ...prev,
                                symbols: sortSymbolConfigs({
                                  ...prev.symbols,
                                  [symbol]: {
                                    ...existing,
                                    accountDestinationSymbols
                                  }
                                })
                              };
                            })
                          }
                          placeholder="Destination symbol"
                        />
                      </div>
                    ))}
                  <button
                    type="button"
                    className="ghost"
                    disabled={loading}
                    onClick={() => void saveLotConfig(`Symbol mapping saved for ${accountId}`)}
                  >
                    Save Symbol Mapping
                  </button>
                </>
              ) : (
                <p>Loading symbol mapping...</p>
              )}
            </CollapsibleCard>
          );
        })}

        <CollapsibleCard title="Lot Sizes" className="admin-card-full">
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

              <strong>Pair Lot Sizes</strong>
              {Object.entries(lotConfig.symbols)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([symbol, symbolConfig]) => (
                  <div className="row" key={`lot-${symbol}`}>
                    <input value={symbol} readOnly />
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={symbolConfig.lotSize}
                      onChange={(e) =>
                        setLotConfig((prev) =>
                          prev
                            ? {
                                ...prev,
                                symbols: sortSymbolConfigs({
                                  ...prev.symbols,
                                  [symbol]: {
                                    ...prev.symbols[symbol],
                                    lotSize: Number(e.target.value)
                                  }
                                })
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
                          const next = { ...prev.symbols };
                          delete next[symbol];
                          return {
                            ...prev,
                            symbols: sortSymbolConfigs(next)
                          };
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}

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
                    if (!accountsConfig) return;
                    const symbol = newPair.trim().toUpperCase();
                    const lot = Number(newPairLotSize);
                    if (!symbol || !Number.isFinite(lot)) return;

                    const accountDestinationSymbols = Object.fromEntries(
                      accountsConfig.accounts.map((accountId) => [accountId, symbol])
                    );

                    setLotConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            symbols: sortSymbolConfigs({
                              ...prev.symbols,
                              [symbol]: {
                                lotSize: lot,
                                destinationBrokerSymbol: symbol,
                                accountDestinationSymbols
                              }
                            })
                          }
                        : prev
                    );
                    setNewPair("");
                  }}
                >
                  Add Pair
                </button>
              </div>

              <button type="button" disabled={loading} onClick={() => void saveLotConfig("Lot sizes saved")}>Save Lot Sizes</button>
            </>
          ) : (
            <p>Loading lot size config...</p>
          )}
        </CollapsibleCard>

        {managementMessage ? <p>{managementMessage}</p> : null}
        {managementError ? <p className="error">{managementError}</p> : null}
      </div>
    </div>
  );
}
