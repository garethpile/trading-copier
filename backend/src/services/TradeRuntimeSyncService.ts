import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { TradeRecord } from "../models/types";
import { TradeRepository } from "../repositories/TradeRepository";

type Obj = Record<string, unknown>;

interface MetaCopierSecret {
  apiKey?: string;
  userEmail?: string;
}

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

const toObj = (value: unknown): Obj | undefined =>
  value && typeof value === "object" ? (value as Obj) : undefined;

const toArray = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);

const extractRequestId = (position: Obj): number | undefined => {
  const nested = asNumber(position.providerResponse && toObj(position.providerResponse)?.requestId);
  if (nested !== undefined) return Math.floor(nested);

  const direct = asNumber(position.requestId ?? position.clientRequestId ?? position.magicNumber);
  if (direct !== undefined) return Math.floor(direct);

  const comment = asString(position.comment);
  if (!comment) return undefined;

  const apiMatch = comment.match(/API\|(\d+)\|/);
  if (apiMatch) return Number(apiMatch[1]);

  const anyNum = comment.match(/(\d{1,3})/);
  if (anyNum) return Number(anyNum[1]);

  return undefined;
};

const extractPositionId = (position: Obj): string | undefined =>
  asString(position.id ?? position.positionId ?? position.ticket ?? position.orderId);

const extractStopLoss = (position: Obj): number | undefined => asNumber(position.stopLoss ?? position.sl);
const extractTakeProfit = (position: Obj): number | undefined => asNumber(position.takeProfit ?? position.tp);
const PRICE_VERIFY_TOLERANCE = 0.02;
const valuesMatch = (expected: number, actual: number | undefined): boolean =>
  actual !== undefined && Math.abs(actual - expected) <= PRICE_VERIFY_TOLERANCE;
const extractOpenTimeMs = (position: Obj): number | undefined => {
  const raw = asString(position.openTime ?? position.openedAt ?? position.time);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const extractEventTimeMs = (value: Obj): number | undefined => {
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

const extractLatestClosePrice = (events: Obj[]): number | undefined => {
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
  leg: Obj;
  matchedOpenPositions: Obj[];
  usedPositionIds: Set<string>;
}): Obj | undefined => {
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

const extractOrderType = (position: Obj, side: "BUY" | "SELL"): "Buy" | "Sell" => {
  const raw = asString(position.orderType ?? position.dealType ?? position.side ?? position.type)?.toLowerCase();
  if (raw?.includes("sell")) return "Sell";
  if (raw?.includes("buy")) return "Buy";
  return side === "BUY" ? "Buy" : "Sell";
};
const MAX_TRADE_OPEN_POSITIONS = 20;
const MAX_TRADE_HISTORY_EVENTS = 50;

const normalizeSymbol = (value: string): string => value.replace(/[^A-Z0-9]/gi, "").toUpperCase();

const extractPositionSymbol = (position: Obj): string | undefined => {
  const symbol = asString(position.symbol ?? position.instrument ?? position.asset);
  return symbol ? normalizeSymbol(symbol) : undefined;
};

const extractPositionSide = (position: Obj): "BUY" | "SELL" | undefined => {
  const raw = asString(position.orderType ?? position.dealType ?? position.side ?? position.type)?.toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("buy")) return "BUY";
  if (raw.includes("sell")) return "SELL";
  return undefined;
};

export class TradeRuntimeSyncService {
  private readonly secretsClient = new SecretsManagerClient({});
  private secretCache?: MetaCopierSecret;
  private readonly baseUrl: string;
  private readonly globalBaseUrl: string;
  private readonly secretArn: string;
  private readonly envApiKey: string;
  private readonly envUserEmail?: string;
  private readonly requestTimeoutMs: number;
  private readonly requestMatchWindowMs: number;

  constructor(private readonly repository: TradeRepository) {
    this.baseUrl = process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io";
    this.globalBaseUrl = process.env.METACOPIER_GLOBAL_BASE_URL ?? "https://api.metacopier.io";
    this.secretArn = process.env.METACOPIER_SECRET_ARN ?? "";
    this.envApiKey = process.env.METACOPIER_API_KEY?.trim() ?? "";
    this.envUserEmail = process.env.METACOPIER_USER_EMAIL?.trim() || undefined;
    this.requestTimeoutMs = Number(process.env.METACOPIER_REQUEST_TIMEOUT_MS ?? "3000");
    this.requestMatchWindowMs = Math.max(
      60_000,
      Number(process.env.REQUEST_MATCH_WINDOW_MS ?? String(15 * 60 * 1000))
    );
  }

  private nextRequestId(): number {
    // MetaCopier validates requestId <= 999.
    return Math.floor(Math.random() * 1000);
  }

  private async getSecret(): Promise<MetaCopierSecret> {
    if (this.secretCache) return this.secretCache;
    if (!this.secretArn) return {};
    const out = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
    if (!out.SecretString) return {};
    this.secretCache = JSON.parse(out.SecretString) as MetaCopierSecret;
    return this.secretCache;
  }

  private async getCredentials(): Promise<{ apiKey: string; userEmail?: string } | undefined> {
    if (this.envApiKey) return { apiKey: this.envApiKey, userEmail: this.envUserEmail };
    const secret = await this.getSecret();
    const apiKey = secret.apiKey?.trim();
    if (!apiKey) return undefined;
    // Keep runtime sync auth aligned with execute-trade provider behavior:
    // only send X-User-Email when explicitly configured via environment.
    return { apiKey, userEmail: this.envUserEmail };
  }

  private async headers(): Promise<Record<string, string> | undefined> {
    const creds = await this.getCredentials();
    if (!creds) return undefined;
    return {
      "X-API-KEY": creds.apiKey,
      ...(creds.userEmail ? { "X-User-Email": creds.userEmail } : {}),
      "Content-Type": "application/json"
    };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, this.requestTimeoutMs));
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loadOpenPositionsByAccount(
    accountIds: string[]
  ): Promise<Map<string, { ok: boolean; positions: Obj[] }>> {
    const map = new Map<string, { ok: boolean; positions: Obj[] }>();
    const headers = await this.headers();
    if (!headers) {
      console.error("Trade runtime sync skipped: missing MetaCopier credentials");
      return map;
    }

    await Promise.all(
      accountIds.map(async (accountId) => {
        const hosts = Array.from(new Set([this.baseUrl, this.globalBaseUrl].map((v) => v.replace(/\/$/, ""))));
        const endpointCandidates = hosts.flatMap((host) => [
          `${host}/rest/api/v1/accounts/${accountId}/positions`,
          `${host}/rest/api/v1/accounts/${accountId}/open-positions`
        ]);

        const failures: string[] = [];
        for (const endpoint of endpointCandidates) {
          try {
            const res = await this.fetchJson(endpoint, { method: "GET", headers });
            if (!res.ok) {
              failures.push(`${endpoint} -> HTTP ${res.status}`);
              continue;
            }

            const bodyObj = toObj(res.body);
            const positions = Array.isArray(res.body)
              ? (res.body as Obj[])
              : toArray(bodyObj?.openPositions ?? bodyObj?.positions ?? bodyObj?.items);
            map.set(accountId, { ok: true, positions });
            return;
          } catch (error) {
            failures.push(`${endpoint} -> ${String(error)}`);
          }
        }

        console.error("Trade runtime sync: unable to load open positions", {
          accountId,
          attempts: failures
        });
        map.set(accountId, { ok: false, positions: [] });
      })
    );

    return map;
  }

  private async modifyPositionTargets(input: {
    accountId: string;
    position: Obj;
    side: "BUY" | "SELL";
    stopLoss: number;
    takeProfit: number;
  }): Promise<
    | { ok: true; verifiedStopLoss: number; verifiedTakeProfit: number }
    | { ok: false; reason: string; verifyDetails?: Obj }
  > {
    const positionId = extractPositionId(input.position);
    if (!positionId) return { ok: false, reason: "position id missing" };
    const symbol = asString(input.position.symbol);
    const volume = asNumber(input.position.volume);
    if (!symbol || volume === undefined) return { ok: false, reason: "position missing symbol/volume" };

    const headers = await this.headers();
    if (!headers) return { ok: false, reason: "missing credentials" };

    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${input.accountId}/positions/${positionId}`;
    const result = await this.fetchJson(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        symbol,
        orderType: extractOrderType(input.position, input.side),
        openPrice: asNumber(input.position.openPrice) ?? 0,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        volume,
        requestId: this.nextRequestId()
      })
    });

    if (!(result.ok || result.status === 204)) {
      return { ok: false, reason: `HTTP ${result.status}` };
    }

    const refresh = await this.loadOpenPositionsByAccount([input.accountId]);
    const refreshed = refresh.get(input.accountId);
    if (!refreshed?.ok) {
      return { ok: false, reason: "post-update verification fetch failed" };
    }
    const refreshedPosition = refreshed.positions.find((position) => extractPositionId(position) === positionId);
    if (!refreshedPosition) {
      return { ok: false, reason: "post-update position missing" };
    }
    const verifiedStopLoss = extractStopLoss(refreshedPosition);
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
  }

  private async moveStopLossToBe(input: {
    accountId: string;
    position: Obj;
    side: "BUY" | "SELL";
    breakEvenPrice: number;
  }): Promise<
    | { ok: true; verifiedStopLoss: number; verifiedTakeProfit: number }
    | { ok: false; reason: string; verifyDetails?: Obj }
  > {
    return this.modifyPositionTargets({
      accountId: input.accountId,
      position: input.position,
      side: input.side,
      stopLoss: input.breakEvenPrice,
      takeProfit: asNumber(input.position.takeProfit) ?? 0
    });
  }

  async sync(_userId: string, trades: TradeRecord[]): Promise<TradeRecord[]> {
    const multiTrades = trades.filter((t) => {
      const pr = toObj(t.providerResponse);
      return pr?.mode === "MULTI_TP_LEGS";
    });
    if (multiTrades.length === 0) return trades;

    const accountIds = Array.from(new Set(multiTrades.map((t) => t.targetAccount)));
    const openByAccount = await this.loadOpenPositionsByAccount(accountIds);
    const updated: TradeRecord[] = [];

    for (const trade of trades) {
      const providerResponse = toObj(trade.providerResponse);
      if (!providerResponse || providerResponse.mode !== "MULTI_TP_LEGS") {
        updated.push(trade);
        continue;
      }

      const account = openByAccount.get(trade.targetAccount);
      if (!account || !account.ok) {
        updated.push(trade);
        continue;
      }

      const legs = toArray(providerResponse.legs);
      const openPositions = account.positions;
      const tradeCreatedMs = Date.parse(trade.createdAt);
      const expectedSymbols = new Set(
        [
          normalizeSymbol(trade.symbol),
          asString(providerResponse.destinationBrokerSymbol)
            ? normalizeSymbol(String(providerResponse.destinationBrokerSymbol))
            : undefined
        ].filter((v): v is string => Boolean(v))
      );
      const matchedOpenPositions = openPositions.filter((p) => {
        const side = extractPositionSide(p);
        const symbol = extractPositionSymbol(p);
        if (!(side === trade.side && !!symbol && expectedSymbols.has(symbol))) return false;
        if (!Number.isFinite(tradeCreatedMs)) return true;
        const openTime = asString(p.openTime ?? p.openedAt ?? p.time);
        if (!openTime) return true;
        const openMs = Date.parse(openTime);
        if (!Number.isFinite(openMs)) return true;
        return Math.abs(openMs - tradeCreatedMs) <= this.requestMatchWindowMs;
      });
      const openReqIds = new Set(
        matchedOpenPositions.map((p) => extractRequestId(p)).filter((v): v is number => v !== undefined)
      );
      const usedPositionIds = new Set<string>();
      const normalizedLegs: Obj[] = legs.map((leg) => {
        const legObj = toObj(leg) ?? {};
        const requestId = extractRequestId(legObj);
        const originalStatus = asString(legObj.status)?.toUpperCase();
        const matchedPosition = pickMatchedOpenPosition({
          leg: legObj,
          matchedOpenPositions,
          usedPositionIds
        });
        const openMatches = matchedPosition ? [matchedPosition] : [];
        const position = matchedPosition;
        const matchedPositionId = position ? extractPositionId(position) : undefined;
        if (matchedPositionId) {
          usedPositionIds.add(matchedPositionId);
        }
        const currentStopLoss = position ? extractStopLoss(position) : undefined;
        let runtimeState: "OPEN" | "CLOSED" | "UNKNOWN" = "UNKNOWN";
        if (openMatches.length > 0) {
          runtimeState = "OPEN";
        } else if (originalStatus === "FAILED") {
          runtimeState = "CLOSED";
        } else if (requestId !== undefined && originalStatus === "EXECUTED") {
          runtimeState = openReqIds.has(requestId) ? "OPEN" : "CLOSED";
        }
        const previousRuntimeState = asString(legObj.runtimeState)?.toUpperCase();
        if (
          runtimeState === "UNKNOWN" &&
          (previousRuntimeState === "OPEN" || previousRuntimeState === "CLOSED")
        ) {
          runtimeState = previousRuntimeState;
        }
        const adoptedFromManual = originalStatus === "FAILED" && runtimeState === "OPEN";
        const normalizedStatus =
          adoptedFromManual || originalStatus === "EXECUTED"
            ? "EXECUTED"
            : originalStatus === "FAILED"
              ? "FAILED"
              : originalStatus ?? "UNKNOWN";
        const previousHistoryEvents = toArray(toObj(legObj.runtimePayload)?.matchedHistoryEvents);
        return {
          ...legObj,
          ...(requestId !== undefined ? { requestId } : {}),
          status: normalizedStatus,
          ...(adoptedFromManual ? { adoptedFromManual: true } : {}),
          ...(currentStopLoss !== undefined ? { currentStopLoss } : {}),
          runtimePayload: {
            matchedOpenPositions: openMatches.slice(0, MAX_TRADE_OPEN_POSITIONS),
            matchedHistoryEvents: previousHistoryEvents.slice(-MAX_TRADE_HISTORY_EVENTS)
          },
          runtimeState
        };
      });

      const triggerLeg = normalizedLegs.find(
        (l) => asString(l.status) === "EXECUTED" && asString(l.runtimeState) === "CLOSED"
      );
      const triggerClosed = Boolean(triggerLeg);
      const triggerRequestId = triggerLeg ? extractRequestId(triggerLeg) : undefined;
      const triggerTakeProfit = triggerLeg ? asNumber(triggerLeg.takeProfit) : undefined;
      const existingBe = toObj(providerResponse.breakeven) ?? {};
      const existingFinalLegTrail = toObj(providerResponse.finalLegTrail) ?? {};
      const existingSignalMagnitudeRebase = toObj(providerResponse.signalMagnitudeRebase) ?? {};
      const openExecutedLegs = normalizedLegs.filter(
        (l) => asString(l.status) === "EXECUTED" && asString(l.runtimeState) === "OPEN"
      );

      let breakeven = existingBe;
      let finalLegTrail = existingFinalLegTrail;
      let signalMagnitudeRebase = existingSignalMagnitudeRebase;
      let nextErrorMessage = trade.errorMessage;
      const adoptedLegs = normalizedLegs.filter((leg) => leg.adoptedFromManual === true);
      const runtimeAdoption =
        adoptedLegs.length > 0
          ? {
              status: "COMPLETED",
              adoptedAt: new Date().toISOString(),
              adoptedLegs: adoptedLegs.map((leg) => ({
                leg: asNumber(leg.leg) ?? -1,
                requestId: extractRequestId(leg)
              }))
            }
          : toObj(providerResponse.runtimeAdoption) ?? {};

      if (adoptedLegs.length > 0 && (nextErrorMessage ?? "").includes("Executed 0/")) {
        nextErrorMessage = undefined;
      }

      if (openExecutedLegs.length > 0 && asString(existingSignalMagnitudeRebase.status) !== "COMPLETED") {
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
          const position = matchedOpenPositions.find((p) => extractRequestId(p) === requestId) ?? legOpenPosition;
          const openPrice = position ? asNumber(position.openPrice) : undefined;
          if (!position || openPrice === undefined || !Number.isFinite(openPrice)) {
            failedLegs.push({ leg: legNo, reason: "open position/openPrice unavailable" });
            continue;
          }
          const newTakeProfit = openPrice + (signalTp - trade.entry);
          const newStopLoss = trade.side === "BUY" ? openPrice - riskDistance : openPrice + riskDistance;
          const moved = await this.modifyPositionTargets({
            accountId: trade.targetAccount,
            position,
            side: trade.side,
            stopLoss: newStopLoss,
            takeProfit: newTakeProfit
          });
          if (!moved.ok) {
            const reason = moved.verifyDetails
              ? `${moved.reason}: ${JSON.stringify(moved.verifyDetails)}`
              : moved.reason;
            failedLegs.push({ leg: legNo, reason });
            continue;
          }
          leg.currentStopLoss = moved.verifiedStopLoss;
          leg.takeProfit = moved.verifiedTakeProfit;
          movedLegs.push({ leg: legNo, requestId, newStopLoss, newTakeProfit });
        }

        if (movedLegs.length > 0 || failedLegs.length > 0) {
          signalMagnitudeRebase = {
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
      if (triggerClosed && asString(existingBe.status) !== "COMPLETED") {
        const movedLegs: Array<{ leg: number; positionId: string }> = [];
        const failedLegs: Array<{ leg: number; reason: string }> = [];

        for (const leg of normalizedLegs) {
          const legNo = asNumber(leg.leg);
          if (!legNo) continue;
          if (asString(leg.status) !== "EXECUTED") continue;
          if (asString(leg.runtimeState) !== "OPEN") continue;
          if (triggerTakeProfit === undefined) {
            failedLegs.push({ leg: legNo, reason: "trigger takeProfit missing" });
            continue;
          }
          const requestId = extractRequestId(leg);
          if (requestId === undefined) {
            failedLegs.push({ leg: legNo, reason: "missing requestId" });
            continue;
          }
          if (triggerRequestId !== undefined && requestId === triggerRequestId) continue;
          const legOpenPosition = toArray(toObj(leg.runtimePayload)?.matchedOpenPositions)[0];
          const position = matchedOpenPositions.find((p) => extractRequestId(p) === requestId) ?? legOpenPosition;
          if (!position) {
            failedLegs.push({ leg: legNo, reason: "open position not found" });
            continue;
          }
          // Profit-lock SL: move 5% of trigger-leg TP distance from entry toward TP.
          // BUY => slightly above entry, SELL => slightly below entry.
          const profitLockStop = trade.entry + (triggerTakeProfit - trade.entry) * 0.05;
          const moved = await this.moveStopLossToBe({
            accountId: trade.targetAccount,
            position,
            side: trade.side,
            breakEvenPrice: profitLockStop
          });
          if (!moved.ok) {
            const reason = moved.verifyDetails
              ? `${moved.reason}: ${JSON.stringify(moved.verifyDetails)}`
              : moved.reason;
            failedLegs.push({ leg: legNo, reason });
            continue;
          }
          const positionId = extractPositionId(position);
          movedLegs.push({ leg: legNo, positionId: positionId ?? "-" });
          leg.currentStopLoss = moved.verifiedStopLoss;
        }

        // Only finalize breakeven state when at least one leg was processed.
        // If no leg was moved/failed, keep BE pending so a later sync can still apply it.
        if (movedLegs.length > 0 || failedLegs.length > 0) {
          breakeven = {
            status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
            triggeredAt: new Date().toISOString(),
            movedLegs,
            failedLegs
          };
          if (failedLegs.length > 0) {
            nextErrorMessage = "BE move partially failed";
          } else if (nextErrorMessage && nextErrorMessage.startsWith("BE move")) {
            nextErrorMessage = undefined;
          }
        }
      }

      const leg2 = normalizedLegs.find(
        (leg) =>
          asNumber(leg.leg) === 2 &&
          asString(leg.status) === "EXECUTED" &&
          asString(leg.runtimeState) === "CLOSED"
      );
      if (openExecutedLegs.length > 0 && leg2 && asString(existingFinalLegTrail.status) !== "COMPLETED") {
        const leg2HistoryEvents = toArray(toObj(leg2.runtimePayload)?.matchedHistoryEvents);
        const leg2ClosePrice = extractLatestClosePrice(leg2HistoryEvents) ?? asNumber(leg2.takeProfit);
        if (leg2ClosePrice === undefined || !Number.isFinite(leg2ClosePrice)) {
          finalLegTrail = {
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
            const position =
              matchedOpenPositions.find((p) => extractRequestId(p) === legRequestId) ?? openLegPosition;
            if (!position) {
              failedLegs.push({ leg: legNo, reason: "open position not found" });
              continue;
            }
            const moved = await this.moveStopLossToBe({
              accountId: trade.targetAccount,
              position,
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

          finalLegTrail = {
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

      const nextProviderResponse: Obj = {
        ...providerResponse,
        legs: normalizedLegs,
        runtimePayload: {
          matchedOpenPositions: matchedOpenPositions.slice(0, MAX_TRADE_OPEN_POSITIONS),
          matchedHistoryEvents: ([] as Obj[]).slice(-MAX_TRADE_HISTORY_EVENTS)
        },
        runtimeAdoption,
        signalMagnitudeRebase,
        breakeven,
        finalLegTrail,
        lastLiveSyncAt: new Date().toISOString()
      };

      await this.repository.updateProviderResponse({
        userId: trade.userId,
        signalId: trade.signalId,
        createdAt: trade.createdAt,
        providerResponse: nextProviderResponse,
        errorMessage: nextErrorMessage
      });

      updated.push({
        ...trade,
        providerResponse: nextProviderResponse
      });
    }

    return updated;
  }
}
