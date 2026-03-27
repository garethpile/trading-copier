import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { parseSignal } from "../parsers/signalParser";
import { TradeRepository } from "../repositories/TradeRepository";
import { ExecutionService, DuplicateTradeError } from "../services/ExecutionService";
import { validateExecutionRequest } from "../validators/tradeValidator";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { ExecuteTradeRequest } from "../models/types";

const lotMin = Number(process.env.LOT_SIZE_MIN ?? "0.01");
const lotMax = Number(process.env.LOT_SIZE_MAX ?? "50");
const requireProtectiveLevels = (process.env.REQUIRE_PROTECTIVE_LEVELS ?? "true") === "true";

const summarizeRawMessage = (rawMessage: string) => {
  const lines = rawMessage.split(/\r?\n/);
  const nonAscii = Array.from(new Set(
    Array.from(rawMessage)
      .filter((char) => char.charCodeAt(0) > 127)
      .map((char) => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
  ));

  return {
    length: rawMessage.length,
    lineCount: lines.length,
    preview: JSON.stringify(rawMessage.slice(0, 500)),
    lines: lines.slice(0, 12).map((line, index) => ({
      index: index + 1,
      text: JSON.stringify(line),
      length: line.length
    })),
    nonAscii
  };
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { status: "FAILED", message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const body = JSON.parse(event.body ?? "{}") as ExecuteTradeRequest;
    const repository = new TradeRepository(tableName);
    const accountConfig = await repository.getTargetAccountsConfig(userId);

    const parseResult = parseSignal(body.rawMessage ?? "");
    if (!parseResult.valid || !parseResult.trade) {
      console.error("executeTrade parse failed", {
        userId,
        errors: parseResult.errors,
        warnings: parseResult.warnings,
        rawSummary: summarizeRawMessage(body.rawMessage ?? "")
      });
      return jsonResponse(400, {
        status: "REJECTED",
        message: "rawMessage failed parsing during execution validation",
        errors: parseResult.errors,
        warnings: parseResult.warnings
      });
    }

    const validationErrors = validateExecutionRequest(body, accountConfig.accounts, {
      min: lotMin,
      max: lotMax
    }, {
      requireProtectiveLevels
    });

    if (validationErrors.length > 0) {
      return jsonResponse(400, {
        status: "REJECTED",
        message: "Execution validation failed",
        errors: validationErrors
      });
    }

    const service = new ExecutionService(repository);

    const result = await service.execute(userId, {
      ...body,
      riskTrades: accountConfig.riskTrades ?? "all"
    }, parseResult.warnings);
    return jsonResponse(result.status === "EXECUTED" ? 200 : 502, result);
  } catch (error) {
    if (error instanceof DuplicateTradeError) {
      return jsonResponse(409, {
        status: "REJECTED",
        message: "Duplicate trade request blocked"
      });
    }

    console.error("Execute trade failed", error);
    return jsonResponse(500, {
      status: "FAILED",
      message: "Unexpected execution error",
      error: String(error)
    });
  }
};
