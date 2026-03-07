import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";

export class TradingCopierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "TradeSignalsTable", {
      tableName: "TradeSignals",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const userPool = new cognito.UserPool(this, "TradingCopierUserPool", {
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true
      }
    });

    const userPoolClient = new cognito.UserPoolClient(this, "TradingCopierUserPoolClient", {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      }
    });

    const metacopierApiKeySeed = process.env.METACOPIER_API_KEY ?? "QhbPqO+H9!0r5s3@vKWuZHkrmiG1AMHw";
    const metacopierSecret = new secretsmanager.Secret(this, "MetaCopierSecret", {
      secretName: "tradingcopier/metacopier",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ apiKey: metacopierApiKeySeed })
      )
    });

    const lambdaCode = lambda.Code.fromAsset("../../backend/dist");

    const commonEnv = {
      TRADE_SIGNALS_TABLE: table.tableName,
      METACOPIER_SECRET_ARN: metacopierSecret.secretArn,
      METACOPIER_BASE_URL: "https://api-london.metacopier.io",
      METACOPIER_GLOBAL_BASE_URL: "https://api.metacopier.io",
      ALLOWED_TARGET_ACCOUNTS: "a5231bf5-8713-44b6-846d-4c7f43a5bf30",
      LOT_SIZE_MIN: "0.01",
      LOT_SIZE_MAX: "50"
    };

    const parseSignalFn = new lambda.Function(this, "ParseSignalFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/parseSignal.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const executeTradeFn = new lambda.Function(this, "ExecuteTradeFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/executeTrade.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(20)
    });

    const getTradeHistoryFn = new lambda.Function(this, "GetTradeHistoryFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/getTradeHistory.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const getTradeByIdFn = new lambda.Function(this, "GetTradeByIdFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/getTradeById.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const testConnectivityFn = new lambda.Function(this, "TestConnectivityFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/testConnectivity.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    table.grantReadWriteData(parseSignalFn);
    table.grantReadWriteData(executeTradeFn);
    table.grantReadWriteData(getTradeHistoryFn);
    table.grantReadWriteData(getTradeByIdFn);

    metacopierSecret.grantRead(executeTradeFn);
    metacopierSecret.grantRead(testConnectivityFn);

    const httpApi = new apigwv2.HttpApi(this, "TradingCopierApi", {
      apiName: "tradingcopier-api"
    });

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer("CognitoJwtAuthorizer", userPool.userPoolProviderUrl, {
      jwtAudience: [userPoolClient.userPoolClientId]
    });

    httpApi.addRoutes({
      path: "/parse-signal",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("ParseSignalIntegration", parseSignalFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/execute-trade",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("ExecuteTradeIntegration", executeTradeFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/connectivity-test",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("ConnectivityTestIntegration", testConnectivityFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/trade-history",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("GetTradeHistoryIntegration", getTradeHistoryFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/trade/{signalId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("GetTradeByIdIntegration", getTradeByIdFn),
      authorizer: jwtAuthorizer
    });

    new cdk.CfnOutput(this, "ApiBaseUrl", {
      value: httpApi.apiEndpoint
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId
    });

    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId
    });

    new cdk.CfnOutput(this, "MetaCopierSecretArn", {
      value: metacopierSecret.secretArn
    });
  }
}
