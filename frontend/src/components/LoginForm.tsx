import { FormEvent, useState } from "react";
import {
  confirmLoginChallenge,
  confirmPasswordReset,
  confirmRegistration,
  isGoogleSignInConfigured,
  login,
  loginWithGoogle,
  register,
  requestPasswordReset
} from "../services/auth";

interface Props {
  onAuthenticated: () => void;
}

type Mode = "signin" | "register" | "reset";

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export function LoginForm({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [registerPendingConfirm, setRegisterPendingConfirm] = useState(false);
  const [resetPendingConfirm, setResetPendingConfirm] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [signinNextStep, setSigninNextStep] = useState<string | undefined>();

  const resetStatus = () => {
    setError(undefined);
    setMessage(undefined);
  };

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    resetStatus();
    setLoading(true);
    try {
      const result = await login(identifier.trim(), password);
      if (result.signedIn) {
        onAuthenticated();
        return;
      }
      setSigninNextStep(result.nextStep);
      setMessage(result.message);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (event: FormEvent) => {
    event.preventDefault();
    resetStatus();
    setLoading(true);
    try {
      if (!registerPendingConfirm) {
        await register(identifier, password);
        setRegisterPendingConfirm(true);
        setMessage("Verification code sent. Enter it below to complete registration.");
      } else {
        await confirmRegistration(identifier, code);
        setRegisterPendingConfirm(false);
        setMode("signin");
        setMessage("Registration complete. You can now sign in.");
        setCode("");
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (event: FormEvent) => {
    event.preventDefault();
    resetStatus();
    setLoading(true);
    try {
      if (!resetPendingConfirm) {
        await requestPasswordReset(identifier);
        setResetPendingConfirm(true);
        setMessage("Reset code sent. Enter code and new password.");
      } else {
        await confirmPasswordReset(identifier, code, newPassword);
        setResetPendingConfirm(false);
        setMode("signin");
        setMessage("Password reset complete. You can now sign in.");
        setCode("");
        setNewPassword("");
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const setModeState = (next: Mode) => {
    setMode(next);
    setRegisterPendingConfirm(false);
    setResetPendingConfirm(false);
    setSigninNextStep(undefined);
    setCode("");
    setNewPassword("");
    setMfaCode("");
    resetStatus();
  };

  return (
    <div className="card stack">
      <h2>Account Access</h2>
      <div className="pill-group">
        <button type="button" className={`pill-btn ${mode === "signin" ? "active" : ""}`} onClick={() => setModeState("signin")}>
          Sign In
        </button>
        <button type="button" className={`pill-btn ${mode === "register" ? "active" : ""}`} onClick={() => setModeState("register")}>
          Register
        </button>
        <button type="button" className={`pill-btn ${mode === "reset" ? "active" : ""}`} onClick={() => setModeState("reset")}>
          Reset Password
        </button>
      </div>

      {mode === "signin" ? (
        <form onSubmit={handleSignIn} className="stack">
          <label>
            Email or Mobile
            <input
              placeholder="you@example.com or +447700900123"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {signinNextStep === "CONFIRM_SIGN_IN_WITH_TOTP_CODE" ||
          signinNextStep === "CONFIRM_SIGN_IN_WITH_SMS_CODE" ||
          signinNextStep === "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" ? (
            <label>
              Verification Code
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required />
            </label>
          ) : null}
          {signinNextStep ? (
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const result = await confirmLoginChallenge(mfaCode);
                  if (result.signedIn) {
                    onAuthenticated();
                    return;
                  }
                  setSigninNextStep(result.nextStep);
                  setMessage(result.message);
                } catch (e) {
                  setError(getErrorMessage(e));
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? "Verifying..." : "Verify Code"}
            </button>
          ) : (
            <button disabled={loading}>{loading ? "Signing In..." : "Sign In"}</button>
          )}
          {isGoogleSignInConfigured ? (
            <button
              type="button"
              className="google-signin-btn"
              onClick={async () => {
                setLoading(true);
                resetStatus();
                try {
                  await loginWithGoogle();
                } catch (e) {
                  setError(getErrorMessage(e));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
            >
              <span className="google-signin-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.58 2.68-3.9 2.68-6.62z"
                    fill="#4285F4"
                  />
                  <path
                    d="M9 18c2.43 0 4.46-.8 5.95-2.18l-2.92-2.26c-.81.54-1.84.86-3.03.86-2.33 0-4.3-1.57-5-3.68H.98V13.1A9 9 0 0 0 9 18z"
                    fill="#34A853"
                  />
                  <path
                    d="M4 10.74A5.41 5.41 0 0 1 3.73 9c0-.6.1-1.18.27-1.74V5H.98A9 9 0 0 0 0 9c0 1.45.35 2.82.98 4.1L4 10.74z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M9 3.58c1.32 0 2.5.45 3.43 1.35l2.57-2.57C13.45.9 11.42 0 9 0A9 9 0 0 0 .98 5L4 7.26c.7-2.11 2.67-3.68 5-3.68z"
                    fill="#EA4335"
                  />
                </svg>
              </span>
              <span>Sign in with Google</span>
            </button>
          ) : null}
        </form>
      ) : null}

      {mode === "register" ? (
        <form onSubmit={handleRegister} className="stack">
          <label>
            Email or Mobile
            <input
              placeholder="you@example.com or +447700900123"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </label>
          {!registerPendingConfirm ? (
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          ) : (
            <label>
              Verification Code
              <input value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
          )}
          <button disabled={loading}>
            {loading
              ? "Submitting..."
              : registerPendingConfirm
                ? "Confirm Registration"
                : "Create Account"}
          </button>
        </form>
      ) : null}

      {mode === "reset" ? (
        <form onSubmit={handleReset} className="stack">
          <label>
            Email or Mobile
            <input
              placeholder="you@example.com or +447700900123"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </label>
          {resetPendingConfirm ? (
            <>
              <label>
                Verification Code
                <input value={code} onChange={(e) => setCode(e.target.value)} required />
              </label>
              <label>
                New Password
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
              </label>
            </>
          ) : null}
          <button disabled={loading}>
            {loading
              ? "Submitting..."
              : resetPendingConfirm
                ? "Confirm Reset"
                : "Send Reset Code"}
          </button>
        </form>
      ) : null}

      {message ? <p>{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
