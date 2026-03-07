import "dotenv/config";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException
} from "@aws-sdk/client-dynamodb";

const tableName = process.env.TRADE_SIGNALS_TABLE ?? "TradeSignalsLocal";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local"
  }
});

const run = async () => {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`Table already exists: ${tableName}`);
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

  console.log(`Created table: ${tableName}`);
};

void run();
