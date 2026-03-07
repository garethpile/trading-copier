import { Amplify } from "aws-amplify";
import { fetchAuthSession, signIn, signOut } from "aws-amplify/auth";

const localAuthBypass = import.meta.env.VITE_LOCAL_AUTH_BYPASS === "true";
const localTokenKey = "tradingcopier.local.token";
const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;

if (!localAuthBypass && userPoolId && userPoolClientId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId
      }
    }
  });
}

export const login = async (username: string, password: string): Promise<void> => {
  if (localAuthBypass) {
    if (!username.trim() || !password.trim()) {
      throw new Error("username and password are required");
    }
    localStorage.setItem(localTokenKey, "local-dev-token");
    return;
  }
  await signIn({ username, password });
};

export const logout = async (): Promise<void> => {
  if (localAuthBypass) {
    localStorage.removeItem(localTokenKey);
    return;
  }
  await signOut();
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
