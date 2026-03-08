import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { MetaCopierAdminService } from "../services/MetaCopierAdminService";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    getUserIdFromEvent(event);

    const body = JSON.parse(event.body ?? "{}") as { accountId?: string };
    const accountId =
      body.accountId ||
      (process.env.ALLOWED_TARGET_ACCOUNTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)[0];

    if (!accountId) {
      return jsonResponse(400, { message: "accountId is required" });
    }

    const service = new MetaCopierAdminService();
    const result = await service.enableSocketFeature(accountId);
    return jsonResponse(result.success ? 200 : 502, result);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to enable socket feature", error: String(error) });
  }
};
