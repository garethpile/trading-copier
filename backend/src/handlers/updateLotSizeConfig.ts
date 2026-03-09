import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { UpdateLotSizeConfigRequest } from "../models/types";
import { TradeRepository } from "../repositories/TradeRepository";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const lotSizeRange = () => ({
  min: Number(process.env.LOT_SIZE_MIN ?? "0.01"),
  max: Number(process.env.LOT_SIZE_MAX ?? "50")
});

const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
const normalizeDestinationSymbol = (symbol: string): string => symbol.trim().toUpperCase();

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const body = event.body ? (JSON.parse(event.body) as UpdateLotSizeConfigRequest) : {};
    const repository = new TradeRepository(tableName);
    const current = await repository.getLotSizeConfig(userId);
    const range = lotSizeRange();
    const errors: string[] = [];

    const nextDefault = body.defaultLotSize !== undefined ? toNumber(body.defaultLotSize) : current.defaultLotSize;
    if (nextDefault === undefined || nextDefault < range.min || nextDefault > range.max) {
      errors.push(`defaultLotSize must be between ${range.min} and ${range.max}`);
    }

    const nextMap: Record<string, { lotSize: number; destinationBrokerSymbol: string }> = {};
    const rawMap = body.symbols ?? current.symbols;
    for (const [rawSymbol, rawConfig] of Object.entries(rawMap)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) continue;
      const lot = toNumber((rawConfig as { lotSize?: unknown })?.lotSize);
      if (lot === undefined || lot < range.min || lot > range.max) {
        errors.push(`lot size for ${symbol} must be between ${range.min} and ${range.max}`);
        continue;
      }
      const destinationBrokerSymbol = normalizeDestinationSymbol(
        String((rawConfig as { destinationBrokerSymbol?: unknown })?.destinationBrokerSymbol ?? "")
      );
      if (!destinationBrokerSymbol) {
        errors.push(`destination broker symbol is required for ${symbol}`);
        continue;
      }
      nextMap[symbol] = { lotSize: lot, destinationBrokerSymbol };
    }

    if (errors.length > 0 || nextDefault === undefined) {
      return jsonResponse(400, { message: "Invalid lot size config", errors });
    }

    const next = {
      defaultLotSize: nextDefault,
      symbols: nextMap,
      updatedAt: new Date().toISOString()
    };

    await repository.putLotSizeConfig(userId, next);
    return jsonResponse(200, next);
  } catch (error) {
    return jsonResponse(500, { message: "Failed to update lot size config", error: String(error) });
  }
};
