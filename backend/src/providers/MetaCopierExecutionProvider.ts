import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ConnectivityTestResult, ExecutionProvider, TradeExecutionResult } from "../models/types";

interface MetaCopierSecret {
  apiKey: string;
}

const toPlainJson = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

export class MetaCopierExecutionProvider implements ExecutionProvider {
  private readonly client = new SecretsManagerClient({});
  private secretCache?: MetaCopierSecret;

  constructor(
    private readonly secretArn: string,
    private readonly tradingBaseUrl: string,
    private readonly globalBaseUrl: string,
    private readonly timeoutMs = Number(process.env.METACOPIER_REQUEST_TIMEOUT_MS ?? "3500")
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

  async executeTrade(input: {
    symbol: string;
    side: "BUY" | "SELL";
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    lotSize: number;
    targetAccount: string;
    note?: string;
    requestId?: number;
  }): Promise<TradeExecutionResult> {
    const secret = await this.getSecret();

    const requestId = input.requestId ?? Math.floor(Date.now() % 1000);
    const comment = input.note?.slice(0, 20);

    try {
      const endpoint = `${this.tradingBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.targetAccount}/positions`;
      const response = await this.fetchWithTimeout(endpoint, {
        method: "POST",
        headers: this.buildHeaders(secret.apiKey),
        body: JSON.stringify({
          symbol: input.symbol,
          orderType: input.side === "BUY" ? "Buy" : "Sell",
          openPrice: 0,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfits[0] ?? 0,
          volume: input.lotSize,
          requestId,
          ...(comment ? { comment } : {})
        })
      });
      if (response.status !== 204) {
        const body = await this.readBody(response);
        return {
          status: "FAILED",
          message: `MetaCopier call failed: ${response.status}`,
          providerResponse: {
            status: response.status,
            statusText: response.statusText,
            data: body,
            url: endpoint,
            method: "POST"
          }
        };
      }

      return {
        status: "EXECUTED",
        executionId: `mc_${Date.now()}`,
        providerResponse: {
          requestId,
          endpoint: `${this.tradingBaseUrl}/rest/api/v1/accounts/{accountId}/positions`,
          executionMode: "MARKET"
        },
        message: "Trade submitted successfully at market price"
      };
    } catch (error) {
      console.error("MetaCopier executeTrade failed (non-axios)", String(error));
      return {
        status: "FAILED",
        message: "MetaCopier call failed",
        providerResponse: String(error)
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
