import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { TradeRepository } from "../repositories/TradeRepository";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const signalId = event.pathParameters?.signalId;
    if (!signalId) return jsonResponse(400, { message: "signalId is required" });

    const userId = getUserIdFromEvent(event);
    const repository = new TradeRepository(process.env.TRADE_SIGNALS_TABLE!);
    const trade = await repository.getBySignalId(userId, signalId);
    if (!trade) return jsonResponse(404, { message: "Trade not found" });

    await repository.deleteTradeRecord(trade);
    return jsonResponse(200, { success: true, signalId });
  } catch (error) {
    console.error("Delete trade failed", error);
    return jsonResponse(500, { message: error instanceof Error ? error.message : "Failed to delete trade" });
  }
};
