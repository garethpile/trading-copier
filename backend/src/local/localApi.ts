import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException
} from "@aws-sdk/client-dynamodb";
import { handler as parseSignalHandler } from "../handlers/parseSignal";
import { handler as executeTradeHandler } from "../handlers/executeTrade";
import { handler as executeTradeFastHandler } from "../handlers/executeTradeFast";
import { handler as getTradeHistoryHandler } from "../handlers/getTradeHistory";
import { handler as getTradeByIdHandler } from "../handlers/getTradeById";
import { handler as testConnectivityHandler } from "../handlers/testConnectivity";
import { handler as getSocketFeatureStatusHandler } from "../handlers/getSocketFeatureStatus";
import { handler as enableSocketFeatureHandler } from "../handlers/enableSocketFeature";
import { handler as getLotSizeConfigHandler } from "../handlers/getLotSizeConfig";
import { handler as updateLotSizeConfigHandler } from "../handlers/updateLotSizeConfig";
import { handler as getTargetAccountsConfigHandler } from "../handlers/getTargetAccountsConfig";
import { handler as updateTargetAccountsConfigHandler } from "../handlers/updateTargetAccountsConfig";
import { handler as telegramWebhookHandler } from "../handlers/telegramWebhook";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Allow frontend dev server (localhost:5173) to call local API (localhost:4000).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.header("origin") ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
});

const port = Number(process.env.LOCAL_API_PORT ?? "4000");
const localUserId = process.env.LOCAL_USER_ID ?? "local-user";
const bypassAuth = (process.env.LOCAL_AUTH_BYPASS ?? "true") === "true";
const autoCreateLocalTable = (process.env.AUTO_CREATE_LOCAL_TABLE ?? "true") === "true";

const ensureLocalTable = async (): Promise<void> => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const tableName = process.env.TRADE_SIGNALS_TABLE;

  if (!endpoint || !tableName || !autoCreateLocalTable) {
    return;
  }

  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local"
    }
  });

  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" }
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        }
      ]
    })
  );
};

type Handler = (event: APIGatewayProxyEventV2) => Promise<{ statusCode: number; body: string; headers?: Record<string, string> }>;

const toEvent = (req: express.Request, pathParameters?: Record<string, string>): APIGatewayProxyEventV2 => {
  const authHeader = req.header("authorization") ?? "";
  const claims = bypassAuth || authHeader.startsWith("Bearer ") ? { sub: localUserId } : undefined;

  return {
    version: "2.0",
    routeKey: `${req.method} ${req.path}`,
    rawPath: req.path,
    rawQueryString: req.originalUrl.split("?")[1] ?? "",
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value ?? "")])
    ),
    requestContext: {
      accountId: "local",
      apiId: "local-api",
      domainName: "localhost",
      domainPrefix: "localhost",
      http: {
        method: req.method,
        path: req.path,
        protocol: "HTTP/1.1",
        sourceIp: req.ip || "127.0.0.1",
        userAgent: req.header("user-agent") ?? "local-client"
      },
      requestId: crypto.randomUUID(),
      routeKey: `${req.method} ${req.path}`,
      stage: "$default",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    isBase64Encoded: false,
    queryStringParameters:
      Object.keys(req.query).length === 0
        ? undefined
        : Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])),
    pathParameters,
    stageVariables: undefined,
    cookies: undefined
  } as APIGatewayProxyEventV2;
};

const invoke = (handler: Handler, pathParamExtractor?: (req: express.Request) => Record<string, string>) =>
  async (req: express.Request, res: express.Response) => {
    const event = toEvent(req, pathParamExtractor?.(req));
    const result = await handler(event);

    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        res.setHeader(k, v);
      }
    }

    res.status(result.statusCode).send(result.body);
  };

app.post("/parse-signal", invoke(parseSignalHandler as Handler));
app.post("/execute-trade", invoke(executeTradeHandler as Handler));
app.post("/execute-trade-fast", invoke(executeTradeFastHandler as Handler));
app.post("/connectivity-test", invoke(testConnectivityHandler as Handler));
app.get("/admin/socket-feature-status", invoke(getSocketFeatureStatusHandler as Handler));
app.post("/admin/enable-socket-feature", invoke(enableSocketFeatureHandler as Handler));
app.get("/management/lot-size-config", invoke(getLotSizeConfigHandler as Handler));
app.put("/management/lot-size-config", invoke(updateLotSizeConfigHandler as Handler));
app.get("/management/target-accounts-config", invoke(getTargetAccountsConfigHandler as Handler));
app.put("/management/target-accounts-config", invoke(updateTargetAccountsConfigHandler as Handler));
app.get("/trade-history", invoke(getTradeHistoryHandler as Handler));
app.get(
  "/trade/:signalId",
  invoke(getTradeByIdHandler as Handler, (req) => ({ signalId: String(req.params.signalId ?? "") }))
);
app.post("/telegram/webhook", invoke(telegramWebhookHandler as Handler));

const start = async () => {
  await ensureLocalTable();
  app.listen(port, () => {
    console.log(`Local API running on http://localhost:${port}`);
    console.log(`Auth bypass: ${bypassAuth}`);
    console.log(`Local user: ${localUserId}`);
  });
};

void start();
