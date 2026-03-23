import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";

export class TradingCopierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const toOrigin = (value: string): string => {
      const trimmed = value.trim();
      if (!trimmed) return trimmed;
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        try {
          const parsed = new URL(trimmed);
          return `${parsed.protocol}//${parsed.host}`;
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    };

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
      selfSignUpEnabled: true,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_AND_PHONE_WITHOUT_MFA,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        otp: true,
        sms: false
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true
      }
    });

    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    const hostedUiDomainPrefix =
      process.env.COGNITO_DOMAIN_PREFIX?.trim() || `tradingcopier-${account}-${region}`;
    const defaultFrontendOrigins = [
      "http://localhost:5173",
      "https://drppa7twrc4zh.cloudfront.net"
    ];
    const callbackUrls = (
      process.env.COGNITO_CALLBACK_URLS?.trim() || defaultFrontendOrigins.join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const logoutUrls = (
      process.env.COGNITO_LOGOUT_URLS?.trim() || defaultFrontendOrigins.join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const googleEnabled = (process.env.GOOGLE_SIGNIN_ENABLED ?? "true").toLowerCase() !== "false";
    const googleOauthSecretName = process.env.GOOGLE_OAUTH_SECRET_NAME?.trim() || "tradingcopier/google-oauth";
    const googleOauthSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GoogleOauthSecret",
      googleOauthSecretName
    );

    let googleIdp: cognito.UserPoolIdentityProviderGoogle | undefined;
    if (googleEnabled) {
      const googleClientId = googleOauthSecret.secretValueFromJson("clientId");
      const googleClientSecret = googleOauthSecret.secretValueFromJson("clientSecret");
      googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdP", {
        userPool,
        clientId: googleClientId.unsafeUnwrap(),
        clientSecretValue: googleClientSecret,
        scopes: ["openid", "profile", "email"],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
          familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME
        }
      });
    }

    const domain = userPool.addDomain("TradingCopierDomain", {
      cognitoDomain: {
        domainPrefix: hostedUiDomainPrefix
      }
    });

    const userPoolClient = new cognito.UserPoolClient(this, "TradingCopierUserPoolClient", {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      supportedIdentityProviders: googleEnabled
        ? [cognito.UserPoolClientIdentityProvider.COGNITO, cognito.UserPoolClientIdentityProvider.GOOGLE]
        : [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        callbackUrls,
        logoutUrls,
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.COGNITO_ADMIN
        ],
        flows: {
          authorizationCodeGrant: true
        }
      }
    });

    if (googleIdp) {
      userPoolClient.node.addDependency(googleIdp);
    }

    const metacopierSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "MetaCopierSecret",
      "tradingcopier/metacopier"
    );

    const lambdaCode = lambda.Code.fromAsset("../../backend/dist");

    const commonEnv = {
      TRADE_SIGNALS_TABLE: table.tableName,
      METACOPIER_SECRET_ARN: metacopierSecret.secretArn,
      METACOPIER_BASE_URL: "https://api-london.metacopier.io",
      METACOPIER_GLOBAL_BASE_URL: "https://api.metacopier.io",
      METACOPIER_REQUEST_TIMEOUT_MS: process.env.METACOPIER_REQUEST_TIMEOUT_MS?.trim() || "25000",
      AUTOMATION_USER_ID:
        process.env.AUTOMATION_USER_ID?.trim() || process.env.TELEGRAM_CONFIG_USER_ID?.trim() || "",
      ALLOWED_TARGET_ACCOUNTS:
        process.env.ALLOWED_TARGET_ACCOUNTS?.trim() || "a5231bf5-8713-44b6-846d-4c7f43a5bf30",
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
      timeout: cdk.Duration.seconds(45)
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

    const previewTradeManagementFn = new lambda.Function(this, "PreviewTradeManagementFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/previewTradeManagement.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(20)
    });

    const applyTradeManagementFn = new lambda.Function(this, "ApplyTradeManagementFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/applyTradeManagement.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30)
    });

    const runRuntimeSyncFn = new lambda.Function(this, "RunRuntimeSyncFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/runRuntimeSync.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(60)
    });

    const testConnectivityFn = new lambda.Function(this, "TestConnectivityFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/testConnectivity.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const getSocketFeatureStatusFn = new lambda.Function(this, "GetSocketFeatureStatusFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/getSocketFeatureStatus.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const enableSocketFeatureFn = new lambda.Function(this, "EnableSocketFeatureFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/enableSocketFeature.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const getLotSizeConfigFn = new lambda.Function(this, "GetLotSizeConfigFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/getLotSizeConfig.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const updateLotSizeConfigFn = new lambda.Function(this, "UpdateLotSizeConfigFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/updateLotSizeConfig.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const getTargetAccountsConfigFn = new lambda.Function(this, "GetTargetAccountsConfigFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/getTargetAccountsConfig.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const updateTargetAccountsConfigFn = new lambda.Function(this, "UpdateTargetAccountsConfigFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/updateTargetAccountsConfig.handler",
      code: lambdaCode,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10)
    });

    const telegramWebhookFn = new lambda.Function(this, "TelegramWebhookFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handlers/telegramWebhook.handler",
      code: lambdaCode,
      environment: {
        ...commonEnv,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
        TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "",
        TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS ?? "",
        TELEGRAM_CONFIG_USER_ID: process.env.TELEGRAM_CONFIG_USER_ID ?? ""
      },
      timeout: cdk.Duration.seconds(20)
    });

    // Low-cost always-on worker for immediate BE automation:
    // one tiny Fargate task in public subnets (no NAT / no load balancer).
    const workerVpc = new ec2.Vpc(this, "BreakevenWorkerVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24
        }
      ]
    });

    const workerCluster = new ecs.Cluster(this, "BreakevenWorkerCluster", {
      vpc: workerVpc,
      clusterName: "tradingcopier-breakeven-worker"
    });

    const workerTaskDef = new ecs.FargateTaskDefinition(this, "BreakevenWorkerTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64
      }
    });

    const workerLogGroup = new logs.LogGroup(this, "BreakevenWorkerLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK
    });

    workerTaskDef.addContainer("Worker", {
      image: ecs.ContainerImage.fromAsset("../../backend", {
        file: "Dockerfile.worker"
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "breakeven-worker",
        logGroup: workerLogGroup
      }),
      environment: {
        TRADE_SIGNALS_TABLE: table.tableName,
        METACOPIER_BASE_URL: "https://api-london.metacopier.io",
        METACOPIER_SOCKET_URL: "wss://api.metacopier.io/ws/api/v1",
        ALLOWED_TARGET_ACCOUNTS: commonEnv.ALLOWED_TARGET_ACCOUNTS,
        AUTOMATION_USER_ID: commonEnv.AUTOMATION_USER_ID
      },
      secrets: {
        METACOPIER_API_KEY: ecs.Secret.fromSecretsManager(metacopierSecret, "apiKey"),
        METACOPIER_USER_EMAIL: ecs.Secret.fromSecretsManager(metacopierSecret, "userEmail")
      }
    });

    const workerService = new ecs.FargateService(this, "BreakevenWorkerService", {
      cluster: workerCluster,
      taskDefinition: workerTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      serviceName: "tradingcopier-breakeven-worker"
    });

    table.grantReadWriteData(parseSignalFn);
    table.grantReadWriteData(executeTradeFn);
    table.grantReadWriteData(getTradeHistoryFn);
    table.grantReadWriteData(getTradeByIdFn);
    table.grantReadWriteData(previewTradeManagementFn);
    table.grantReadWriteData(applyTradeManagementFn);
    table.grantReadWriteData(runRuntimeSyncFn);
    table.grantReadWriteData(getLotSizeConfigFn);
    table.grantReadWriteData(updateLotSizeConfigFn);
    table.grantReadWriteData(getTargetAccountsConfigFn);
    table.grantReadWriteData(updateTargetAccountsConfigFn);
    table.grantReadWriteData(getSocketFeatureStatusFn);
    table.grantReadWriteData(enableSocketFeatureFn);
    table.grantReadWriteData(telegramWebhookFn);
    table.grantReadWriteData(workerTaskDef.taskRole);

    metacopierSecret.grantRead(executeTradeFn);
    metacopierSecret.grantRead(testConnectivityFn);
    metacopierSecret.grantRead(previewTradeManagementFn);
    metacopierSecret.grantRead(applyTradeManagementFn);
    metacopierSecret.grantRead(getSocketFeatureStatusFn);
    metacopierSecret.grantRead(enableSocketFeatureFn);
    metacopierSecret.grantRead(getTradeHistoryFn);
    metacopierSecret.grantRead(runRuntimeSyncFn);
    metacopierSecret.grantRead(telegramWebhookFn);
    metacopierSecret.grantRead(workerTaskDef.taskRole);

    new events.Rule(this, "RuntimeSyncScheduleRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(runRuntimeSyncFn)]
    });

    const corsOrigins = (
      process.env.CORS_ALLOW_ORIGINS?.trim() ||
      "http://localhost:5173,https://drppa7twrc4zh.cloudfront.net"
    )
      .split(",")
      .map((origin) => toOrigin(origin))
      .filter(Boolean);

    const httpApi = new apigwv2.HttpApi(this, "TradingCopierApi", {
      apiName: "tradingcopier-api",
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: cdk.Duration.days(10)
      }
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
      path: "/admin/socket-feature-status",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "GetSocketFeatureStatusIntegration",
        getSocketFeatureStatusFn
      ),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/admin/enable-socket-feature",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("EnableSocketFeatureIntegration", enableSocketFeatureFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/management/lot-size-config",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("GetLotSizeConfigIntegration", getLotSizeConfigFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/management/lot-size-config",
      methods: [apigwv2.HttpMethod.PUT],
      integration: new integrations.HttpLambdaIntegration("UpdateLotSizeConfigIntegration", updateLotSizeConfigFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/management/target-accounts-config",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "GetTargetAccountsConfigIntegration",
        getTargetAccountsConfigFn
      ),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/management/target-accounts-config",
      methods: [apigwv2.HttpMethod.PUT],
      integration: new integrations.HttpLambdaIntegration(
        "UpdateTargetAccountsConfigIntegration",
        updateTargetAccountsConfigFn
      ),
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

    httpApi.addRoutes({
      path: "/trade/{signalId}/manage/preview",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("PreviewTradeManagementIntegration", previewTradeManagementFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/trade/{signalId}/manage/apply",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("ApplyTradeManagementIntegration", applyTradeManagementFn),
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/telegram/webhook",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("TelegramWebhookIntegration", telegramWebhookFn)
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

    new cdk.CfnOutput(this, "BreakevenWorkerServiceName", {
      value: workerService.serviceName
    });

    new cdk.CfnOutput(this, "CognitoHostedUiDomain", {
      value: domain.baseUrl()
    });
  }
}
