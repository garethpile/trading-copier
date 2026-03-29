import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TargetAccountsConfig } from "../models/types";
import { TradeRepository } from "../repositories/TradeRepository";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";

const normalizeRiskTrades = (value: unknown): string => {
  if (typeof value !== "string") return "1,2,3";
  const normalized = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part === "1" || part === "2" || part === "3")
    .filter((part, index, arr) => arr.indexOf(part) === index)
    .sort()
    .join(",");

  return normalized || "1,2,3";
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const body = event.body
      ? (JSON.parse(event.body) as {
          accounts?: unknown;
          executionMode?: unknown;
          modeAccounts?: unknown;
          riskTrades?: unknown;
        })
      : {};
    const accounts = Array.isArray(body.accounts)
      ? body.accounts.map((v) => String(v).trim()).filter(Boolean)
      : [];

    if (accounts.length === 0) {
      return jsonResponse(400, { message: "At least one target account is required" });
    }

    const unique = Array.from(new Set(accounts));
    const executionMode = body.executionMode === "LIVE" ? "LIVE" : "DEMO";
    const modeAccountsInput =
      body.modeAccounts && typeof body.modeAccounts === "object"
        ? (body.modeAccounts as Partial<Record<"DEMO" | "LIVE", string>>)
        : {};
    const demoAccount =
      modeAccountsInput.DEMO && unique.includes(String(modeAccountsInput.DEMO))
        ? String(modeAccountsInput.DEMO)
        : unique[0];
    const liveAccount =
      modeAccountsInput.LIVE && unique.includes(String(modeAccountsInput.LIVE))
        ? String(modeAccountsInput.LIVE)
        : unique[1] ?? unique[0];
    const riskTrades = normalizeRiskTrades(body.riskTrades);

    const repository = new TradeRepository(tableName);
    const next: TargetAccountsConfig = {
      accounts: unique,
      executionMode,
      modeAccounts: {
        DEMO: demoAccount,
        LIVE: liveAccount
      },
      riskTrades,
      updatedAt: new Date().toISOString()
    };
    await repository.putTargetAccountsConfig(userId, next);
    return jsonResponse(200, next);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to update target accounts config", error: String(error) });
  }
};
