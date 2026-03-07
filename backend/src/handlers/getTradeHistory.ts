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
    const limit = Number(event.queryStringParameters?.limit ?? "50");

    const repository = new TradeRepository(tableName);
    const items = await repository.getHistory(userId, Math.min(limit, 100));

    return jsonResponse(200, { items });
  } catch (error) {
    return jsonResponse(500, { message: "Unexpected history error", error: String(error) });
  }
};
