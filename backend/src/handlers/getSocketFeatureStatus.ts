import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { MetaCopierAdminService } from "../services/MetaCopierAdminService";
import { TradeRepository } from "../repositories/TradeRepository";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const repository = new TradeRepository(tableName);
    const accountConfig = await repository.getTargetAccountsConfig(userId);

    const accountId =
      event.queryStringParameters?.accountId ||
      accountConfig.accounts[0];

    if (!accountId) {
      return jsonResponse(400, { message: "accountId is required" });
    }

    const service = new MetaCopierAdminService();
    const result = await service.getSocketFeatureStatus(accountId);
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to get socket feature status", error: String(error) });
  }
};
