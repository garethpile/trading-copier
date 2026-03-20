import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { TradeRepository } from "../repositories/TradeRepository";
import { ExecutionService, DuplicateTradeError } from "../services/ExecutionService";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";
import { ExecuteTradeResolvedRequest } from "../models/types";
import { validateResolvedExecutionRequest } from "../validators/tradeValidator";

const lotMin = Number(process.env.LOT_SIZE_MIN ?? "0.01");
const lotMax = Number(process.env.LOT_SIZE_MAX ?? "50");
const requireProtectiveLevels = (process.env.REQUIRE_PROTECTIVE_LEVELS ?? "true") === "true";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const tableName = process.env.TRADE_SIGNALS_TABLE;
    if (!tableName) {
      return jsonResponse(500, { status: "FAILED", message: "TRADE_SIGNALS_TABLE not configured" });
    }

    const userId = getUserIdFromEvent(event);
    const body = JSON.parse(event.body ?? "{}") as ExecuteTradeResolvedRequest;
    const repository = new TradeRepository(tableName);
    const accountConfig = await repository.getTargetAccountsConfig(userId);

    const validationErrors = validateResolvedExecutionRequest(body, accountConfig.accounts, {
      min: lotMin,
      max: lotMax
    }, {
      requireProtectiveLevels
    });

    if (validationErrors.length > 0) {
      return jsonResponse(400, {
        status: "REJECTED",
        message: "Fast execution validation failed",
        errors: validationErrors
      });
    }

    const service = new ExecutionService(repository);
    const result = await service.executeResolved(userId, body, []);
    return jsonResponse(result.status === "EXECUTED" ? 200 : 502, result);
  } catch (error) {
    if (error instanceof DuplicateTradeError) {
      return jsonResponse(409, {
        status: "REJECTED",
        message: "Duplicate or in-flight trade request blocked",
        signalId: error.existingSignalId
      });
    }

    console.error("Execute trade fast failed", error);
    return jsonResponse(500, {
      status: "FAILED",
      message: "Unexpected fast execution error",
      error: String(error)
    });
  }
};
