import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TradeRepository } from "../repositories/TradeRepository";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const body = event.body ? (JSON.parse(event.body) as { accounts?: unknown }) : {};
    const accounts = Array.isArray(body.accounts)
      ? body.accounts.map((v) => String(v).trim()).filter(Boolean)
      : [];

    if (accounts.length === 0) {
      return jsonResponse(400, { message: "At least one target account is required" });
    }

    const unique = Array.from(new Set(accounts));
    const repository = new TradeRepository(tableName);
    const next = {
      accounts: unique,
      updatedAt: new Date().toISOString()
    };
    await repository.putTargetAccountsConfig(userId, next);
    return jsonResponse(200, next);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to update target accounts config", error: String(error) });
  }
};

