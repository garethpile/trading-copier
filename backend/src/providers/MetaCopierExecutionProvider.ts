import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import axios from "axios";
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
    private readonly timeoutMs = 30000
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
      await axios.post(
        endpoint,
        {
          symbol: input.symbol,
          orderType: input.side === "BUY" ? "Buy" : "Sell",
          openPrice: 0,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfits[0] ?? 0,
          volume: input.lotSize,
          requestId,
          ...(comment ? { comment } : {})
        },
        {
          timeout: this.timeoutMs,
          headers: this.buildHeaders(secret.apiKey),
          validateStatus: (status) => status === 204
        }
      );

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
      if (axios.isAxiosError(error)) {
        const headers =
          error.response?.headers && typeof (error.response.headers as { toJSON?: () => unknown }).toJSON === "function"
            ? (error.response.headers as { toJSON: () => unknown }).toJSON()
            : error.response?.headers;
        const responseSummary = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          headers: toPlainJson(headers),
          data: toPlainJson(error.response?.data),
          url: error.config?.url,
          method: error.config?.method
        };

        console.error("MetaCopier executeTrade failed", responseSummary);
        return {
          status: "FAILED",
          message: `MetaCopier call failed: ${error.response?.status ?? "network_error"}`,
          providerResponse: toPlainJson(responseSummary)
        };
      }

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
      const response = await axios.get(`${this.globalBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts`, {
        timeout: this.timeoutMs,
        headers: this.buildHeaders(secret.apiKey)
      });

      return {
        status: "OK",
        provider: "MetaCopier",
        message: "Connectivity test succeeded",
        response: {
          accounts: Array.isArray(response.data) ? response.data.length : undefined,
          tradingHost: this.tradingBaseUrl
        }
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const headers =
          error.response?.headers && typeof (error.response.headers as { toJSON?: () => unknown }).toJSON === "function"
            ? (error.response.headers as { toJSON: () => unknown }).toJSON()
            : error.response?.headers;
        const responseSummary = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          headers: toPlainJson(headers),
          data: toPlainJson(error.response?.data),
          url: error.config?.url,
          method: error.config?.method
        };
        console.error("MetaCopier testConnectivity failed", responseSummary);
        return {
          status: "FAILED",
          provider: "MetaCopier",
          message: `Connectivity test failed: ${error.response?.status ?? "network_error"}`,
          response: toPlainJson(responseSummary)
        };
      }

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
