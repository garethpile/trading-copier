import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import {
  LotSizeConfig,
  RiskTradesMode,
  SymbolConfig,
  TelegramProfile,
  TargetAccountsConfig,
  TelegramDraft,
  TradeRecord,
  TradeStatus
} from "../models/types";
import { DEFAULT_FALLBACK_LOT_SIZE, DEFAULT_SYMBOL_CONFIGS } from "../services/lotSizeDefaults";

const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

const toSymbolConfig = (symbol: string, value: unknown): SymbolConfig | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      lotSize: value,
      destinationBrokerSymbol: `${symbol}+`
    };
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as {
    lotSize?: unknown;
    destinationBrokerSymbol?: unknown;
    accountDestinationSymbols?: unknown;
  };
  const lotSize =
    typeof obj.lotSize === "number" && Number.isFinite(obj.lotSize)
      ? obj.lotSize
      : typeof obj.lotSize === "string" && Number.isFinite(Number(obj.lotSize))
        ? Number(obj.lotSize)
        : undefined;
  if (lotSize === undefined) return undefined;
  const destinationBrokerSymbol =
    typeof obj.destinationBrokerSymbol === "string" && obj.destinationBrokerSymbol.trim()
      ? obj.destinationBrokerSymbol.trim().toUpperCase()
      : `${symbol}+`;
  const rawAccountDestinationSymbols =
    obj.accountDestinationSymbols && typeof obj.accountDestinationSymbols === "object"
      ? (obj.accountDestinationSymbols as Record<string, unknown>)
      : {};
  const accountDestinationSymbols: Record<string, string> = {};
  for (const [rawAccountId, rawDestinationSymbol] of Object.entries(rawAccountDestinationSymbols)) {
    const accountId = String(rawAccountId).trim();
    const destination =
      typeof rawDestinationSymbol === "string" ? rawDestinationSymbol.trim().toUpperCase() : "";
    if (!accountId || !destination) continue;
    accountDestinationSymbols[accountId] = destination;
  }
  return {
    lotSize,
    destinationBrokerSymbol,
    ...(Object.keys(accountDestinationSymbols).length > 0
      ? { accountDestinationSymbols }
      : {})
  };
};

export class DuplicateTradeError extends Error {
  constructor(message = "Duplicate trade detected", public readonly existingSignalId?: string) {
    super(message);
    this.name = "DuplicateTradeError";
  }
}

export class TradeRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(private readonly tableName: string, client?: DynamoDBClient) {
    const endpoint = process.env.DYNAMODB_ENDPOINT;
    const region = process.env.AWS_REGION ?? "us-east-1";
    const dynamoClient =
      client ??
      new DynamoDBClient({
        region,
        ...(endpoint
          ? {
              endpoint,
              credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local"
              }
            }
          : {})
      });

    this.doc = DynamoDBDocumentClient.from(dynamoClient);
  }

  async createDedupeLock(userId: string, dedupeKey: string, signalId: string, createdAt: string): Promise<void> {
    const pk = `USER#${userId}`;
    const sk = `DEDUPE#${dedupeKey}`;

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk,
            sk,
            entityType: "DEDUPE",
            userId,
            dedupeKey,
            signalId,
            createdAt
          },
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const existing = await this.doc.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk, sk }
          })
        );
        const existingSignalId = typeof existing.Item?.signalId === "string" ? existing.Item.signalId : undefined;
        throw new DuplicateTradeError("Duplicate trade detected", existingSignalId);
      }
      throw error;
    }
  }

  async createTrade(record: TradeRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: record,
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
      })
    );
  }

  async updateTradeResult(input: {
    userId: string;
    signalId: string;
    createdAt: string;
    status: TradeStatus;
    providerResponse: unknown;
    executionId?: string;
    errorMessage?: string;
    executedAt?: string;
  }): Promise<void> {
    const pk = `USER#${input.userId}`;
    const sk = `SIGNAL#${input.createdAt}#${input.signalId}`;

    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression:
          "SET #status = :status, providerResponse = :providerResponse, executionId = :executionId, errorMessage = :errorMessage, executedAt = :executedAt",
        ExpressionAttributeNames: {
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":status": input.status,
          ":providerResponse": input.providerResponse,
          ":executionId": input.executionId ?? null,
          ":errorMessage": input.errorMessage ?? null,
          ":executedAt": input.executedAt ?? null
        }
      })
    );
  }

  async updateProviderResponse(input: {
    userId: string;
    signalId: string;
    createdAt: string;
    providerResponse: unknown;
    errorMessage?: string;
  }): Promise<void> {
    const pk = `USER#${input.userId}`;
    const sk = `SIGNAL#${input.createdAt}#${input.signalId}`;

    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: "SET providerResponse = :providerResponse, errorMessage = :errorMessage",
        ExpressionAttributeValues: {
          ":providerResponse": input.providerResponse,
          ":errorMessage": input.errorMessage ?? null
        }
      })
    );
  }

  async getHistory(userId: string, limit = 50): Promise<TradeRecord[]> {
    const pk = `USER#${userId}`;

    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":prefix": "SIGNAL#"
        },
        ScanIndexForward: false,
        Limit: limit
      })
    );

    return (out.Items ?? []) as TradeRecord[];
  }

  async getBySignalId(userId: string, signalId: string): Promise<TradeRecord | undefined> {
    const pk = `USER#${userId}`;

    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        FilterExpression: "signalId = :signalId",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":prefix": "SIGNAL#",
          ":signalId": signalId
        },
        Limit: 1
      })
    );

    return out.Items?.[0] as TradeRecord | undefined;
  }

  async getLotSizeConfig(userId: string): Promise<LotSizeConfig> {
    const pk = `USER#${userId}`;
    const sk = "SETTINGS#LOT_SIZES";

    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk }
      })
    );

    const item = out.Item as
      | {
          defaultLotSize?: number;
          symbols?: Record<string, unknown>;
          symbolLotSizes?: Record<string, number>;
          updatedAt?: string;
        }
      | undefined;

    if (!item) {
      return {
        defaultLotSize: DEFAULT_FALLBACK_LOT_SIZE,
        symbols: { ...DEFAULT_SYMBOL_CONFIGS }
      };
    }

    const rawSymbols = item.symbols ?? item.symbolLotSizes ?? {};
    const symbols: Record<string, SymbolConfig> = {};
    for (const [rawSymbol, value] of Object.entries(rawSymbols)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) continue;
      const config = toSymbolConfig(symbol, value);
      if (config) {
        symbols[symbol] = config;
      }
    }

    return {
      defaultLotSize:
        typeof item.defaultLotSize === "number" && Number.isFinite(item.defaultLotSize)
          ? item.defaultLotSize
          : DEFAULT_FALLBACK_LOT_SIZE,
      symbols,
      updatedAt: item.updatedAt
    };
  }

  async putLotSizeConfig(userId: string, config: LotSizeConfig): Promise<void> {
    const pk = `USER#${userId}`;
    const sk = "SETTINGS#LOT_SIZES";

    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          entityType: "SETTINGS_LOT_SIZES",
          userId,
          defaultLotSize: config.defaultLotSize,
          symbols: config.symbols,
          updatedAt: config.updatedAt ?? new Date().toISOString()
        }
      })
    );
  }

  async getTargetAccountsConfig(userId: string): Promise<TargetAccountsConfig> {
    const pk = `USER#${userId}`;
    const sk = "SETTINGS#TARGET_ACCOUNTS";
    const fallbackAccounts = (process.env.ALLOWED_TARGET_ACCOUNTS ?? "a5231bf5-8713-44b6-846d-4c7f43a5bf30")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk }
      })
    );

    const item = out.Item as {
      accounts?: string[];
      executionMode?: "DEMO" | "LIVE";
      modeAccounts?: Partial<Record<"DEMO" | "LIVE", string>>;
      riskTrades?: unknown;
      updatedAt?: string;
    } | undefined;
    if (!item || !Array.isArray(item.accounts) || item.accounts.length === 0) {
      return {
        accounts: fallbackAccounts,
        executionMode: "DEMO",
        modeAccounts: {
          DEMO: fallbackAccounts[0],
          LIVE: fallbackAccounts[1] ?? fallbackAccounts[0]
        },
        riskTrades: "all"
      };
    }

    const accounts = item.accounts.map((v) => String(v).trim()).filter(Boolean);
    const modeAccounts = item.modeAccounts ?? {};
    const demoAccount = modeAccounts.DEMO && accounts.includes(modeAccounts.DEMO) ? modeAccounts.DEMO : accounts[0];
    const liveCandidate = modeAccounts.LIVE && accounts.includes(modeAccounts.LIVE) ? modeAccounts.LIVE : accounts[1] ?? accounts[0];
    const executionMode = item.executionMode === "LIVE" ? "LIVE" : "DEMO";
    const riskTrades: RiskTradesMode =
      item.riskTrades === "1" || item.riskTrades === "2" || item.riskTrades === "all"
        ? item.riskTrades
        : "all";

    return {
      accounts,
      executionMode,
      modeAccounts: {
        DEMO: demoAccount,
        LIVE: liveCandidate
      },
      riskTrades,
      updatedAt: item.updatedAt
    };
  }

  async putTargetAccountsConfig(userId: string, config: TargetAccountsConfig): Promise<void> {
    const pk = `USER#${userId}`;
    const sk = "SETTINGS#TARGET_ACCOUNTS";

    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          entityType: "SETTINGS_TARGET_ACCOUNTS",
          userId,
          accounts: config.accounts,
          executionMode: config.executionMode ?? "DEMO",
          modeAccounts: config.modeAccounts ?? {},
          riskTrades: config.riskTrades ?? "all",
          updatedAt: config.updatedAt ?? new Date().toISOString()
        }
      })
    );
  }

  async getTelegramDraft(chatId: string): Promise<TelegramDraft | undefined> {
    const pk = `TELEGRAM#${chatId}`;
    const sk = "DRAFT#LATEST";
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk }
      })
    );
    const item = out.Item as TelegramDraft | undefined;
    if (!item) return undefined;
    return {
      chatId: item.chatId,
      text: item.text,
      updatedAt: item.updatedAt,
      ...(item.mode ? { mode: item.mode } : {}),
      ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata as Record<string, unknown> } : {})
    };
  }

  async putTelegramDraft(draft: TelegramDraft): Promise<void> {
    const pk = `TELEGRAM#${draft.chatId}`;
    const sk = "DRAFT#LATEST";
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          entityType: "TELEGRAM_DRAFT",
          ...draft
        }
      })
    );
  }

  async deleteTelegramDraft(chatId: string): Promise<void> {
    const pk = `TELEGRAM#${chatId}`;
    const sk = "DRAFT#LATEST";
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk, sk }
      })
    );
  }

  async getTelegramProfile(chatId: string): Promise<TelegramProfile | undefined> {
    const pk = `TELEGRAM#${chatId}`;
    const sk = "SETTINGS#PROFILE";
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk }
      })
    );
    const item = out.Item as
      | {
          chatId?: string;
          lotOverride?: number | null;
          lastProcessedUpdateId?: number | null;
          updatedAt?: string;
        }
      | undefined;
    if (!item) return undefined;
    return {
      chatId,
      lotOverride: typeof item.lotOverride === "number" ? item.lotOverride : undefined,
      lastProcessedUpdateId: typeof item.lastProcessedUpdateId === "number" ? item.lastProcessedUpdateId : undefined,
      updatedAt: item.updatedAt ?? new Date().toISOString()
    };
  }

  async putTelegramProfile(profile: TelegramProfile): Promise<void> {
    const pk = `TELEGRAM#${profile.chatId}`;
    const sk = "SETTINGS#PROFILE";
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          entityType: "TELEGRAM_PROFILE",
          chatId: profile.chatId,
          lotOverride: profile.lotOverride ?? null,
          lastProcessedUpdateId: profile.lastProcessedUpdateId ?? null,
          updatedAt: profile.updatedAt
        }
      })
    );
  }

  async claimTelegramUpdate(chatId: string, updateId: number): Promise<boolean> {
    const pk = `TELEGRAM#${chatId}`;
    const sk = "SETTINGS#PROFILE";
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk },
          UpdateExpression:
            "SET chatId = :chatId, lastProcessedUpdateId = :updateId, updatedAt = :updatedAt",
          ConditionExpression: "attribute_not_exists(lastProcessedUpdateId) OR lastProcessedUpdateId < :updateId",
          ExpressionAttributeValues: {
            ":chatId": chatId,
            ":updateId": updateId,
            ":updatedAt": new Date().toISOString()
          }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
}
