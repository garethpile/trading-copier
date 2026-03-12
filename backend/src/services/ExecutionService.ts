import { buildExecutionProvider } from "../providers/ExecutionProviderFactory";
import { TradeRepository, DuplicateTradeError } from "../repositories/TradeRepository";
import { ExecuteTradeRequest, TradeRecord } from "../models/types";
import { makeDedupeKey, makeSignalId } from "../utils/ids";

export class ExecutionService {
  constructor(private readonly repository: TradeRepository) {}

  async execute(
    userId: string,
    req: ExecuteTradeRequest,
    parseWarnings: string[],
    options?: { configOwnerUserId?: string }
  ) {
    const createdAt = new Date().toISOString();
    const signalId = makeSignalId(createdAt);
    const dedupeKey = makeDedupeKey({
      symbol: req.trade.symbol,
      side: req.trade.side,
      orderType: req.trade.orderType,
      entry: req.trade.entry,
      stopLoss: req.trade.stopLoss,
      takeProfits: req.trade.takeProfits,
      targetAccount: req.targetAccount,
      lotSize: req.lotSize
    });

    await this.repository.createDedupeLock(userId, dedupeKey, signalId, createdAt);

    const record: TradeRecord = {
      pk: `USER#${userId}`,
      sk: `SIGNAL#${createdAt}#${signalId}`,
      gsi1pk: `SIGNAL#${signalId}`,
      gsi1sk: createdAt,
      entityType: "TRADE",
      signalId,
      userId,
      rawMessage: req.rawMessage,
      symbol: req.trade.symbol,
      side: req.trade.side,
      orderType: req.trade.orderType,
      entry: req.trade.entry,
      stopLoss: req.trade.stopLoss,
      takeProfits: req.trade.takeProfits,
      comment: req.trade.comment,
      targetAccount: req.targetAccount,
      lotSize: req.lotSize,
      note: req.note,
      status: "EXECUTING",
      dedupeKey,
      parseWarnings,
      provider: "MetaCopier",
      createdAt
    };

    await this.repository.createTrade(record);

    const provider = buildExecutionProvider();
    const configOwnerUserId = options?.configOwnerUserId ?? userId;
    const symbolConfig = await this.repository.getLotSizeConfig(configOwnerUserId);
    const normalizedSymbol = req.trade.symbol.toUpperCase();
    const configuredSymbol = symbolConfig.symbols[normalizedSymbol];
    const destinationBrokerSymbol =
      configuredSymbol?.accountDestinationSymbols?.[req.targetAccount] ||
      configuredSymbol?.destinationBrokerSymbol ||
      normalizedSymbol;
    const tpLevels = req.trade.takeProfits.filter((tp) => Number.isFinite(tp) && tp > 0);
    // MetaCopier enforces requestId <= 999.
    // Reserve a small sequential range so each TP leg has a unique requestId within one request.
    const maxBase = Math.max(0, 999 - Math.max(0, tpLevels.length - 1));
    const requestIdBase = Math.floor(Math.random() * (maxBase + 1));
    const legResults: Array<{
      leg: number;
      takeProfit: number;
      status: "EXECUTED" | "FAILED";
      requestId: number;
      executionId?: string;
      message: string;
      providerResponse?: unknown;
    }> = [];

    const legPromises = tpLevels.map(async (tp, index) => {
      const legNote = req.note ? `TP${index + 1} ${req.note}` : `TP${index + 1}`;
      const requestId = requestIdBase + index;
      const result = await provider.executeTrade({
        symbol: normalizedSymbol,
        destinationBrokerSymbol,
        side: req.trade.side,
        orderType: req.trade.orderType,
        entry: req.trade.entry,
        stopLoss: req.trade.stopLoss,
        takeProfits: [tp],
        lotSize: req.lotSize,
        targetAccount: req.targetAccount,
        note: legNote,
        requestId
      });

      const legRecord: {
        leg: number;
        takeProfit: number;
        status: "EXECUTED" | "FAILED";
        requestId: number;
        message: string;
        executionId?: string;
        providerResponse?: unknown;
      } = {
        leg: index + 1,
        takeProfit: tp,
        status: result.status,
        requestId: result.requestId ?? requestId,
        message: result.message
      };

      if (result.executionId) {
        legRecord.executionId = result.executionId;
      }
      if (result.providerResponse !== undefined) {
        legRecord.providerResponse = result.providerResponse;
      }

      return legRecord;
    });

    const resolvedLegs = await Promise.all(legPromises);
    legResults.push(...resolvedLegs.sort((a, b) => a.leg - b.leg));

    const failedLegs = legResults.filter((leg) => leg.status === "FAILED");
    const successfulLegs = legResults.filter((leg) => leg.status === "EXECUTED");
    const combinedExecutionId = successfulLegs
      .map((leg) => leg.executionId)
      .filter((value): value is string => Boolean(value))
      .join(",");

    if (failedLegs.length === 0) {
      const executedAt = new Date().toISOString();
      await this.repository.updateTradeResult({
        userId,
        signalId,
        createdAt,
        status: "EXECUTED",
        providerResponse: {
          mode: "MULTI_TP_LEGS",
          destinationBrokerSymbol,
          legs: legResults
        },
        executionId: combinedExecutionId || undefined,
        executedAt
      });

      return {
        status: "EXECUTED" as const,
        signalId,
        executionId: combinedExecutionId || undefined,
        provider: "MetaCopier",
        message: `Executed ${successfulLegs.length}/${tpLevels.length} TP legs`,
        providerResponse: {
          mode: "MULTI_TP_LEGS",
          destinationBrokerSymbol,
          legs: legResults
        }
      };
    }

    await this.repository.updateTradeResult({
      userId,
      signalId,
      createdAt,
      status: "FAILED",
      providerResponse: {
        mode: "MULTI_TP_LEGS",
        destinationBrokerSymbol,
        legs: legResults
      },
      errorMessage: `Executed ${successfulLegs.length}/${tpLevels.length} TP legs${failedLegs.length > 0 ? ` - ${failedLegs.map((leg) => `TP${leg.leg}: ${leg.message}`).join(" | ")}` : ""}`
    });

    const legFailureSummary = failedLegs.map((leg) => `TP${leg.leg}: ${leg.message}`).join(" | ");

    return {
      status: "FAILED" as const,
      signalId,
      provider: "MetaCopier",
      message: `Executed ${successfulLegs.length}/${tpLevels.length} TP legs${legFailureSummary ? ` - ${legFailureSummary}` : ""}`,
      providerResponse: {
        mode: "MULTI_TP_LEGS",
        destinationBrokerSymbol,
        legs: legResults
      },
      errors: failedLegs.map((leg) => `TP${leg.leg}: ${leg.message}`)
    };
  }
}

export { DuplicateTradeError };
