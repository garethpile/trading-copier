import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TradeRepository } from "../repositories/TradeRepository";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { TradeManagementRequest, TradeManagementService } from "../services/TradeManagementService";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const signalId = event.pathParameters?.signalId;
    if (!signalId) return jsonResponse(400, { message: "signalId is required" });
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });

    const userId = getUserIdFromEvent(event);
    const body = JSON.parse(event.body ?? "{}") as TradeManagementRequest & { confirmationToken?: string };
    if (!body.confirmationToken) return jsonResponse(400, { message: "confirmationToken is required" });

    const { confirmationToken, ...request } = body;
    const service = new TradeManagementService(new TradeRepository(tableName));
    const result = await service.apply(userId, signalId, request, confirmationToken);
    return jsonResponse(result.status === "UPDATED" ? 200 : 502, result);
  } catch (error) {
    return jsonResponse(400, { message: "Failed to apply trade management", error: String(error) });
  }
};
