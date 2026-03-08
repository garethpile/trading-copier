import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { LotSizeConfig, TargetAccountsConfig, TradeRecord, TradeStatus } from "../models/types";
import { DEFAULT_FALLBACK_LOT_SIZE, DEFAULT_SYMBOL_LOT_SIZES } from "../services/lotSizeDefaults";

export class DuplicateTradeError extends Error {}

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
        throw new DuplicateTradeError("Duplicate trade detected");
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
          symbolLotSizes?: Record<string, number>;
          updatedAt?: string;
        }
      | undefined;

    if (!item) {
      return {
        defaultLotSize: DEFAULT_FALLBACK_LOT_SIZE,
        symbolLotSizes: { ...DEFAULT_SYMBOL_LOT_SIZES }
      };
    }

    return {
      defaultLotSize:
        typeof item.defaultLotSize === "number" && Number.isFinite(item.defaultLotSize)
          ? item.defaultLotSize
          : DEFAULT_FALLBACK_LOT_SIZE,
      symbolLotSizes: item.symbolLotSizes ?? {},
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
          symbolLotSizes: config.symbolLotSizes,
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

    const item = out.Item as { accounts?: string[]; updatedAt?: string } | undefined;
    if (!item || !Array.isArray(item.accounts) || item.accounts.length === 0) {
      return {
        accounts: fallbackAccounts
      };
    }

    return {
      accounts: item.accounts.map((v) => String(v).trim()).filter(Boolean),
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
          updatedAt: config.updatedAt ?? new Date().toISOString()
        }
      })
    );
  }
}
