import crypto from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { TradeRecord } from "../models/types";
import { TradeRepository } from "../repositories/TradeRepository";

type Obj = Record<string, unknown>;

type Scope = "ALL_LEGS" | "LEG";

export interface TradeManagementRequest {
  scope: Scope;
  leg?: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface MatchedLeg {
  leg: number;
  requestId?: number;
  executionId?: string;
  positionId: string;
  symbol: string;
  volume: number;
  orderType: string;
  openPrice: number;
  currentStopLoss?: number;
  currentTakeProfit?: number;
  nextStopLoss: number;
  nextTakeProfit: number;
}

const asObj = (value: unknown): Obj | undefined => (value && typeof value === "object" ? (value as Obj) : undefined);
const asArray = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter((v): v is Obj => !!asObj(v)).map((v) => v as Obj) : []);
const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const normalizeSymbol = (value: string): string => value.trim().toUpperCase();
const extractPositionId = (position: Obj): string | undefined => asString(position.id ?? position.positionId);
const extractStopLoss = (position: Obj): number | undefined => asNumber(position.stopLoss ?? position.sl);
const extractTakeProfit = (position: Obj): number | undefined => asNumber(position.takeProfit ?? position.tp);
const extractOpenPrice = (position: Obj): number | undefined => asNumber(position.openPrice ?? position.price);
const extractVolume = (position: Obj): number | undefined => asNumber(position.volume ?? position.lotSize);
const extractSymbol = (position: Obj): string | undefined => {
  const symbol = asString(position.symbol ?? position.instrument ?? position.destinationBrokerSymbol);
  return symbol ? normalizeSymbol(symbol) : undefined;
};
const extractSide = (position: Obj): "BUY" | "SELL" | undefined => {
  const raw = asString(position.side ?? position.positionType ?? position.tradeType ?? position.orderType)?.toUpperCase();
  if (!raw) return undefined;
  if (raw.includes("BUY")) return "BUY";
  if (raw.includes("SELL")) return "SELL";
  return undefined;
};
const extractOrderType = (position: Obj, side: "BUY" | "SELL"): string => {
  const raw = asString(position.orderType)?.toUpperCase();
  if (raw && (raw.includes("LIMIT") || raw.includes("STOP") || raw === "BUY" || raw === "SELL")) return raw;
  return side === "BUY" ? "Buy" : "Sell";
};
const extractRequestId = (value: Obj): number | undefined => {
  const direct = asNumber(value.requestId ?? value.clientRequestId ?? value.magicNumber);
  if (direct !== undefined) return Math.floor(direct);
  const providerResponse = asObj(value.providerResponse);
  const nested = asNumber(providerResponse?.requestId);
  if (nested !== undefined) return Math.floor(nested);
  const comment = asString(value.comment);
  const match = comment?.match(/API\|(\d+)\|/);
  return match ? Number(match[1]) : undefined;
};

interface MetaCopierSecret { apiKey?: string; userEmail?: string; }

export class TradeManagementService {
  private readonly secretsClient = new SecretsManagerClient({});
  private secretCache?: MetaCopierSecret;
  private requestSeed = Math.floor(Math.random() * 100000);

  constructor(private readonly repository: TradeRepository) {}

  private confirmationSecret(): string {
    return process.env.TRADE_MANAGEMENT_CONFIRMATION_SECRET?.trim() || process.env.LOCAL_API_SECRET?.trim() || "local-trade-management-secret";
  }

  private nextRequestId(): number {
    this.requestSeed = (this.requestSeed + 1) % 1_000_000;
    return this.requestSeed;
  }

  private async getMetaCopierSecret(): Promise<MetaCopierSecret> {
    if (this.secretCache) return this.secretCache;
    if (process.env.METACOPIER_API_KEY?.trim()) {
      this.secretCache = {
        apiKey: process.env.METACOPIER_API_KEY.trim(),
        userEmail: process.env.METACOPIER_USER_EMAIL?.trim() || undefined
      };
      return this.secretCache;
    }
    const secretArn = process.env.METACOPIER_SECRET_ARN?.trim();
    if (!secretArn) throw new Error("METACOPIER credentials not configured");
    const out = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const parsed = out.SecretString ? (JSON.parse(out.SecretString) as MetaCopierSecret) : {};
    if (!parsed.apiKey?.trim()) throw new Error("METACOPIER apiKey missing");
    this.secretCache = { apiKey: parsed.apiKey.trim(), userEmail: parsed.userEmail?.trim() || undefined };
    return this.secretCache;
  }

  private async headers(): Promise<Record<string, string>> {
    const secret = await this.getMetaCopierSecret();
    const headers: Record<string, string> = {
      "X-API-KEY": secret.apiKey ?? "",
      "Content-Type": "application/json"
    };
    if (secret.userEmail) headers["X-User-Email"] = secret.userEmail;
    return headers;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { ok: response.ok, status: response.status, body };
  }

  private validateRequest(input: TradeManagementRequest): string[] {
    const errors: string[] = [];
    if (input.scope !== "ALL_LEGS" && input.scope !== "LEG") errors.push("scope must be ALL_LEGS or LEG");
    if (input.scope === "LEG") {
      if (!Number.isInteger(input.leg) || (input.leg ?? 0) < 1) errors.push("leg is required for LEG scope");
    }
    if (input.stopLoss === undefined && input.takeProfit === undefined) errors.push("stopLoss or takeProfit is required");
    if (input.stopLoss !== undefined && !Number.isFinite(input.stopLoss)) errors.push("stopLoss must be numeric");
    if (input.takeProfit !== undefined && !Number.isFinite(input.takeProfit)) errors.push("takeProfit must be numeric");
    if (input.scope === "ALL_LEGS" && input.takeProfit === undefined && input.stopLoss === undefined) errors.push("at least one field is required");
    return errors;
  }

  private signPayload(payload: Obj): string {
    const json = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", this.confirmationSecret()).update(json).digest("base64url");
    return `${Buffer.from(json).toString("base64url")}.${sig}`;
  }

  private verifyToken(token: string): Obj {
    const [encoded, receivedSig] = token.split(".");
    if (!encoded || !receivedSig) throw new Error("Invalid confirmation token format");
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const expectedSig = crypto.createHmac("sha256", this.confirmationSecret()).update(json).digest("base64url");
    if (expectedSig !== receivedSig) throw new Error("Invalid confirmation token signature");
    const payload = JSON.parse(json) as Obj;
    const expiresAt = asString(payload.expiresAt);
    if (!expiresAt || Date.parse(expiresAt) < Date.now()) throw new Error("Confirmation token expired");
    return payload;
  }

  private async loadTrade(userId: string, signalId: string): Promise<TradeRecord> {
    const trade = await this.repository.getBySignalId(userId, signalId);
    if (!trade) throw new Error("Trade not found");
    return trade;
  }

  private async loadOpenPositions(accountId: string): Promise<Obj[]> {
    const baseUrl = (process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io").replace(/\/$/, "");
    const endpoint = `${baseUrl}/rest/api/v1/accounts/${accountId}/positions`;
    const result = await this.fetchJson(endpoint, { method: "GET", headers: await this.headers() });
    if (!result.ok) throw new Error(`Failed to load open positions: HTTP ${result.status}`);
    const bodyObj = asObj(result.body);
    return asArray(result.body).length > 0 ? asArray(result.body) : asArray(bodyObj?.openPositions ?? bodyObj?.positions ?? bodyObj?.items);
  }

  private buildLegPlan(trade: TradeRecord, positions: Obj[], request: TradeManagementRequest): MatchedLeg[] {
    const providerResponse = asObj(trade.providerResponse) ?? {};
    const rawLegs = asArray(providerResponse.legs);
    const expectedSymbols = new Set([normalizeSymbol(trade.symbol), normalizeSymbol(asString(providerResponse.destinationBrokerSymbol) ?? trade.symbol)]);
    const candidatePositions = positions.filter((position) => {
      const side = extractSide(position);
      const symbol = extractSymbol(position);
      return side === trade.side && !!symbol && expectedSymbols.has(symbol);
    });

    const matches = rawLegs.map((rawLeg, index): MatchedLeg | undefined => {
      const legNo = asNumber(rawLeg.leg) ?? index + 1;
      const requestId = extractRequestId(rawLeg);
      const executionId = asString(rawLeg.executionId);
      const desiredPosition = candidatePositions.find((position) => {
        const positionRequestId = extractRequestId(position);
        if (requestId !== undefined && positionRequestId === requestId) return true;
        return false;
      });
      const fallbackPosition = candidatePositions[index];
      const position = desiredPosition ?? fallbackPosition;
      const positionId = position ? extractPositionId(position) : undefined;
      const symbol = position ? extractSymbol(position) : undefined;
      const volume = position ? extractVolume(position) : undefined;
      const openPrice = position ? extractOpenPrice(position) : undefined;
      if (!position || !positionId || !symbol || volume === undefined || openPrice === undefined) return undefined;
      return {
        leg: legNo,
        requestId,
        executionId,
        positionId,
        symbol,
        volume,
        openPrice,
        orderType: extractOrderType(position, trade.side),
        currentStopLoss: extractStopLoss(position),
        currentTakeProfit: extractTakeProfit(position),
        nextStopLoss: request.stopLoss ?? extractStopLoss(position) ?? trade.stopLoss,
        nextTakeProfit: request.takeProfit ?? extractTakeProfit(position) ?? trade.takeProfits[index] ?? 0
      };
    }).filter((value): value is MatchedLeg => value !== undefined);

    return request.scope === "LEG" ? matches.filter((leg) => leg.leg === request.leg) : matches;
  }

  async preview(userId: string, signalId: string, request: TradeManagementRequest) {
    const errors = this.validateRequest(request);
    if (errors.length > 0) throw new Error(errors.join(", "));
    const trade = await this.loadTrade(userId, signalId);
    const positions = await this.loadOpenPositions(trade.targetAccount);
    const matchedLegs = this.buildLegPlan(trade, positions, request);
    if (matchedLegs.length === 0) throw new Error("No matching open legs found for trade set");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const confirmationToken = this.signPayload({ userId, signalId, request, expiresAt });
    return {
      signalId,
      targetAccount: trade.targetAccount,
      scope: request.scope,
      trade: {
        symbol: trade.symbol,
        side: trade.side,
        orderType: trade.orderType,
        entry: trade.entry
      },
      actions: matchedLegs.map((leg) => ({
        leg: leg.leg,
        positionId: leg.positionId,
        requestId: leg.requestId,
        executionId: leg.executionId,
        current: { stopLoss: leg.currentStopLoss, takeProfit: leg.currentTakeProfit },
        proposed: { stopLoss: leg.nextStopLoss, takeProfit: leg.nextTakeProfit }
      })),
      confirmationToken,
      expiresAt
    };
  }

  async apply(userId: string, signalId: string, request: TradeManagementRequest, confirmationToken: string) {
    const payload = this.verifyToken(confirmationToken);
    if (asString(payload.userId) !== userId || asString(payload.signalId) !== signalId) {
      throw new Error("Confirmation token does not match target trade");
    }
    if (JSON.stringify(payload.request ?? null) !== JSON.stringify(request)) {
      throw new Error("Confirmation token does not match requested management action");
    }

    const trade = await this.loadTrade(userId, signalId);
    const positions = await this.loadOpenPositions(trade.targetAccount);
    const matchedLegs = this.buildLegPlan(trade, positions, request);
    if (matchedLegs.length === 0) throw new Error("No matching open legs found for trade set");

    const headers = await this.headers();
    const baseUrl = (process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io").replace(/\/$/, "");
    const results = [] as Array<{ leg: number; positionId: string; status: "UPDATED" | "FAILED"; message: string; stopLoss: number; takeProfit: number }>;

    for (const leg of matchedLegs) {
      const endpoint = `${baseUrl}/rest/api/v1/accounts/${trade.targetAccount}/positions/${leg.positionId}`;
      const result = await this.fetchJson(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          symbol: leg.symbol,
          orderType: leg.orderType,
          openPrice: leg.openPrice,
          stopLoss: leg.nextStopLoss,
          takeProfit: leg.nextTakeProfit,
          volume: leg.volume,
          requestId: this.nextRequestId()
        })
      });
      results.push({
        leg: leg.leg,
        positionId: leg.positionId,
        status: result.ok || result.status === 204 ? "UPDATED" : "FAILED",
        message: result.ok || result.status === 204 ? "Targets updated" : `HTTP ${result.status}`,
        stopLoss: leg.nextStopLoss,
        takeProfit: leg.nextTakeProfit
      });
    }

    const providerResponse = asObj(trade.providerResponse) ?? {};
    const management = asObj(providerResponse.management) ?? {};
    const history = Array.isArray(management.history) ? management.history : [];
    providerResponse.management = {
      ...management,
      lastUpdatedAt: new Date().toISOString(),
      history: [
        ...history,
        {
          signalId,
          scope: request.scope,
          leg: request.leg,
          stopLoss: request.stopLoss,
          takeProfit: request.takeProfit,
          results
        }
      ]
    };
    await this.repository.updateProviderResponse({
      userId,
      signalId,
      createdAt: trade.createdAt,
      providerResponse,
      errorMessage: results.some((item) => item.status === "FAILED") ? "One or more management updates failed" : trade.errorMessage
    });

    return {
      signalId,
      targetAccount: trade.targetAccount,
      results,
      status: results.every((item) => item.status === "UPDATED") ? "UPDATED" : "PARTIAL"
    };
  }
}
