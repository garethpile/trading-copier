import { ExecuteTradeRequest, ParsedTrade } from "../models/types";

export const validateParsedTrade = (trade: ParsedTrade): string[] => {
  const errors: string[] = [];

  if (!trade.symbol) errors.push("symbol is required");
  if (trade.side !== "BUY" && trade.side !== "SELL") errors.push("side must be BUY or SELL");
  if (!Number.isFinite(trade.entry)) errors.push("entry must be numeric");
  if (!Number.isFinite(trade.stopLoss)) errors.push("stopLoss must be numeric");
  if (!Array.isArray(trade.takeProfits) || trade.takeProfits.length === 0) {
    errors.push("at least one take profit is required");
  } else if (trade.takeProfits.some((tp) => !Number.isFinite(tp))) {
    errors.push("all take profits must be numeric");
  }

  return errors;
};

export const validateExecutionRequest = (
  req: ExecuteTradeRequest,
  allowedAccounts: string[],
  lotRange: { min: number; max: number },
  options?: { requireProtectiveLevels?: boolean }
): string[] => {
  const errors: string[] = [];

  if (!req.rawMessage?.trim()) errors.push("rawMessage is required");
  errors.push(...validateParsedTrade(req.trade));

  if (!allowedAccounts.includes(req.targetAccount)) {
    errors.push("targetAccount is not allowed");
  }

  if (!Number.isFinite(req.lotSize)) {
    errors.push("lotSize must be numeric");
  } else if (req.lotSize < lotRange.min || req.lotSize > lotRange.max) {
    errors.push(`lotSize must be between ${lotRange.min} and ${lotRange.max}`);
  }

  const requireProtectiveLevels = options?.requireProtectiveLevels ?? true;
  if (requireProtectiveLevels) {
    if (!Number.isFinite(req.trade.stopLoss) || req.trade.stopLoss <= 0) {
      errors.push("stopLoss must be greater than 0 for execution safety");
    }
    if (!Array.isArray(req.trade.takeProfits) || req.trade.takeProfits.length === 0) {
      errors.push("at least one take profit is required for execution safety");
    } else if (!req.trade.takeProfits.some((tp) => Number.isFinite(tp) && tp > 0)) {
      errors.push("at least one take profit must be greater than 0 for execution safety");
    }
  }

  return errors;
};
