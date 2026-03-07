import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { TradeRecord, TradeStatus } from "../models/types";

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
}
