import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TradeRepository } from "../repositories/TradeRepository";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const signalId = event.pathParameters?.signalId;
    if (!signalId) {
      return jsonResponse(400, { message: "signalId is required" });
    }

    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const repository = new TradeRepository(tableName);
    const item = await repository.getBySignalId(userId, signalId);

    if (!item) {
      return jsonResponse(404, { message: "Trade not found" });
    }

    return jsonResponse(200, item);
  } catch (error) {
    return jsonResponse(500, { message: "Unexpected get-by-id error", error: String(error) });
  }
};
