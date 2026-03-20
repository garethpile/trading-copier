import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ConnectivityTestResult, ExecutionProvider, TradeExecutionResult } from "../models/types";

interface MetaCopierSecret {
  apiKey: string;
}

type GenericObject = Record<string, unknown>;

const toPlainJson = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const extractErrorMessage = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const obj = value as GenericObject;

  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map((entry) => {
        if (typeof entry === "string" && entry.trim()) return entry.trim();
        if (!entry || typeof entry !== "object") return undefined;
        const nested = entry as GenericObject;
        return (
          (typeof nested.message === "string" && nested.message.trim()) ||
          (typeof nested.error === "string" && nested.error.trim()) ||
          (typeof nested.title === "string" && nested.title.trim()) ||
          (typeof nested.detail === "string" && nested.detail.trim()) ||
          (typeof nested.code === "string" && nested.code.trim())
        );
      })
      .filter((msg): msg is string => Boolean(msg));
    if (messages.length > 0) {
      return messages.join(" | ");
    }
  }

  const direct =
    (typeof obj.message === "string" && obj.message.trim()) ||
    (typeof obj.error === "string" && obj.error.trim()) ||
    (typeof obj.title === "string" && obj.title.trim()) ||
    (typeof obj.detail === "string" && obj.detail.trim());
  if (direct) return direct;

  return undefined;
};

export class MetaCopierExecutionProvider implements ExecutionProvider {
  private readonly client = new SecretsManagerClient({});
  private secretCache?: MetaCopierSecret;

  constructor(
    private readonly secretArn: string,
    private readonly tradingBaseUrl: string,
    private readonly globalBaseUrl: string,
    private readonly timeoutMs = Number(process.env.METACOPIER_REQUEST_TIMEOUT_MS ?? "25000")
  ) {}

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    };

    const userEmail = process.env.METACOPIER_USER_EMAIL;
    if (userEmail && userEmail.trim()) {
      headers["X-User-Email"] = userEmail.trim();
    }

    return headers;
  }

  private async getSecret(): Promise<MetaCopierSecret> {
    const envApiKey = process.env.METACOPIER_API_KEY;
    if (envApiKey && envApiKey.trim()) {
      return { apiKey: envApiKey.trim() };
    }

    if (this.secretCache) return this.secretCache;

    const out = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
    if (!out.SecretString) {
      throw new Error("MetaCopier secret value missing");
    }

    const parsed = JSON.parse(out.SecretString) as Partial<MetaCopierSecret>;
    if (!parsed.apiKey) {
      throw new Error("MetaCopier secret missing apiKey");
    }

    this.secretCache = { apiKey: parsed.apiKey };
    return this.secretCache;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private isAbortError(error: unknown): boolean {
    const message =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : JSON.stringify(error);
    return message.toLowerCase().includes("aborted");
  }

  private toObject(value: unknown): GenericObject | undefined {
    return value && typeof value === "object" ? (value as GenericObject) : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }

  private extractRequestId(position: GenericObject): number | undefined {
    const providerResponse = this.toObject(position.providerResponse);
    const nested = this.asNumber(providerResponse?.requestId);
    if (nested !== undefined) return Math.floor(nested);
    const direct = this.asNumber(position.requestId ?? position.clientRequestId ?? position.magicNumber);
    if (direct !== undefined) return Math.floor(direct);
    const comment = typeof position.comment === "string" ? position.comment : undefined;
    if (!comment) return undefined;
    const apiMatch = comment.match(/API\|(\d+)\|/);
    if (apiMatch) return Number(apiMatch[1]);
    return undefined;
  }

  private async findOpenPositionByRequestId(input: {
    accountId: string;
    requestId: number;
    apiKey: string;
  }): Promise<boolean> {
    const endpoint = `${this.tradingBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.accountId}/positions`;
    try {
      const response = await this.fetchWithTimeout(endpoint, {
        method: "GET",
        headers: this.buildHeaders(input.apiKey)
      });
      if (!response.ok) return false;
      const body = await this.readBody(response);
      const bodyObj = this.toObject(body);
      const positions = Array.isArray(body)
        ? (body as GenericObject[])
        : Array.isArray(bodyObj?.openPositions)
          ? (bodyObj?.openPositions as GenericObject[])
          : Array.isArray(bodyObj?.positions)
            ? (bodyObj?.positions as GenericObject[])
            : [];
      return positions.some((p) => this.extractRequestId(p) === input.requestId);
    } catch {
      return false;
    }
  }

  private async findOpenPositionByRequestIdWithRetry(input: {
    accountId: string;
    requestId: number;
    apiKey: string;
    attempts?: number;
    delayMs?: number;
  }): Promise<boolean> {
    const attempts = Math.max(1, input.attempts ?? 4);
    const delayMs = Math.max(200, input.delayMs ?? 1500);

    for (let i = 0; i < attempts; i += 1) {
      const found = await this.findOpenPositionByRequestId({
        accountId: input.accountId,
        requestId: input.requestId,
        apiKey: input.apiKey
      });
      if (found) return true;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return false;
  }

  async executeTrade(input: {
    symbol: string;
    destinationBrokerSymbol?: string;
    side: "BUY" | "SELL";
    orderType: "MARKET" | "LIMIT";
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    lotSize: number;
    targetAccount: string;
    note?: string;
    requestId?: number;
  }): Promise<TradeExecutionResult> {
    const startedAt = Date.now();
    const secretStartAt = Date.now();
    const secret = await this.getSecret();
    const secretMs = Date.now() - secretStartAt;

    const requestId = input.requestId ?? Math.floor(Date.now() % 1000);
    const comment = input.note?.slice(0, 20);
    const endpoint = `${this.tradingBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.targetAccount}/positions`;
    const symbol = (input.destinationBrokerSymbol ?? input.symbol).trim().toUpperCase();

    let requestMs: number | undefined;

    try {
      let response: Response;
      try {
        const providerOrderType =
          input.orderType === "LIMIT"
            ? input.side === "BUY"
              ? "BuyLimit"
              : "SellLimit"
            : input.side === "BUY"
              ? "Buy"
              : "Sell";
        const requestStartAt = Date.now();
        response = await this.fetchWithTimeout(endpoint, {
          method: "POST",
          headers: this.buildHeaders(secret.apiKey),
          body: JSON.stringify({
            symbol,
            orderType: providerOrderType,
            openPrice: input.orderType === "LIMIT" ? input.entry : 0,
            stopLoss: input.stopLoss,
            takeProfit: input.takeProfits[0] ?? 0,
            volume: input.lotSize,
            requestId,
            ...(comment ? { comment } : {})
          })
        });
        requestMs = Date.now() - requestStartAt;
      } catch (error) {
        if (this.isAbortError(error)) {
          const recovered = await this.findOpenPositionByRequestIdWithRetry({
            accountId: input.targetAccount,
            requestId,
            apiKey: secret.apiKey,
            attempts: 5,
            delayMs: 1500
          });
          if (recovered) {
            return {
              status: "EXECUTED",
              executionId: `mc_${Date.now()}`,
              requestId,
              providerResponse: {
                requestId,
                symbolUsed: symbol,
                endpoint: `${this.tradingBaseUrl}/rest/api/v1/accounts/{accountId}/positions`,
                executionMode: "MARKET",
                recoveredAfterTimeout: true,
                timings: {
                  secretMs,
                  requestMs,
                  totalMs: Date.now() - startedAt
                }
              },
              message: "Trade likely executed (recovered after timeout)"
            };
          }
          console.error("MetaCopier executeTrade timeout", {
            requestId,
            symbol,
            accountId: input.targetAccount,
            url: endpoint
          });
          return {
            status: "FAILED",
            requestId,
            message: "MetaCopier call timed out",
            providerResponse: {
              status: 408,
              statusText: "Request Timeout",
              data: String(error),
              symbolAttempted: symbol,
              requestId,
              url: endpoint,
              method: "POST",
              timings: {
                secretMs,
                requestMs,
                totalMs: Date.now() - startedAt
              }
            }
          };
        }
        throw error;
      }

      if (response.status === 204) {
        return {
          status: "EXECUTED",
          executionId: `mc_${Date.now()}`,
          requestId,
          providerResponse: {
            requestId,
            symbolUsed: symbol,
            endpoint: `${this.tradingBaseUrl}/rest/api/v1/accounts/{accountId}/positions`,
            executionMode: "MARKET",
            timings: {
              secretMs,
              requestMs,
              totalMs: Date.now() - startedAt
            }
          },
          message: "Trade submitted successfully at market price"
        };
      }

      const body = await this.readBody(response);
      const extractedError = extractErrorMessage(body) ?? response.statusText ?? "Unknown error";
      const brokerRejection =
        response.status === 400 && /\bBROKER_REJECTION\b/i.test(extractedError);
      const rejectionHint = brokerRejection
        ? ` Broker rejected order; likely causes: invalid symbol for account, broker min distance/market rules, or instrument not tradable now. symbol=${symbol} account=${input.targetAccount}`
        : "";
      console.error("MetaCopier executeTrade provider failure", {
        status: response.status,
        statusText: response.statusText,
        requestId,
        symbol,
        accountId: input.targetAccount,
        response: toPlainJson(body)
      });
      return {
        status: "FAILED",
        requestId,
        message: `MetaCopier error ${response.status}: ${extractedError}${rejectionHint}`,
        providerResponse: {
          status: response.status,
          statusText: response.statusText,
          data: body,
          symbolAttempted: symbol,
          requestId,
          url: endpoint,
          method: "POST",
          timings: {
            secretMs,
            requestMs,
            totalMs: Date.now() - startedAt
          }
        }
      };
    } catch (error) {
      console.error("MetaCopier executeTrade failed (non-axios)", String(error));
      return {
        status: "FAILED",
        message: "MetaCopier call failed",
        providerResponse: {
          error: String(error),
          timings: {
            secretMs,
            requestMs,
            totalMs: Date.now() - startedAt
          }
        }
      };
    }
  }

  async testConnectivity(): Promise<ConnectivityTestResult> {
    const secret = await this.getSecret();

    try {
      const endpoint = `${this.globalBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts`;
      const response = await this.fetchWithTimeout(endpoint, {
        method: "GET",
        headers: this.buildHeaders(secret.apiKey)
      });
      const body = await this.readBody(response);
      if (!response.ok) {
        console.error("MetaCopier testConnectivity failed", {
          status: response.status,
          statusText: response.statusText,
          data: toPlainJson(body),
          url: endpoint,
          method: "GET"
        });
        return {
          status: "FAILED",
          provider: "MetaCopier",
          message: `Connectivity test failed: ${response.status}`,
          response: {
            status: response.status,
            statusText: response.statusText,
            data: toPlainJson(body),
            url: endpoint,
            method: "GET"
          }
        };
      }

      return {
        status: "OK",
        provider: "MetaCopier",
        message: "Connectivity test succeeded",
        response: {
          accounts: Array.isArray(body) ? body.length : undefined,
          tradingHost: this.tradingBaseUrl
        }
      };
    } catch (error) {
      console.error("MetaCopier testConnectivity failed (non-axios)", String(error));
      return {
        status: "FAILED",
        provider: "MetaCopier",
        message: "Connectivity test failed",
        response: String(error)
      };
    }
  }
}
