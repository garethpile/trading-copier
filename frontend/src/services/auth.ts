import { Amplify } from "aws-amplify";
import {
  confirmSignIn,
  confirmResetPassword,
  confirmSignUp,
  fetchMFAPreference,
  fetchAuthSession,
  resetPassword,
  setUpTOTP,
  signIn,
  signInWithRedirect,
  signOut,
  signUp,
  updateMFAPreference,
  verifyTOTPSetup
} from "aws-amplify/auth";

const localAuthBypass = import.meta.env.VITE_LOCAL_AUTH_BYPASS === "true";
const localTokenKey = "tradingcopier.local.token";
const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN;
const oauthRedirectIn = import.meta.env.VITE_COGNITO_REDIRECT_SIGN_IN;
const oauthRedirectOut = import.meta.env.VITE_COGNITO_REDIRECT_SIGN_OUT;
const googleSignInEnabled = import.meta.env.VITE_GOOGLE_SIGNIN_ENABLED === "true";

export interface LoginResult {
  signedIn: boolean;
  nextStep?: string;
  message?: string;
}

export const isGoogleSignInConfigured = Boolean(cognitoDomain) && googleSignInEnabled;

if (!localAuthBypass && userPoolId && userPoolClientId) {
  const withOAuth = cognitoDomain
    ? {
        loginWith: {
          oauth: {
            domain: cognitoDomain,
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [oauthRedirectIn || window.location.origin],
            redirectSignOut: [oauthRedirectOut || window.location.origin],
            responseType: "code" as const
          }
        }
      }
    : {};

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        ...withOAuth
      }
    }
  });
}

export const login = async (username: string, password: string): Promise<LoginResult> => {
  if (localAuthBypass) {
    if (!username.trim() || !password.trim()) {
      throw new Error("username and password are required");
    }
    localStorage.setItem(localTokenKey, "local-dev-token");
    return { signedIn: true };
  }

  const result = await signIn({ username, password });
  const step = result.nextStep?.signInStep;
  if (step === "DONE" && result.isSignedIn) {
    return { signedIn: true };
  }

  if (step === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") {
    return { signedIn: false, nextStep: step, message: "Enter code from your authenticator app." };
  }
  if (step === "CONFIRM_SIGN_IN_WITH_SMS_CODE" || step === "CONFIRM_SIGN_IN_WITH_EMAIL_CODE") {
    return { signedIn: false, nextStep: step, message: "Enter the verification code sent to you." };
  }

  return { signedIn: false, nextStep: step, message: `Additional sign-in step required: ${step}` };
};

export const confirmLoginChallenge = async (challengeResponse: string): Promise<LoginResult> => {
  if (localAuthBypass) {
    return { signedIn: true };
  }
  const result = await confirmSignIn({ challengeResponse });
  const step = result.nextStep?.signInStep;
  if (step === "DONE" && result.isSignedIn) {
    return { signedIn: true };
  }
  return { signedIn: false, nextStep: step, message: `Additional sign-in step required: ${step}` };
};

export const loginWithGoogle = async (): Promise<void> => {
  if (localAuthBypass) {
    throw new Error("Google sign-in is not available in local auth bypass mode");
  }
  if (!cognitoDomain) {
    throw new Error("Google sign-in is not configured yet");
  }
  if (!googleSignInEnabled) {
    throw new Error("Google sign-in is disabled for this environment");
  }
  await signInWithRedirect({ provider: "Google" });
};

const isEmail = (value: string): boolean => /\S+@\S+\.\S+/.test(value);
const isPhone = (value: string): boolean => /^\+[1-9]\d{7,14}$/.test(value);

const parseRegistrationIdentifier = (
  value: string
): { username: string; attribute: { key: "email" | "phone_number"; value: string } } => {
  const trimmed = value.trim();
  if (isEmail(trimmed)) {
    return { username: trimmed.toLowerCase(), attribute: { key: "email", value: trimmed.toLowerCase() } };
  }
  if (isPhone(trimmed)) {
    return { username: trimmed, attribute: { key: "phone_number", value: trimmed } };
  }
  throw new Error("Use a valid email or phone number in E.164 format (example: +447700900123)");
};

export const register = async (identifier: string, password: string): Promise<void> => {
  const parsed = parseRegistrationIdentifier(identifier);
  if (localAuthBypass) {
    return;
  }
  await signUp({
    username: parsed.username,
    password,
    options: {
      userAttributes: {
        [parsed.attribute.key]: parsed.attribute.value
      }
    }
  });
};

export const confirmRegistration = async (identifier: string, code: string): Promise<void> => {
  const parsed = parseRegistrationIdentifier(identifier);
  if (localAuthBypass) {
    return;
  }
  await confirmSignUp({
    username: parsed.username,
    confirmationCode: code.trim()
  });
};

export const requestPasswordReset = async (identifier: string): Promise<void> => {
  const parsed = parseRegistrationIdentifier(identifier);
  if (localAuthBypass) {
    return;
  }
  await resetPassword({
    username: parsed.username
  });
};

export const confirmPasswordReset = async (
  identifier: string,
  code: string,
  newPassword: string
): Promise<void> => {
  const parsed = parseRegistrationIdentifier(identifier);
  if (localAuthBypass) {
    return;
  }
  await confirmResetPassword({
    username: parsed.username,
    confirmationCode: code.trim(),
    newPassword
  });
};

export const logout = async (): Promise<void> => {
  if (localAuthBypass) {
    localStorage.removeItem(localTokenKey);
    return;
  }
  await signOut();
};

export const getMfaPreference = async (): Promise<{ enabled?: string[]; preferred?: string }> => {
  if (localAuthBypass) {
    return { enabled: [], preferred: undefined };
  }
  const pref = await fetchMFAPreference();
  return {
    enabled: pref.enabled,
    preferred: pref.preferred
  };
};

export const beginTotpSetup = async (): Promise<{ secret: string; uri: string }> => {
  if (localAuthBypass) {
    throw new Error("MFA setup is unavailable in local auth bypass mode");
  }
  const details = await setUpTOTP();
  return {
    secret: details.sharedSecret,
    uri: details.getSetupUri("Trading Copier").toString()
  };
};

export const confirmTotpSetup = async (code: string): Promise<void> => {
  if (localAuthBypass) {
    return;
  }
  await verifyTOTPSetup({ code: code.trim() });
  await updateMFAPreference({ totp: "PREFERRED" });
};

export const disableTotpMfa = async (): Promise<void> => {
  if (localAuthBypass) {
    return;
  }
  await updateMFAPreference({ totp: "DISABLED" });
};

export const getIdToken = async (): Promise<string | undefined> => {
  if (localAuthBypass) {
    return localStorage.getItem(localTokenKey) ?? undefined;
  }
  const session = await fetchAuthSession();
  return session.tokens?.idToken?.toString();
};

export const isAuthenticated = async (): Promise<boolean> => {
  const token = await getIdToken();
  return Boolean(token);
};
