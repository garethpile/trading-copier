import { useEffect, useState } from "react";
import { beginTotpSetup, confirmTotpSetup, disableTotpMfa, getMfaPreference } from "../services/auth";

export function SecuritySettings() {
  const [enabled, setEnabled] = useState<string[]>([]);
  const [preferred, setPreferred] = useState<string | undefined>();
  const [secret, setSecret] = useState<string | undefined>();
  const [uri, setUri] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = async () => {
    const pref = await getMfaPreference();
    setEnabled(pref.enabled ?? []);
    setPreferred(pref.preferred);
  };

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="card stack">
      <h2>Security</h2>
      <p className="request-meta">
        MFA Enabled: {enabled.length ? enabled.join(", ") : "None"} | Preferred: {preferred ?? "None"}
      </p>
      <div className="row">
        <button
          type="button"
          onClick={async () => {
            setLoading(true);
            setError(undefined);
            setMessage(undefined);
            try {
              const setup = await beginTotpSetup();
              setSecret(setup.secret);
              setUri(setup.uri);
              setMessage("Scan with Google Authenticator / Authy, then enter a 6-digit code.");
            } catch (e) {
              setError(String(e));
            } finally {
              setLoading(false);
            }
          }}
          disabled={loading}
        >
          Setup Authenticator MFA
        </button>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            setLoading(true);
            setError(undefined);
            setMessage(undefined);
            try {
              await disableTotpMfa();
              await refresh();
              setSecret(undefined);
              setUri(undefined);
              setMessage("Authenticator MFA disabled.");
            } catch (e) {
              setError(String(e));
            } finally {
              setLoading(false);
            }
          }}
          disabled={loading}
        >
          Disable Authenticator MFA
        </button>
      </div>

      {secret ? (
        <div className="stack request-grid">
          <label>
            Secret
            <input value={secret} readOnly />
          </label>
          {uri ? (
            <label>
              Setup URI
              <input value={uri} readOnly />
            </label>
          ) : null}
          <label>
            6-digit code from authenticator app
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              setError(undefined);
              setMessage(undefined);
              try {
                await confirmTotpSetup(code);
                await refresh();
                setMessage("Authenticator MFA enabled and set as preferred.");
                setCode("");
                setSecret(undefined);
                setUri(undefined);
              } catch (e) {
                setError(String(e));
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading || !code.trim()}
          >
            Confirm MFA Setup
          </button>
        </div>
      ) : null}

      {message ? <p>{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
