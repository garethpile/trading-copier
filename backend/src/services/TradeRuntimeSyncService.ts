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

const extractOrderType = (position: Obj, side: "BUY" | "SELL"): "Buy" | "Sell" => {
  const raw = asString(position.orderType ?? position.dealType ?? position.side ?? position.type)?.toLowerCase();
  if (raw?.includes("sell")) return "Sell";
  if (raw?.includes("buy")) return "Buy";
  return side === "BUY" ? "Buy" : "Sell";
};

export class TradeRuntimeSyncService {
  private readonly secretsClient = new SecretsManagerClient({});
  private secretCache?: MetaCopierSecret;
  private readonly baseUrl: string;
  private readonly secretArn: string;
  private readonly envApiKey: string;
  private readonly envUserEmail?: string;

  constructor(private readonly repository: TradeRepository) {
    this.baseUrl = process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io";
    this.secretArn = process.env.METACOPIER_SECRET_ARN ?? "";
    this.envApiKey = process.env.METACOPIER_API_KEY?.trim() ?? "";
    this.envUserEmail = process.env.METACOPIER_USER_EMAIL?.trim() || undefined;
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
    return { apiKey, userEmail: this.envUserEmail ?? secret.userEmail?.trim() };
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
    const response = await fetch(url, init);
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
  }

  private async loadOpenPositionsByAccount(
    accountIds: string[]
  ): Promise<Map<string, { ok: boolean; positions: Obj[] }>> {
    const map = new Map<string, { ok: boolean; positions: Obj[] }>();
    const headers = await this.headers();
    if (!headers) return map;

    await Promise.all(
      accountIds.map(async (accountId) => {
        try {
          const endpoint = `${this.baseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${accountId}/positions`;
          const res = await this.fetchJson(endpoint, { method: "GET", headers });
          if (!res.ok) {
            map.set(accountId, { ok: false, positions: [] });
            return;
          }
          const bodyObj = toObj(res.body);
          const positions = Array.isArray(res.body)
            ? (res.body as Obj[])
            : toArray(bodyObj?.openPositions ?? bodyObj?.positions ?? bodyObj?.items);
          map.set(accountId, { ok: true, positions });
        } catch {
          map.set(accountId, { ok: false, positions: [] });
        }
      })
    );

    return map;
  }

  private async moveStopLossToBe(input: {
    accountId: string;
    position: Obj;
    side: "BUY" | "SELL";
    breakEvenPrice: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
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
        stopLoss: input.breakEvenPrice,
        takeProfit: asNumber(input.position.takeProfit) ?? 0,
        volume,
        requestId: this.nextRequestId()
      })
    });

    if (result.ok || result.status === 204) return { ok: true };
    return { ok: false, reason: `HTTP ${result.status}` };
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
      const openReqIds = new Set(openPositions.map((p) => extractRequestId(p)).filter((v): v is number => v !== undefined));

      const normalizedLegs: Obj[] = legs.map((leg) => {
        const legObj = toObj(leg) ?? {};
        const requestId = extractRequestId(legObj);
        const status = asString(legObj.status)?.toUpperCase();
        const position =
          requestId !== undefined ? openPositions.find((p) => extractRequestId(p) === requestId) : undefined;
        const currentStopLoss = position ? extractStopLoss(position) : undefined;
        let runtimeState: "OPEN" | "CLOSED" | "UNKNOWN" = "UNKNOWN";
        if (status === "FAILED") {
          runtimeState = "CLOSED";
        } else if (requestId !== undefined && status === "EXECUTED") {
          runtimeState = openReqIds.has(requestId) ? "OPEN" : "CLOSED";
        }
        return {
          ...legObj,
          ...(requestId !== undefined ? { requestId } : {}),
          ...(currentStopLoss !== undefined ? { currentStopLoss } : {}),
          runtimeState
        };
      });

      const tp1 = normalizedLegs.find((l) => asNumber(l.leg) === 1 && asString(l.status) === "EXECUTED");
      const tp1Closed = tp1 ? asString(tp1.runtimeState) === "CLOSED" : false;
      const tp1Price = tp1 ? asNumber(tp1.takeProfit) : undefined;
      const existingBe = toObj(providerResponse.breakeven) ?? {};

      let breakeven = existingBe;
      if (tp1Closed && asString(existingBe.status) !== "COMPLETED") {
        const movedLegs: Array<{ leg: number; positionId: string }> = [];
        const failedLegs: Array<{ leg: number; reason: string }> = [];

        for (const leg of normalizedLegs) {
          const legNo = asNumber(leg.leg);
          if (!legNo || legNo <= 1) continue;
          if (asString(leg.status) !== "EXECUTED") continue;
          if (asString(leg.runtimeState) !== "OPEN") continue;
          if (tp1Price === undefined) {
            failedLegs.push({ leg: legNo, reason: "tp1 takeProfit missing" });
            continue;
          }
          const requestId = extractRequestId(leg);
          if (requestId === undefined) {
            failedLegs.push({ leg: legNo, reason: "missing requestId" });
            continue;
          }
          const position = openPositions.find((p) => extractRequestId(p) === requestId);
          if (!position) {
            failedLegs.push({ leg: legNo, reason: "open position not found" });
            continue;
          }
          // Profit-lock SL: move 5% of the TP1 distance from entry toward TP1.
          // BUY => slightly above entry, SELL => slightly below entry.
          const profitLockStop = trade.entry + (tp1Price - trade.entry) * 0.05;
          const moved = await this.moveStopLossToBe({
            accountId: trade.targetAccount,
            position,
            side: trade.side,
            breakEvenPrice: profitLockStop
          });
          if (!moved.ok) {
            failedLegs.push({ leg: legNo, reason: moved.reason });
            continue;
          }
          const positionId = extractPositionId(position);
          movedLegs.push({ leg: legNo, positionId: positionId ?? "-" });
          leg.currentStopLoss = profitLockStop;
        }

        breakeven = {
          status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
          triggeredAt: new Date().toISOString(),
          movedLegs,
          failedLegs
        };
      }

      const nextProviderResponse: Obj = {
        ...providerResponse,
        legs: normalizedLegs,
        breakeven,
        lastLiveSyncAt: new Date().toISOString()
      };

      await this.repository.updateProviderResponse({
        userId: trade.userId,
        signalId: trade.signalId,
        createdAt: trade.createdAt,
        providerResponse: nextProviderResponse,
        errorMessage: toArray(toObj(breakeven)?.failedLegs).length > 0 ? "BE move partially failed" : trade.errorMessage
      });

      updated.push({
        ...trade,
        providerResponse: nextProviderResponse
      });
    }

    return updated;
  }
}
