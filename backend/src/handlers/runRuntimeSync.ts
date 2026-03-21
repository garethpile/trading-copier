import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TradeRepository } from "../repositories/TradeRepository";
import { TradeRuntimeSyncService } from "../services/TradeRuntimeSyncService";
import { jsonResponse } from "../utils/http";

export const handler: APIGatewayProxyHandlerV2 = async () => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId =
      process.env.AUTOMATION_USER_ID?.trim() || process.env.TELEGRAM_CONFIG_USER_ID?.trim() || "";
    if (!userId) {
      return jsonResponse(500, { message: "AUTOMATION_USER_ID not configured" });
    }

    const repository = new TradeRepository(tableName);
    const items = await repository.getHistory(userId, 50);
    const runtimeSync = new TradeRuntimeSyncService(repository);
    const synced = await runtimeSync.sync(userId, items);

    return jsonResponse(200, {
      message: "Runtime sync completed",
      userId,
      scanned: items.length,
      updated: synced.length
    });
  } catch (error) {
    console.error("Run runtime sync failed", error);
    return jsonResponse(500, { message: "Runtime sync failed", error: String(error) });
  }
};

