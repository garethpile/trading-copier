import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { MetaCopierAdminService } from "../services/MetaCopierAdminService";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    getUserIdFromEvent(event);

    const accountId =
      event.queryStringParameters?.accountId ||
      (process.env.ALLOWED_TARGET_ACCOUNTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)[0];

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
