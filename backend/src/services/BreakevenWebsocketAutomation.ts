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

  const anyNum = comment.match(/(\d{1,3})/);
  if (anyNum) return Number(anyNum[1]);

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

export class BreakevenWebsocketAutomation {
  private readonly apiKey: string;
  private readonly userEmail?: string;
  private readonly socketUrl: string;
  private readonly tradingBaseUrl: string;
  private readonly automationUserId: string;
  private readonly pollMs: number;
  private readonly openPositionsByAccount = new Map<string, GenericObject[]>();
  private readonly closedRequestIdsByAccount = new Map<string, Set<number>>();
  private evaluating = false;

  constructor(private readonly repository: TradeRepository) {
    this.apiKey = process.env.METACOPIER_API_KEY ?? "";
    this.userEmail = process.env.METACOPIER_USER_EMAIL?.trim() || undefined;
    this.socketUrl = process.env.METACOPIER_SOCKET_URL ?? "wss://api.metacopier.io/ws/api/v1";
    this.tradingBaseUrl = process.env.METACOPIER_BASE_URL ?? "https://api-london.metacopier.io";
    this.automationUserId = process.env.AUTOMATION_USER_ID ?? process.env.LOCAL_USER_ID ?? "local-user";
    this.pollMs = Number(process.env.BREAKEVEN_POLL_MS ?? "5000");
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

    setInterval(() => {
      void this.evaluateAndMoveBreakEven();
    }, this.pollMs);
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
        return;
      }

      if (type === "UpdateHistoryDTO") {
        const history = toArray(data.history);
        const requestIds = this.closedRequestIdsByAccount.get(accountId) ?? new Set<number>();

        for (const item of history) {
          const requestId = extractRequestId(item);
          if (requestId !== undefined) {
            requestIds.add(requestId);
          }
        }

        // Keep memory bounded.
        if (requestIds.size > 2000) {
          const newest = Array.from(requestIds).slice(-1000);
          this.closedRequestIdsByAccount.set(accountId, new Set(newest));
        } else {
          this.closedRequestIdsByAccount.set(accountId, requestIds);
        }
      }
    } catch (error) {
      console.error("Failed to parse websocket payload", String(error));
    }
  }

  private async evaluateAndMoveBreakEven(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;

    try {
      const trades = await this.repository.getHistory(this.automationUserId, 100);
      for (const trade of trades) {
        await this.processTrade(trade);
      }
    } catch (error) {
      console.error("Breakeven evaluation failed", String(error));
    } finally {
      this.evaluating = false;
    }
  }

  private async processTrade(trade: TradeRecord): Promise<void> {
    const providerResponse = (trade.providerResponse as GenericObject | undefined) ?? {};
    if (providerResponse.mode !== "MULTI_TP_LEGS") return;

    const legs = toArray(providerResponse.legs);
    if (legs.length < 2) return;
    const openPositions = this.openPositionsByAccount.get(trade.targetAccount) ?? [];
    const closed = this.closedRequestIdsByAccount.get(trade.targetAccount) ?? new Set<number>();

    const normalizedLegs: GenericObject[] = legs.map((leg) => {
      const requestId = extractRequestId(leg);
      const legStatus = asString(leg["status"])?.toUpperCase();
      let runtimeState: "OPEN" | "CLOSED" | "UNKNOWN" = "UNKNOWN";

      if (legStatus === "FAILED") {
        runtimeState = "CLOSED";
      } else if (requestId !== undefined) {
        if (closed.has(requestId)) {
          runtimeState = "CLOSED";
        } else if (openPositions.some((position) => extractRequestId(position) === requestId)) {
          runtimeState = "OPEN";
        }
      }

      return {
        ...leg,
        ...(requestId !== undefined ? { requestId } : {}),
        runtimeState
      };
    });

    const tp1 = normalizedLegs.find((leg) => asNumber(leg["leg"]) === 1 && asString(leg["status"]) === "EXECUTED");
    if (!tp1) return;

    const tp1RequestId = extractRequestId(tp1);
    if (tp1RequestId === undefined) return;

    if (!closed.has(tp1RequestId)) {
      const providerWithLiveState: GenericObject = {
        ...providerResponse,
        legs: normalizedLegs,
        lastLiveSyncAt: new Date().toISOString()
      };
      await this.repository.updateProviderResponse({
        userId: trade.userId,
        signalId: trade.signalId,
        createdAt: trade.createdAt,
        providerResponse: providerWithLiveState,
        errorMessage: trade.errorMessage
      });
      return;
    }

    const breakeven = (providerResponse.breakeven as GenericObject | undefined) ?? {};
    if (breakeven.status === "COMPLETED") {
      return;
    }

    const movedLegs: Array<{ leg: number; positionId: string }> = [];
    const failedLegs: Array<{ leg: number; reason: string }> = [];

    for (const leg of normalizedLegs) {
      const legNo = asNumber(leg["leg"]);
      if (!legNo || legNo <= 1) continue;
      if (asString(leg["status"]) !== "EXECUTED") continue;

      const legRequestId = extractRequestId(leg);
      if (legRequestId === undefined) {
        failedLegs.push({ leg: legNo, reason: "missing requestId" });
        continue;
      }

      const openPosition = openPositions.find((position) => extractRequestId(position) === legRequestId);
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
        movedLegs.push({ leg: legNo, positionId });
      } else {
        failedLegs.push({ leg: legNo, reason: modifyResult.reason });
      }
    }

    if (movedLegs.length === 0 && failedLegs.length === 0) return;

    const updatedProviderResponse: GenericObject = {
      ...providerResponse,
      legs: normalizedLegs,
      lastLiveSyncAt: new Date().toISOString(),
      breakeven: {
        status: failedLegs.length === 0 ? "COMPLETED" : movedLegs.length > 0 ? "PARTIAL" : "FAILED",
        triggeredByRequestId: tp1RequestId,
        triggeredAt: new Date().toISOString(),
        movedLegs,
        failedLegs
      }
    };

    await this.repository.updateProviderResponse({
      userId: trade.userId,
      signalId: trade.signalId,
      createdAt: trade.createdAt,
      providerResponse: updatedProviderResponse,
      errorMessage: failedLegs.length > 0 ? `BE move failed for ${failedLegs.length} leg(s)` : trade.errorMessage
    });
  }

  private async modifyPositionStopLossToBreakEven(input: {
    accountId: string;
    position: GenericObject;
    side: "BUY" | "SELL";
    breakEvenPrice: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const positionId = extractPositionId(input.position);
    if (!positionId) {
      return { ok: false, reason: "position id missing" };
    }

    const symbol = asString(input.position.symbol);
    const volume = asNumber(input.position.volume);
    const takeProfit = asNumber(input.position.takeProfit) ?? 0;
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
          stopLoss: input.breakEvenPrice,
          takeProfit,
          volume,
          requestId
        },
        {
          timeout: 30000,
          headers,
          validateStatus: (status) => status === 204
        }
      );
      return { ok: true };
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
}
