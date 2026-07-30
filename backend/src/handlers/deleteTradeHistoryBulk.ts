import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { TradeRepository } from "../repositories/TradeRepository";
import { TradeRecord } from "../models/types";

const isActiveTrade = (item: TradeRecord): boolean => {
  if (item.status === "EXECUTING" || item.status === "PARTIAL") return true;
  const legs = Array.isArray((item.providerResponse as { legs?: unknown[] } | undefined)?.legs)
    ? ((item.providerResponse as { legs?: unknown[] }).legs ?? [])
    : [];
  if (legs.length === 0) return item.status === "EXECUTED";
  return legs.some((leg) => {
    const runtimeState =
      leg && typeof leg === "object" && typeof (leg as { runtimeState?: unknown }).runtimeState === "string"
        ? String((leg as { runtimeState?: string }).runtimeState).toUpperCase()
        : "UNKNOWN";
    const status =
      leg && typeof leg === "object" && typeof (leg as { status?: unknown }).status === "string"
        ? String((leg as { status?: string }).status).toUpperCase()
        : "UNKNOWN";
    return status === "EXECUTED" && runtimeState !== "CLOSED";
  });
};

const isClosedTrade = (item: TradeRecord): boolean => !isActiveTrade(item);

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = event.body ? (JSON.parse(event.body) as { scope?: "ACTIVE" | "CLOSED" }) : {};
    const scope = body.scope;
    if (scope !== "ACTIVE" && scope !== "CLOSED") {
      return jsonResponse(400, { message: "scope must be ACTIVE or CLOSED" });
    }

    const userId = getUserIdFromEvent(event);
    const repository = new TradeRepository(process.env.TRADE_SIGNALS_TABLE!);
    const items = await repository.getHistory(userId, 500);
    const matches = items.filter((item) => (scope === "ACTIVE" ? isActiveTrade(item) : isClosedTrade(item)));

    for (const item of matches) {
      await repository.deleteTradeRecord(item);
    }

    return jsonResponse(200, {
      success: true,
      scope,
      deletedCount: matches.length
    });
  } catch (error) {
    console.error("Bulk delete trade history failed", error);
    return jsonResponse(500, { message: error instanceof Error ? error.message : "Failed to bulk delete trade history" });
  }
};
