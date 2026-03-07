import { useRef, useState } from "react";
import { executeTrade, parseSignal, testConnectivity } from "../services/api";
import { ConnectivityTestResponse, ExecuteTradeResponse, ParseSignalResponse } from "../types";
import { ParsedTradeReview } from "../components/ParsedTradeReview";
import { ExecutionResultPanel } from "../components/ExecutionResultPanel";

const configuredAccounts = (
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
  const [targetAccount, setTargetAccount] = useState(
    configuredAccounts[0] ?? "a5231bf5-8713-44b6-846d-4c7f43a5bf30"
  );
  const [lotSize, setLotSize] = useState(defaultLotSize);
  const [note, setNote] = useState("");
  const [executionResult, setExecutionResult] = useState<ExecuteTradeResponse | null>(null);
  const [connectivityResult, setConnectivityResult] = useState<ConnectivityTestResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const handleParse = async () => {
    setParseError(undefined);
    setExecutionResult(null);

    try {
      setLoading(true);
      const result = await parseSignal(rawMessage);
      setParseResult(result);
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

  const handleExecute = async () => {
    if (!parseResult?.valid || !parseResult.trade) return;

    try {
      setLoading(true);
      const result = await executeTrade({
        rawMessage,
        trade: parseResult.trade,
        targetAccount,
        lotSize,
        note: note.trim() ? note.trim() : undefined
      });
      setExecutionResult(result);
    } catch (error) {
      setExecutionResult({
        status: "FAILED",
        message: String(error)
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Signal Intake</h2>
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
          <button onClick={handleParse} disabled={loading || !rawMessage.trim()}>
            Parse Signal
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

      <div className="card stack">
        <div className="row">
          <h3>MetaCopier Connectivity</h3>
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={async () => {
              try {
                setLoading(true);
                setConnectivityResult(await testConnectivity());
              } catch (error) {
                setConnectivityResult({
                  status: "FAILED",
                  provider: "MetaCopier",
                  message: "Connectivity test failed",
                  error: String(error)
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
            <strong>Status:</strong> {connectivityResult.status} <br />
            <strong>Provider:</strong> {connectivityResult.provider} <br />
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

      {parseResult?.valid && parseResult.trade ? (
        <ParsedTradeReview
          trade={parseResult.trade}
          warnings={parseResult.warnings}
          targetAccount={targetAccount}
          lotSize={lotSize}
          note={note}
          accounts={configuredAccounts}
          onTargetAccountChange={setTargetAccount}
          onLotSizeChange={setLotSize}
          onNoteChange={setNote}
          onExecute={handleExecute}
          onCancel={() => setParseResult(null)}
          disabled={loading}
        />
      ) : null}

      {executionResult ? <ExecutionResultPanel result={executionResult} /> : null}
    </div>
  );
}
