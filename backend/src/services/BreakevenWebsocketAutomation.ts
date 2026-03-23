import { Client } from "@stomp/stompjs";
import WebSocket from "ws";
import axios from "axios";
import { TradeRepository } from "../repositories/TradeRepository";
import { TradeRecord } from "../models/types";

type GenericObject = Record<string, unknown>;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const toObj = (value: unknown): GenericObject | undefined =>
  value && typeof value === "object" ? (value as GenericObject) : undefined;
const stableJson = (value: unknown): string => JSON.stringify(value);

const extractRequestId = (position: GenericObject): number | undefined => {
  const providerResponse =
    position.providerResponse && typeof position.providerResponse === "object"
      ? (position.providerResponse as GenericObject)
      : undefined;
  const nested = asNumber(providerResponse?.requestId);
  if (nested !== undefined) return Math.floor(nested);

  const direct = asNumber(position.requestId ?? position.clientRequestId ?? position.magicNumber);
  if (direct !== undefined) return Math.floor(direct);

  const comment = asString(position.comment);
  if (!comment) return undefined;

  const apiMatch = comment.match(/API\|(\d+)\|/);
  if (apiMatch) return Number(apiMatch[1]);

  return undefined;
};

const extractPositionId = (position: GenericObject): string | undefined =>
  asString(position.id ?? position.positionId ?? position.ticket ?? position.orderId);

const extractOrderType = (position: GenericObject, side: "BUY" | "SELL"): "Buy" | "Sell" => {
  const raw = asString(position.orderType ?? position.dealType ?? position.side ?? position.type)?.toLowerCase();
  if (raw?.includes("sell")) return "Sell";
  if (raw?.includes("buy")) return "Buy";
  return side === "BUY" ? "Buy" : "Sell";
};

const toArray = (value: unknown): GenericObject[] => (Array.isArray(value) ? (value as GenericObject[]) : []);
const normalizeSymbol = (value: string): string => value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
const MAX_ACCOUNT_HISTORY_EVENTS = 500;
const MAX_TRADE_HISTORY_EVENTS = 50;
const MAX_TRADE_OPEN_POSITIONS = 20;

const extractPositionSymbol = (position: GenericObject): string | undefined => {
  const symbol = asString(position.symbol ?? position.instrument ?? position.asset);
  return symbol ? normalizeSymbol(symbol) : undefined;
};

const extractPositionSide = (position: GenericObject): "BUY" | "SELL" | undefined => {
  const raw = asString(position.orderType ?? position.dealType ?? position.side ?? position.type)?.toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("buy")) return "BUY";
  if (raw.includes("sell")) return "SELL";
  return undefined;
};

const extractEventTimeMs = (value: GenericObject): number | undefined => {
  const candidates = [
    asString(value.closeTime),
    asString(value.closedAt),
    asString(value.eventTime),
    asString(value.updatedAt),
    asString(value.time),
    asString(value.openTime),
    asString(value.openedAt)
  ].filter((item): item is string => Boolean(item));

  for (const raw of candidates) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const extractTakeProfit = (position: GenericObject): number | undefined =>
  asNumber(position.takeProfit ?? position.tp);
const PRICE_VERIFY_TOLERANCE = 0.02;
const valuesMatch = (expected: number, actual: number | undefined): boolean =>
  actual !== undefined && Math.abs(actual - expected) <= PRICE_VERIFY_TOLERANCE;
const extractOpenTimeMs = (position: GenericObject): number | undefined => {
  const raw = asString(position.openTime ?? position.openedAt ?? position.time);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const extractLatestClosePrice = (events: GenericObject[]): number | undefined => {
  if (events.length === 0) return undefined;
  const sorted = [...events].sort((a, b) => {
    const at = extractEventTimeMs(a) ?? 0;
    const bt = extractEventTimeMs(b) ?? 0;
    return at - bt;
  });
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const event = sorted[i];
    const closePrice = asNumber(event.closePrice ?? event.closedPrice ?? event.price);
    if (closePrice !== undefined && Number.isFinite(closePrice)) return closePrice;
  }
  return undefined;
};

const pickMatchedOpenPosition = (input: {
  leg: GenericObject;
  matchedOpenPositions: GenericObject[];
  usedPositionIds: Set<string>;
}): GenericObject | undefined => {
  const requestId = extractRequestId(input.leg);
  const available = input.matchedOpenPositions.filter((position) => {
    const positionId = extractPositionId(position);
    return !positionId || !input.usedPositionIds.has(positionId);
  });
  if (available.length === 0) return undefined;

  if (requestId !== undefined) {
    const byRequestId = available.find((position) => extractRequestId(position) === requestId);
    if (byRequestId) return byRequestId;
  }

  const legTakeProfit = asNumber(input.leg.takeProfit);
  if (legTakeProfit !== undefined && Number.isFinite(legTakeProfit)) {
    const tpMatches = available
      .map((position) => ({
        position,
        gap: Math.abs((extractTakeProfit(position) ?? Number.NaN) - legTakeProfit)
      }))
      .filter((item) => Number.isFinite(item.gap))
      .sort((a, b) => a.gap - b.gap);
    if (tpMatches.length > 0 && tpMatches[0].gap <= 1e-6) {
      return tpMatches[0].position;
    }
    if (tpMatches.length > 0) {
      return tpMatches[0].position;
    }
  }

  const sortedByOpenTime = [...available].sort((a, b) => {
    const at = extractOpenTimeMs(a) ?? 0;
    const bt = extractOpenTimeMs(b) ?? 0;
    return at - bt;
  });
  return sortedByOpenTime[0];
};

export class BreakevenWebsocketAutomation {
  private readonly apiKey: string;
  private readonly userEmail?: string;
  private readonly socketUrl: string;
  private readonly tradingBaseUrl: string;
  private readonly automationUserId: string;
  private readonly requestMatchWindowMs: number;
  private readonly openPositionsByAccount = new Map<string, GenericObject[]>();
  private readonly historyByAccount = new Map<string, GenericObject[]>();
  private readonly pendingAccountIds = new Set<string>();
  private evaluationTimer?: NodeJS.Timeout;
  private evaluating = false;

  constructor(private readonly repository: TradeRepository) {
    this.apiKey = process.env.METACOPIER_API_KEY ?? "";
    this.userEmail = process.env.METACOPIER_USER_EMAIL?.trim() || undefined;
    this.socketUrl = process.env.METACOPIER_SOCKET_URL ?? "wss://api.metacopier.io/ws/api/v1";
    this.tradingBaseUrl = process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io";
    this.automationUserId = process.env.AUTOMATION_USER_ID ?? process.env.LOCAL_USER_ID ?? "local-user";
    this.requestMatchWindowMs = Math.max(
      60_000,
      Number(process.env.REQUEST_MATCH_WINDOW_MS ?? String(15 * 60 * 1000))
    );
  }

  start(): void {
    if (!this.apiKey) {
      throw new Error("METACOPIER_API_KEY is required for websocket automation");
    }

    const client = new Client({
      brokerURL: this.socketUrl,
      connectHeaders: {
        "api-key": this.apiKey
      },
      debug: (line) => {
        if ((process.env.BREAKEVEN_DEBUG ?? "false") === "true") {
          console.log(`[WS] ${line}`);
        }
      },
      reconnectDelay: 5000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      webSocketFactory: () => new WebSocket(this.socketUrl)
    });

    client.onConnect = () => {
      console.log("Breakeven automation websocket connected");

      client.subscribe("/user/queue/accounts/changes", (message) => {
        this.handleSocketMessage(message.body);
      });

      const accountIds = (process.env.ALLOWED_TARGET_ACCOUNTS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      client.publish({
        destination: "/app/subscribe",
        body: JSON.stringify({ accountIds })
      });
    };

    client.onStompError = (frame) => {
      console.error("WS STOMP error", frame.headers["message"], frame.body);
    };

    client.activate();
  }

  private handleSocketMessage(rawBody: string): void {
    try {
      const payload = JSON.parse(rawBody) as { type?: string; data?: GenericObject };
      const type = payload.type;
      const data = payload.data ?? {};
      const accountId = asString(data.accountId);
      if (!accountId) return;

      if (type === "UpdateOpenPositionsDTO") {
        this.openPositionsByAccount.set(accountId, toArray(data.openPositions));
        this.scheduleEvaluation(accountId);
        return;
      }

      if (type === "UpdateHistoryDTO") {
        const receivedAt = new Date().toISOString();
        const incoming = toArray(data.history).map((entry) => ({
          ...entry,
          socketReceivedAt: receivedAt
        }));
        if (incoming.length === 0) return;
        const existing = this.historyByAccount.get(accountId) ?? [];
        const merged = [...existing, ...incoming];
        const bounded = merged.slice(-MAX_ACCOUNT_HISTORY_EVENTS);
        this.historyByAccount.set(accountId, bounded);
        this.scheduleEvaluation(accountId);
        return;
      }
    } catch (error) {
      console.error("Failed to parse websocket payload", String(error));
    }
  }

  private scheduleEvaluation(accountId: string): void {
    this.pendingAccountIds.add(accountId);
    if (this.evaluationTimer) return;
    this.evaluationTimer = setTimeout(() => {
      this.evaluationTimer = undefined;
      void this.evaluateAndMoveBreakEven();
    }, 250);
  }

  private async evaluateAndMoveBreakEven(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;

    try {
      const accountIds =
        this.pendingAccountIds.size > 0 ? new Set(this.pendingAccountIds) : undefined;
      this.pendingAccountIds.clear();
      const trades = await this.repository.getHistory(this.automationUserId, 100);
      for (const trade of trades) {
        if (accountIds && !accountIds.has(trade.targetAccount)) continue;
        await this.processTrade(trade);
      }
    } catch (error) {
      console.error("Breakeven evaluation failed", String(error));
    } finally {
      this.evaluating = false;
      if (this.pendingAccountIds.size > 0 && !this.evaluationTimer) {
        this.scheduleEvaluation(Array.from(this.pendingAccountIds)[0]);
      }
    }
  }

  private async processTrade(trade: TradeRecord): Promise<void> {
    const providerResponse = (trade.providerResponse as GenericObject | undefined) ?? {};
    if (providerResponse.mode !== "MULTI_TP_LEGS") return;

    const legs = toArray(providerResponse.legs);
    if (legs.length < 2) return;
    const openPositions = this.openPositionsByAccount.get(trade.targetAccount) ?? [];
    const historyEvents = this.historyByAccount.get(trade.targetAccount) ?? [];
    const tradeCreatedMs = Date.parse(trade.createdAt);
    const expectedSymbols = new Set(
      [
        normalizeSymbol(trade.symbol),
        asString(providerResponse.destinationBrokerSymbol)
          ? normalizeSymbol(String(providerResponse.destinationBrokerSymbol))
          : undefined
      ].filter((v): v is string => Boolean(v))
    );
    const legRequestIds = new Set(
      legs.map((leg) => extractRequestId(leg)).filter((v): v is number => v !== undefined)
    );
    const matchedOpenPositions = openPositions.filter((position) => {
      const side = extractPositionSide(position);
      const symbol = extractPositionSymbol(position);
      if (!(side === trade.side && !!symbol && expectedSymbols.has(symbol))) return false;
      const requestId = extractRequestId(position);
      return legRequestIds.size > 0 && requestId !== undefined && legRequestIds.has(requestId);
    });
    const matchedHistoryEvents = historyEvents.filter((event) => {
      const side = extractPositionSide(event);
      const symbol = extractPositionSymbol(event);
      if (!(side === trade.side && !!symbol && expectedSymbols.has(symbol))) return false;
      if (!Number.isFinite(tradeCreatedMs)) return true;
      const eventMs = extractEventTimeMs(event);
      if (eventMs === undefined || !Number.isFinite(eventMs)) return true;
      return Math.abs(eventMs - tradeCreatedMs) <= this.requestMatchWindowMs;
    });

    const usedPositionIds = new Set<string>();
    const normalizedLegs: GenericObject[] = legs.map((leg) => {
      const requestId = extractRequestId(leg);
      const originalStatus = asString(leg["status"])?.toUpperCase();
      const matchedPosition = pickMatchedOpenPosition({
        leg,
        matchedOpenPositions,
        usedPositionIds
      });
      const openMatches = matchedPosition ? [matchedPosition] : [];
      const matchedPositionId = matchedPosition ? extractPositionId(matchedPosition) : undefined;
      if (matchedPositionId) {
        usedPositionIds.add(matchedPositionId);
      }
      const historyMatches =
        requestId !== undefined
          ? matchedHistoryEvents.filter((event) => extractRequestId(event) === requestId)
          : [];
      let runtimeState: "OPEN" | "CLOSED" | "UNKNOWN" = "UNKNOWN";

      if (openMatches.length > 0) {
        runtimeState = "OPEN";
      } else if (originalStatus === "FAILED") {
        runtimeState = "CLOSED";
      } else if (requestId !== undefined) {
        if (openMatches.length > 0) {
          runtimeState = "OPEN";
        } else if (originalStatus === "EXECUTED" && historyMatches.length > 0) {
          runtimeState = "CLOSED";
        }
      }
      const previousRuntimeState = asString(leg["runtimeState"])?.toUpperCase();
      if (
        runtimeState === "UNKNOWN" &&
        (previousRuntimeState === "OPEN" || previousRuntimeState === "CLOSED")
      ) {
        runtimeState = previousRuntimeState;
      }
      const normalizedStatus =
        originalStatus === "EXECUTED"
          ? "EXECUTED"
          : originalStatus === "FAILED"
            ? "FAILED"
            : originalStatus ?? "UNKNOWN";

      return {
        ...leg,
        ...(requestId !== undefined ? { requestId } : {}),
        status: normalizedStatus,
        runtimePayload: {
          matchedOpenPositions: openMatches.slice(0, MAX_TRADE_OPEN_POSITIONS),
          matchedHistoryEvents: historyMatches.slice(-MAX_TRADE_HISTORY_EVENTS)
        },
        runtimeState
      };
    });

    const closedExecutedLegs = normalizedLegs.filter(
      (leg) => asString(leg["status"]) === "EXECUTED" && asString(leg["runtimeState"]) === "CLOSED"
    );
    const openExecutedLegs = normalizedLegs.filter(
      (leg) => asString(leg["status"]) === "EXECUTED" && asString(leg["runtimeState"]) === "OPEN"
    );
    const triggerLeg = closedExecutedLegs[0];
    const triggerRequestId = triggerLeg ? extractRequestId(triggerLeg) : undefined;
    const breakeven = (providerResponse.breakeven as GenericObject | undefined) ?? {};
    const finalLegTrail = (providerResponse.finalLegTrail as GenericObject | undefined) ?? {};
    const signalMagnitudeRebase = (providerResponse.signalMagnitudeRebase as GenericObject | undefined) ?? {};
    let nextErrorMessage = trade.errorMessage;
    let nextSignalMagnitudeRebase = signalMagnitudeRebase;
    const runtimeAdoption = (providerResponse.runtimeAdoption as GenericObject | undefined) ?? {};

    if (openExecutedLegs.length > 0 && asString(signalMagnitudeRebase.status) !== "COMPLETED") {
      const movedLegs: Array<{ leg: number; requestId: number; newStopLoss: number; newTakeProfit: number }> = [];
      const failedLegs: Array<{ leg: number; reason: string }> = [];
      const riskDistance = Math.abs(trade.entry - trade.stopLoss);

      for (const leg of openExecutedLegs) {
        const legNo = asNumber(leg.leg);
        const requestId = extractRequestId(leg);
        if (!legNo || requestId === undefined) {
          failedLegs.push({ leg: legNo ?? -1, reason: "missing leg/requestId" });
          continue;
        }
        const signalTp = trade.takeProfits[legNo - 1];
        if (!Number.isFinite(signalTp) || !Number.isFinite(riskDistance)) {
          failedLegs.push({ leg: legNo, reason: "missing signal TP or SL distance" });
          continue;
        }

        const legOpenPosition = toArray(toObj(leg.runtimePayload)?.matchedOpenPositions)[0];
        const openPosition =
          matchedOpenPositions.find((position) => extractRequestId(position) === requestId) ?? legOpenPosition;
        const openPrice = openPosition ? asNumber(openPosition.openPrice) : undefined;
        if (!openPosition || openPrice === undefined || !Number.isFinite(openPrice)) {
          failedLegs.push({ leg: legNo, reason: "open position/openPrice unavailable" });
          continue;
        }

        const newTakeProfit = openPrice + (signalTp - trade.entry);
        const newStopLoss = trade.side === "BUY" ? openPrice - riskDistance : openPrice + riskDistance;
        const modifyResult = await this.modifyPositionTargets({
          accountId: trade.targetAccount,
          position: openPosition,
          side: trade.side,
          stopLoss: newStopLoss,
          takeProfit: newTakeProfit
        });

        if (!modifyResult.ok) {
          const reason = modifyResult.verifyDetails
            ? `${modifyResult.reason}: ${JSON.stringify(modifyResult.verifyDetails)}`
            : modifyResult.reason;
          failedLegs.push({ leg: legNo, reason });
          continue;
        }

        leg.currentStopLoss = modifyResult.verifiedStopLoss;
        leg.takeProfit = modifyResult.verifiedTakeProfit;
        movedLegs.push({
          leg: legNo,
          requestId,
          newStopLoss: modifyResult.verifiedStopLoss,
          newTakeProfit: modifyResult.verifiedTakeProfit
        });
      }

      if (movedLegs.length > 0 || failedLegs.length > 0) {
        nextSignalMagnitudeRebase = {
          status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
          triggeredAt: new Date().toISOString(),
          movedLegs,
          failedLegs
        };
        if (failedLegs.length > 0) {
          nextErrorMessage = `Signal magnitude rebase failed for ${failedLegs.length} leg(s)`;
        } else if (nextErrorMessage?.startsWith("Signal magnitude rebase failed")) {
          nextErrorMessage = undefined;
        }
      }
    }

    let nextBreakeven = breakeven;
    if (triggerLeg && breakeven.status !== "COMPLETED") {
      const movedLegs: Array<{ leg: number; positionId: string }> = [];
      const failedLegs: Array<{ leg: number; reason: string }> = [];

      for (const leg of normalizedLegs) {
        const legNo = asNumber(leg["leg"]);
        if (!legNo) continue;
        if (asString(leg["status"]) !== "EXECUTED") continue;
        if (asString(leg["runtimeState"]) !== "OPEN") continue;

        const legRequestId = extractRequestId(leg);
        if (legRequestId === undefined) {
          failedLegs.push({ leg: legNo, reason: "missing requestId" });
          continue;
        }
        if (triggerRequestId !== undefined && legRequestId === triggerRequestId) continue;

        const legOpenPosition = toArray(toObj(leg.runtimePayload)?.matchedOpenPositions)[0];
        const openPosition =
          matchedOpenPositions.find((position) => extractRequestId(position) === legRequestId) ?? legOpenPosition;
        if (!openPosition) {
          failedLegs.push({ leg: legNo, reason: "position not currently open" });
          continue;
        }

        const positionId = extractPositionId(openPosition);
        if (!positionId) {
          failedLegs.push({ leg: legNo, reason: "missing position id" });
          continue;
        }

        const modifyResult = await this.modifyPositionStopLossToBreakEven({
          accountId: trade.targetAccount,
          position: openPosition,
          side: trade.side,
          breakEvenPrice: trade.entry
        });

        if (modifyResult.ok) {
          leg.currentStopLoss = modifyResult.verifiedStopLoss;
          movedLegs.push({ leg: legNo, positionId });
        } else {
          const reason = modifyResult.verifyDetails
            ? `${modifyResult.reason}: ${JSON.stringify(modifyResult.verifyDetails)}`
            : modifyResult.reason;
          failedLegs.push({ leg: legNo, reason });
        }
      }

      if (movedLegs.length > 0 || failedLegs.length > 0) {
        nextBreakeven = {
          status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
          ...(triggerRequestId !== undefined ? { triggeredByRequestId: triggerRequestId } : {}),
          triggeredAt: new Date().toISOString(),
          movedLegs,
          failedLegs
        };
        if (failedLegs.length > 0) {
          nextErrorMessage = `BE move failed for ${failedLegs.length} leg(s)`;
        } else if (nextErrorMessage && nextErrorMessage.startsWith("BE move failed")) {
          nextErrorMessage = undefined;
        }
      }
    }

    let nextFinalLegTrail = finalLegTrail;
    const leg2 = normalizedLegs.find(
      (leg) =>
        asNumber(leg.leg) === 2 &&
        asString(leg.status) === "EXECUTED" &&
        asString(leg.runtimeState) === "CLOSED"
    );
    if (openExecutedLegs.length > 0 && leg2 && asString(finalLegTrail.status) !== "COMPLETED") {
      const leg2HistoryEvents = toArray(toObj(leg2.runtimePayload)?.matchedHistoryEvents);
      const leg2ClosePrice = extractLatestClosePrice(leg2HistoryEvents) ?? asNumber(leg2.takeProfit);
      if (leg2ClosePrice === undefined || !Number.isFinite(leg2ClosePrice)) {
        nextFinalLegTrail = {
          status: "FAILED",
          triggeredAt: new Date().toISOString(),
          reason: "leg2 close price unavailable"
        };
      } else {
        const targetStopLoss = trade.entry + (leg2ClosePrice - trade.entry) / 2;
        const movedLegs: Array<{ leg: number; requestId: number; newStopLoss: number }> = [];
        const failedLegs: Array<{ leg: number; reason: string }> = [];
        for (const openLeg of openExecutedLegs) {
          const legNo = asNumber(openLeg.leg);
          const legRequestId = extractRequestId(openLeg);
          if (!legNo || legRequestId === undefined) {
            failedLegs.push({ leg: legNo ?? -1, reason: "missing leg/requestId" });
            continue;
          }
          const openLegPosition = toArray(toObj(openLeg.runtimePayload)?.matchedOpenPositions)[0];
          const openPosition =
            matchedOpenPositions.find((position) => extractRequestId(position) === legRequestId) ?? openLegPosition;
          if (!openPosition) {
            failedLegs.push({ leg: legNo, reason: "open position not found" });
            continue;
          }
          const moved = await this.modifyPositionStopLossToBreakEven({
            accountId: trade.targetAccount,
            position: openPosition,
            side: trade.side,
            breakEvenPrice: targetStopLoss
          });
          if (!moved.ok) {
            const reason = moved.verifyDetails
              ? `${moved.reason}: ${JSON.stringify(moved.verifyDetails)}`
              : moved.reason;
            failedLegs.push({ leg: legNo, reason });
            continue;
          }
          openLeg.currentStopLoss = moved.verifiedStopLoss;
          movedLegs.push({ leg: legNo, requestId: legRequestId, newStopLoss: moved.verifiedStopLoss });
        }

        nextFinalLegTrail = {
          status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
          triggeredAt: new Date().toISOString(),
          sourceLeg: 2,
          sourceClosePrice: leg2ClosePrice,
          targetStopLoss,
          movedLegs,
          failedLegs
        };
        if (failedLegs.length > 0) {
          nextErrorMessage = "Final leg SL move failed";
        } else if (nextErrorMessage === "Final leg SL move failed") {
          nextErrorMessage = undefined;
        }
      }
    }

    const updatedProviderResponseCore: GenericObject = {
      ...providerResponse,
      legs: normalizedLegs,
      runtimePayload: {
        matchedOpenPositions: matchedOpenPositions.slice(0, MAX_TRADE_OPEN_POSITIONS),
        matchedHistoryEvents: matchedHistoryEvents.slice(-MAX_TRADE_HISTORY_EVENTS)
      },
      signalMagnitudeRebase: nextSignalMagnitudeRebase,
      breakeven: nextBreakeven,
      finalLegTrail: nextFinalLegTrail,
      runtimeAdoption
    };

    const { lastLiveSyncAt: _ignoredLastLiveSyncAt, ...currentComparable } = providerResponse;
    const providerResponseChanged = stableJson(currentComparable) !== stableJson(updatedProviderResponseCore);
    const errorChanged = (nextErrorMessage ?? null) !== (trade.errorMessage ?? null);
    if (!(providerResponseChanged || errorChanged)) return;

    const updatedProviderResponse: GenericObject = {
      ...updatedProviderResponseCore,
      lastLiveSyncAt: new Date().toISOString()
    };

    await this.repository.updateProviderResponse({
      userId: trade.userId,
      signalId: trade.signalId,
      createdAt: trade.createdAt,
      providerResponse: updatedProviderResponse,
      errorMessage: nextErrorMessage
    });
  }

  private async modifyPositionTargets(input: {
    accountId: string;
    position: GenericObject;
    side: "BUY" | "SELL";
    stopLoss: number;
    takeProfit: number;
  }): Promise<
    | { ok: true; verifiedStopLoss: number; verifiedTakeProfit: number }
    | { ok: false; reason: string; verifyDetails?: GenericObject }
  > {
    const positionId = extractPositionId(input.position);
    if (!positionId) {
      return { ok: false, reason: "position id missing" };
    }

    const symbol = asString(input.position.symbol);
    const volume = asNumber(input.position.volume);
    const openPrice = asNumber(input.position.openPrice) ?? 0;

    if (!symbol || volume === undefined) {
      return { ok: false, reason: "position missing symbol/volume" };
    }

    const requestId = Math.floor(Math.random() * 1000);
    const orderType = extractOrderType(input.position, input.side);
    const headers: Record<string, string> = {
      "X-API-KEY": this.apiKey,
      "Content-Type": "application/json"
    };
    if (this.userEmail) {
      headers["X-User-Email"] = this.userEmail;
    }

    try {
      await axios.put(
        `${this.tradingBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.accountId}/positions/${positionId}`,
        {
          symbol,
          orderType,
          openPrice,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfit,
          volume,
          requestId
        },
        {
          timeout: 30000,
          headers,
          validateStatus: (status) => status === 204
        }
      );

      const refresh = await axios.get(
        `${this.tradingBaseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.accountId}/positions`,
        {
          timeout: 30000,
          headers
        }
      );
      const body = refresh.data as unknown;
      const bodyObj = toObj(body);
      const positions = Array.isArray(body)
        ? (body as GenericObject[])
        : toArray(bodyObj?.openPositions ?? bodyObj?.positions ?? bodyObj?.items);
      const refreshedPosition = positions.find((position) => extractPositionId(position) === positionId);
      if (!refreshedPosition) {
        return { ok: false, reason: "post-update position missing" };
      }
      const verifiedStopLoss = asNumber(refreshedPosition.stopLoss ?? refreshedPosition.sl);
      const verifiedTakeProfit = extractTakeProfit(refreshedPosition);
      if (!valuesMatch(input.stopLoss, verifiedStopLoss) || !valuesMatch(input.takeProfit, verifiedTakeProfit)) {
        return {
          ok: false,
          reason: "post-update verification mismatch",
          verifyDetails: {
            positionId,
            expectedStopLoss: input.stopLoss,
            actualStopLoss: verifiedStopLoss,
            expectedTakeProfit: input.takeProfit,
            actualTakeProfit: verifiedTakeProfit
          }
        };
      }
      return {
        ok: true,
        verifiedStopLoss: verifiedStopLoss as number,
        verifiedTakeProfit: verifiedTakeProfit as number
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          ok: false,
          reason: `HTTP ${error.response?.status ?? "network_error"}`
        };
      }
      return { ok: false, reason: String(error) };
    }
  }

  private async modifyPositionStopLossToBreakEven(input: {
    accountId: string;
    position: GenericObject;
    side: "BUY" | "SELL";
    breakEvenPrice: number;
  }): Promise<
    | { ok: true; verifiedStopLoss: number; verifiedTakeProfit: number }
    | { ok: false; reason: string; verifyDetails?: GenericObject }
  > {
    return this.modifyPositionTargets({
      accountId: input.accountId,
      position: input.position,
      side: input.side,
      stopLoss: input.breakEvenPrice,
      takeProfit: asNumber(input.position.takeProfit) ?? 0
    });
  }
}
