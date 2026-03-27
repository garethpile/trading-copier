import { useRef, useState } from "react";
import { executeTrade, fetchLotSizeConfig, fetchTargetAccountsConfig, parseSignal } from "../services/api";
import { ExecuteTradeResponse, ParseSignalResponse } from "../types";
import { ParsedTradeReview } from "../components/ParsedTradeReview";
import { ExecutionResultPanel } from "../components/ExecutionResultPanel";
import { useEffect } from "react";

const fallbackAccounts = (
  import.meta.env.VITE_TARGET_ACCOUNTS ?? "a5231bf5-8713-44b6-846d-4c7f43a5bf30"
)
  .split(",")
  .map((v: string) => v.trim())
  .filter(Boolean);

const defaultLotSize = Number(import.meta.env.VITE_DEFAULT_LOT_SIZE ?? "0.01");

export function SignalIntakePage() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [rawMessage, setRawMessage] = useState("");
  const [parseResult, setParseResult] = useState<ParseSignalResponse | null>(null);
  const [parseError, setParseError] = useState<string | undefined>();
  const [accounts, setAccounts] = useState<string[]>(fallbackAccounts);
  const [modeAccounts, setModeAccounts] = useState<Partial<Record<"DEMO" | "LIVE", string>>>({});
  const [executionMode, setExecutionMode] = useState<"DEMO" | "LIVE">("DEMO");
  const [riskTrades, setRiskTrades] = useState<"1" | "2" | "all">("all");
  const [lotSize, setLotSize] = useState(defaultLotSize);
  const [lotSizeConfig, setLotSizeConfig] = useState<{ defaultLotSize: number; symbols: Record<string, { lotSize: number; destinationBrokerSymbol: string }> }>({
    defaultLotSize,
    symbols: {}
  });
  const [note, setNote] = useState("");
  const [executionResult, setExecutionResult] = useState<ExecuteTradeResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetchLotSizeConfig()
      .then((config) => setLotSizeConfig({ defaultLotSize: config.defaultLotSize, symbols: config.symbols }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!parseResult?.valid || !parseResult.trade) return;
    const symbol = parseResult.trade.symbol.toUpperCase();
    const resolvedLot = lotSizeConfig.symbols[symbol]?.lotSize ?? lotSizeConfig.defaultLotSize;
    setLotSize(resolvedLot);
  }, [parseResult, lotSizeConfig]);

  useEffect(() => {
    void fetchTargetAccountsConfig()
      .then((config) => {
        if (config.accounts.length > 0) {
          setAccounts(config.accounts);
          setModeAccounts(config.modeAccounts ?? {});
          setExecutionMode(config.executionMode ?? "DEMO");
          setRiskTrades(config.riskTrades ?? "all");
        }
      })
      .catch(() => undefined);
  }, []);

  const selectedAccount =
    modeAccounts[executionMode] ??
    (executionMode === "LIVE" ? accounts[1] ?? accounts[0] : accounts[0]) ??
    "";

  const handleParse = async () => {
    setParseError(undefined);
    setExecutionResult(null);

    if (!selectedAccount) {
      setParseError("Select DEMO or LIVE account before submitting.");
      return;
    }

    try {
      setLoading(true);
      const result = await parseSignal(rawMessage);
      setParseResult(result);
      if (result.valid && result.trade) {
        const symbol = result.trade.symbol.toUpperCase();
        const resolvedLot = lotSizeConfig.symbols[symbol]?.lotSize ?? lotSizeConfig.defaultLotSize;
        setLotSize(resolvedLot);
        try {
          const executeResult = await executeTrade({
            rawMessage,
            trade: result.trade,
            targetAccount: selectedAccount,
            lotSize: resolvedLot,
            note: note.trim() ? note.trim() : undefined
          });
          setExecutionResult(executeResult);
        } catch (error) {
          setExecutionResult({
            status: "FAILED",
            message: String(error)
          });
        }
      }
    } catch (error) {
      setParseError(String(error));
      setParseResult(null);
    } finally {
      setLoading(false);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRawMessage(text.replace(/\r\n/g, "\n"));
        textareaRef.current?.focus();
      }
    } catch (error) {
      setParseError(`Clipboard paste failed: ${String(error)}`);
    }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Signal Intake</h2>
        <div className="row">
          <label style={{ minWidth: 180 }}>
            Account
            <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value === "LIVE" ? "LIVE" : "DEMO")}>
              <option value="DEMO">DEMO</option>
              <option value="LIVE">LIVE</option>
            </select>
          </label>
          <label style={{ minWidth: 340 }}>
            Selected Account ID
            <input value={selectedAccount || "Not configured"} readOnly />
          </label>
          <label style={{ minWidth: 220 }}>
            Risk Trades
            <input
              value={riskTrades === "1" ? "Trade 2 only" : riskTrades === "2" ? "Trades 1 and 2" : "All 3 trades"}
              readOnly
            />
          </label>
        </div>
        <label>
          Raw Signal Message
          <textarea
            ref={textareaRef}
            rows={10}
            value={rawMessage}
            onChange={(e) => setRawMessage(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.getData("text");
              if (pasted !== undefined) {
                e.preventDefault();
                setRawMessage(pasted.replace(/\r\n/g, "\n"));
              }
            }}
            placeholder="Paste signal text here"
            autoFocus
          />
        </label>
        <div className="row">
          <button onClick={handlePasteFromClipboard} type="button" className="ghost">
            Paste from Clipboard
          </button>
          <button onClick={handleParse} disabled={loading || !rawMessage.trim() || !selectedAccount}>
            Parse & Execute
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setRawMessage("");
              setParseResult(null);
              setExecutionResult(null);
              setParseError(undefined);
            }}
          >
            Clear
          </button>
        </div>
        {parseError ? <p className="error">{parseError}</p> : null}
        {parseResult && !parseResult.valid ? (
          <div>
            <strong>Validation Errors</strong>
            <ul>
              {parseResult.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {parseResult?.valid && parseResult.trade ? (
        <ParsedTradeReview
          trade={parseResult.trade}
          warnings={parseResult.warnings}
          targetAccount={selectedAccount}
          executionMode={executionMode}
          lotSize={lotSize}
          note={note}
        />
      ) : null}

      {executionResult ? <ExecutionResultPanel result={executionResult} /> : null}
    </div>
  );
}
