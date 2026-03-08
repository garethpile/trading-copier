import { getIdToken } from "./auth";
import {
  ConnectivityTestResponse,
  ExecuteTradeRequest,
  ExecuteTradeResponse,
  ParseSignalResponse,
  SocketFeatureEnableResponse,
  SocketFeatureStatusResponse,
  TradeRecord
} from "../types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

const callApi = async <T>(path: string, options: RequestInit): Promise<T> => {
  if (!apiBaseUrl) {
    throw new Error("VITE_API_BASE_URL is not configured");
  }

  const token = await getIdToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {})
    }
  });

  const data = (await response.json()) as T;
  if (!response.ok) {
    throw new Error((data as { message?: string }).message ?? `Request failed: ${response.status}`);
  }

  return data;
};

export const parseSignal = async (rawMessage: string): Promise<ParseSignalResponse> =>
  callApi<ParseSignalResponse>("/parse-signal", {
    method: "POST",
    body: JSON.stringify({ rawMessage })
  });

export const executeTrade = async (request: ExecuteTradeRequest): Promise<ExecuteTradeResponse> =>
  callApi<ExecuteTradeResponse>("/execute-trade", {
    method: "POST",
    body: JSON.stringify(request)
  });

export const fetchTradeHistory = async (): Promise<TradeRecord[]> => {
  const result = await callApi<{ items: TradeRecord[] }>("/trade-history", {
    method: "GET"
  });
  return result.items;
};

export const testConnectivity = async (): Promise<ConnectivityTestResponse> =>
  callApi<ConnectivityTestResponse>("/connectivity-test", {
    method: "POST",
    body: JSON.stringify({})
  });

export const getSocketFeatureStatus = async (accountId: string): Promise<SocketFeatureStatusResponse> =>
  callApi<SocketFeatureStatusResponse>(`/admin/socket-feature-status?accountId=${encodeURIComponent(accountId)}`, {
    method: "GET"
  });

export const enableSocketFeature = async (accountId: string): Promise<SocketFeatureEnableResponse> =>
  callApi<SocketFeatureEnableResponse>("/admin/enable-socket-feature", {
    method: "POST",
    body: JSON.stringify({ accountId })
  });
