import { ExecutionProvider } from "../models/types";
import { MetaCopierExecutionProvider } from "./MetaCopierExecutionProvider";

class MockExecutionProvider implements ExecutionProvider {
  async executeTrade(_input: {
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
  }): Promise<{
    status: "EXECUTED";
    executionId: string;
    requestId: number;
    providerResponse: unknown;
    message: string;
  }> {
    const executionId = `local_exec_${Date.now()}`;
    const requestId = _input.requestId ?? Math.floor(Math.random() * 1000);
    return {
      status: "EXECUTED",
      executionId,
      requestId,
      providerResponse: { executionId, requestId, provider: "MockExecutionProvider" },
      message: "Trade executed successfully (mock provider)"
    };
  }

  async testConnectivity(): Promise<{
    status: "OK";
    provider: string;
    message: string;
    response: unknown;
  }> {
    return {
      status: "OK",
      provider: "MockExecutionProvider",
      message: "Mock connectivity succeeded",
      response: { mode: "mock" }
    };
  }
}

export const buildExecutionProvider = (): ExecutionProvider => {
  if ((process.env.EXECUTION_PROVIDER ?? "").toLowerCase() === "mock") {
    return new MockExecutionProvider();
  }

  const secretArn = process.env.METACOPIER_SECRET_ARN;
  const apiKey = process.env.METACOPIER_API_KEY;
  const baseUrl = process.env.METACOPIER_BASE_URL;
  const globalBaseUrl = process.env.METACOPIER_GLOBAL_BASE_URL ?? "https://api.metacopier.io";

  if (!baseUrl) {
    throw new Error("METACOPIER_BASE_URL is required");
  }

  if (!secretArn && !apiKey) {
    throw new Error("Either METACOPIER_SECRET_ARN or METACOPIER_API_KEY is required");
  }

  return new MetaCopierExecutionProvider(secretArn ?? "", baseUrl, globalBaseUrl);
};
