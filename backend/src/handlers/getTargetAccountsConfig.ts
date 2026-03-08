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
    const repository = new TradeRepository(tableName);
    const config = await repository.getTargetAccountsConfig(userId);
    return jsonResponse(200, config);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to get target accounts config", error: String(error) });
  }
};

