import { buildExecutionProvider } from "../providers/ExecutionProviderFactory";
import { TradeRepository, DuplicateTradeError } from "../repositories/TradeRepository";
import { ExecuteTradeRequest, ExecuteTradeResolvedRequest, TradeRecord } from "../models/types";
import { makeDedupeKey, makeSignalId } from "../utils/ids";

type LegResult = {
  leg: number;
  takeProfit: number;
  status: "EXECUTED" | "FAILED";
  requestId: number;
  executionId?: string;
  message: string;
  providerResponse?: unknown;
};

export class ExecutionService {
  constructor(private readonly repository: TradeRepository) {}

  async execute(
    userId: string,
    req: ExecuteTradeRequest,
    parseWarnings: string[],
    options?: { configOwnerUserId?: string }
  ) {
    const configOwnerUserId = options?.configOwnerUserId ?? userId;
    const symbolConfig = await this.repository.getLotSizeConfig(configOwnerUserId);
    const normalizedSymbol = req.trade.symbol.toUpperCase();
    const configuredSymbol = symbolConfig.symbols[normalizedSymbol];
    const destinationBrokerSymbol =
      configuredSymbol?.accountDestinationSymbols?.[req.targetAccount] ||
      configuredSymbol?.destinationBrokerSymbol ||
      normalizedSymbol;

    return this.executeCore(userId, {
      ...req,
      destinationBrokerSymbol
    }, parseWarnings);
  }

  async executeResolved(
    userId: string,
    req: ExecuteTradeResolvedRequest,
    parseWarnings: string[]
  ) {
    return this.executeCore(userId, req, parseWarnings);
  }

  private async executeCore(
    userId: string,
    req: ExecuteTradeResolvedRequest,
    parseWarnings: string[]
  ) {
    const serviceStartedAt = Date.now();
    const createdAt = new Date().toISOString();
    const signalId = makeSignalId(createdAt);
    const dedupeKey = req.dedupeKey ?? makeDedupeKey({
      symbol: req.trade.symbol,
      side: req.trade.side,
      orderType: req.trade.orderType,
      entry: req.trade.entry,
      stopLoss: req.trade.stopLoss,
      takeProfits: req.trade.takeProfits,
      targetAccount: req.targetAccount,
      lotSize: req.lotSize
    });

    const dedupeStartedAt = Date.now();
    await this.repository.createDedupeLock(userId, dedupeKey, signalId, createdAt);
    const dedupeMs = Date.now() - dedupeStartedAt;

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

    const createTradeStartedAt = Date.now();
    await this.repository.createTrade(record);
    const createTradeMs = Date.now() - createTradeStartedAt;

    const destinationBrokerSymbol = req.destinationBrokerSymbol.trim().toUpperCase();
    const executeLegsStartedAt = Date.now();
    const legResults = await this.executeLegs(req, destinationBrokerSymbol);
    const executeLegsMs = Date.now() - executeLegsStartedAt;

    const failedLegs = legResults.filter((leg) => leg.status === "FAILED");
    const successfulLegs = legResults.filter((leg) => leg.status === "EXECUTED");
    const combinedExecutionId = successfulLegs
      .map((leg) => leg.executionId)
      .filter((value): value is string => Boolean(value))
      .join(",");

    const providerResponse: Record<string, unknown> = {
      mode: "MULTI_TP_LEGS",
      destinationBrokerSymbol,
      legs: legResults,
      timings: {
        dedupeMs,
        createTradeMs,
        executeLegsMs,
        serviceMs: Date.now() - serviceStartedAt
      },
      ...(req.mode ? { executionMode: req.mode } : {}),
      ...(req.sourceMessageId ? { sourceMessageId: req.sourceMessageId } : {}),
      ...(req.receivedAt ? { receivedAt: req.receivedAt } : {}),
      ...(req.dedupeKey ? { clientDedupeKey: req.dedupeKey } : {})
    };

    if (failedLegs.length === 0) {
      const executedAt = new Date().toISOString();
      const updateTradeStartedAt = Date.now();
      await this.repository.updateTradeResult({
        userId,
        signalId,
        createdAt,
        status: "EXECUTED",
        providerResponse,
        executionId: combinedExecutionId || undefined,
        executedAt
      });
      const updateTradeMs = Date.now() - updateTradeStartedAt;

      providerResponse.timings = {
        ...(providerResponse.timings as Record<string, number>),
        updateTradeMs,
        totalMs: Date.now() - serviceStartedAt
      };

      return {
        status: "EXECUTED" as const,
        signalId,
        executionId: combinedExecutionId || undefined,
        provider: "MetaCopier",
        message: `Executed ${successfulLegs.length}/${legResults.length} TP legs`,
        providerResponse
      };
    }

    const legFailureSummary = failedLegs.map((leg) => `TP${leg.leg}: ${leg.message}`).join(" | ");
    const partialSuccess = successfulLegs.length > 0;
    const finalStatus = partialSuccess ? "PARTIAL" : "FAILED";
    const updateTradeStartedAt = Date.now();
    await this.repository.updateTradeResult({
      userId,
      signalId,
      createdAt,
      status: finalStatus,
      providerResponse,
      errorMessage: `Executed ${successfulLegs.length}/${legResults.length} TP legs${legFailureSummary ? ` - ${legFailureSummary}` : ""}`
    });
    const updateTradeMs = Date.now() - updateTradeStartedAt;

    providerResponse.timings = {
      ...(providerResponse.timings as Record<string, number>),
      updateTradeMs,
      totalMs: Date.now() - serviceStartedAt
    };

    return {
      status: finalStatus,
      signalId,
      provider: "MetaCopier",
      message: `Executed ${successfulLegs.length}/${legResults.length} TP legs${legFailureSummary ? ` - ${legFailureSummary}` : ""}`,
      providerResponse,
      errors: failedLegs.map((leg) => `TP${leg.leg}: ${leg.message}`)
    };
  }

  private async executeLegs(req: ExecuteTradeResolvedRequest, destinationBrokerSymbol: string): Promise<LegResult[]> {
    const provider = buildExecutionProvider();
    const normalizedSymbol = req.trade.symbol.toUpperCase();
    const tpLevels = req.trade.takeProfits.filter((tp) => Number.isFinite(tp) && tp > 0);
    const maxBase = Math.max(0, 999 - Math.max(0, tpLevels.length - 1));
    const requestIdBase = Math.floor(Math.random() * (maxBase + 1));

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

      const legRecord: LegResult = {
        leg: index + 1,
        takeProfit: tp,
        status: result.status === "EXECUTED" ? "EXECUTED" : "FAILED",
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

    return (await Promise.all(legPromises)).sort((a, b) => a.leg - b.leg);
  }
}

export { DuplicateTradeError };
