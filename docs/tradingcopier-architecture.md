# TradingCopier Architecture

## Document Update History

| Date | Update | Author |
| --- | --- | --- |
| 2026-03-23 | Created the current-state as-is architecture document for TradingCopier based on the active repository and live deployment shape. | Codex |

## DEPLOYMENTS

This section lists the currently identifiable deployment locations so users can quickly check the live environment footprint.

| Environment | Friendly URL | API URL | Current Repo Evidence |
| --- | --- | --- | --- |
| Dev | Not currently defined in the active repo configuration. | Not currently defined in the active repo configuration. | The repository contains local development entrypoints and AWS profiles for a dev account, but no active `TradingCopier` stack was present in the checked dev regions at the time this document was written. |
| Test | Not currently defined in the active repo configuration. | Not currently defined in the active repo configuration. | No dedicated test stack, hostname, or environment mapping is defined in the active CDK stack. |
| Prod | Not currently defined as a custom domain in the active repo configuration. | `https://ygkpu00da4.execute-api.eu-west-1.amazonaws.com` | The active CloudFormation stack is `TradingCopierStack` in AWS account `732439976770`, region `eu-west-1`, and the stack outputs expose the API base URL from API Gateway. |

Active stack names to check in AWS CloudFormation for the live environment:

- `TradingCopierStack`

## Purpose

This document describes the current-state architecture of TradingCopier.

TradingCopier is a signal-intake and trade-execution platform where:

- a trade signal is received from the web UI or Telegram
- the signal is parsed into a structured trade model
- account-specific symbol and lot-size mapping is resolved
- the trade is submitted to MetaCopier as multiple TP legs
- execution results are persisted in DynamoDB
- post-fill trade management updates are applied to open legs
- websocket and scheduled runtime processes keep trade state aligned with broker feedback
- operators can review history, inspect a trade, and manually preview or apply management actions

This is an as-is architecture document. It describes the system as it currently stands and the active boundaries it is built around.

## Current Scope

The active platform covers:

- authenticated web-based signal parsing and execution
- Telegram-driven signal intake through a webhook endpoint
- configurable symbol mapping and lot sizing
- configurable target account selection for demo and live mode
- multi-leg TP execution against MetaCopier
- trade history and per-trade inspection
- manual trade-management preview and apply flows
- automatic post-fill signal rebase to preserve original risk and reward distances from actual fill price
- automatic break-even and final-leg stop management driven primarily by MetaCopier websocket events
- low-frequency scheduled reconciliation to recover from missed live state

## Current Constraints

- MetaCopier is the only active execution provider.
- The current live AWS stack is in `eu-west-1`.
- There is no active custom API domain in the current repo configuration.
- The trade record system-of-record is the `TradeSignals` DynamoDB table.
- Telegram intake currently runs as an AWS Lambda webhook, not as a permanently running bot process.
- Telegram config caching is warm-runtime Lambda memory caching, not a global distributed cache.
- Runtime trade management depends on matching broker positions and history back to app-issued leg `requestId` values.
- The ECS worker is event-driven from MetaCopier websocket updates, with a separate 5-minute fallback runtime sync.

## Current Runtime Architecture

### API And Auth: `TradingCopierStack`

This stack provides the authenticated HTTP API and the public Telegram webhook entrypoint.

Responsibilities:

- Cognito user authentication and hosted UI
- API Gateway routing
- Lambda execution for parsing, execution, management, config, and history APIs
- unauthenticated Telegram webhook intake

Primary API routes:

- `POST /parse-signal`
- `POST /execute-trade`
- `POST /connectivity-test`
- `GET /admin/socket-feature-status`
- `POST /admin/enable-socket-feature`
- `GET /management/lot-size-config`
- `PUT /management/lot-size-config`
- `GET /management/target-accounts-config`
- `PUT /management/target-accounts-config`
- `GET /trade-history`
- `GET /trade/{signalId}`
- `POST /trade/{signalId}/manage/preview`
- `POST /trade/{signalId}/manage/apply`
- `POST /telegram/webhook`

### Trade State Store: `TradeSignals`

This DynamoDB table is the platform system-of-record.

Responsibilities:

- trade request persistence
- execution result persistence
- dedupe locking
- runtime state tracking for each TP leg
- lot-size and symbol configuration storage
- target-account and execution-mode configuration storage
- Telegram profile and draft storage

Current table shape:

- primary key: `pk`, `sk`
- GSI: `gsi1` on `gsi1pk`, `gsi1sk`
- billing mode: `PAY_PER_REQUEST`
- removal policy: `RETAIN`

### Execution Runtime

The main execution path runs in Lambda through `ExecuteTradeFn`.

Responsibilities:

- validate the structured trade request
- resolve broker symbol mapping
- generate per-leg request IDs
- submit one MetaCopier trade per TP leg
- persist combined execution results and high-level status

High-level statuses currently used:

- `EXECUTING`
- `EXECUTED`
- `PARTIAL`
- `FAILED`

### Telegram Intake Runtime

Telegram intake runs through `TelegramWebhookFn`.

Responsibilities:

- receive Telegram webhook updates from Telegram
- parse signal messages
- resolve execution mode and target account
- resolve symbol mapping and lot size before execution
- call the execution service with an already-resolved execution request
- reply back into the Telegram chat with submission and result feedback

Current optimization:

- lot-size and target-account config bundles are cached in warm Lambda memory by `configUserId`
- `/metadatarefresh` forces a config reload in the webhook runtime

### Live Management Runtime

Live trade management is split across an event-driven worker and a scheduled reconciliation function.

#### Event-Driven Worker: `BreakevenWorkerService`

This is a single always-on ECS Fargate service.

Responsibilities:

- maintain a MetaCopier websocket connection
- receive `UpdateOpenPositionsDTO` and `UpdateHistoryDTO` events
- evaluate affected trades for post-fill management
- apply signal rebase, break-even, and final-leg stop movements
- persist runtime updates back to DynamoDB only when state materially changes

Current deployment shape:

- one Fargate task
- public subnets
- no load balancer
- no NAT gateway

#### Scheduled Reconciliation: `RunRuntimeSyncFn`

This Lambda runs every 5 minutes through EventBridge.

Responsibilities:

- reload recent multi-leg trades
- fetch current open positions from MetaCopier
- reconcile runtime state when websocket-driven handling missed an event
- update provider response only when trade state actually changes

This is a fallback path, not the primary trade-management driver.

## Provider Abstractions

The platform is structured around a stable internal trade model with provider-specific adapters behind it.

Current provider set:

- execution provider: `MetaCopierExecutionProvider`
- admin/socket provider access: `MetaCopierAdminService`

### Execution Interface

Current interface shape:

- `executeTrade()`
- `testConnectivity()`

### Runtime Management Interface

Current internal management capabilities include:

- `modifyPositionTargets()`
- `moveStopLossToBe()`
- websocket-driven position and history correlation
- scheduled open-position reconciliation

## Current API Areas

### Authenticated Trading Flow

- parse raw trade text into a structured signal
- execute a signal to a target account
- test MetaCopier connectivity
- inspect trade history
- inspect a single trade by signal ID
- preview manual management actions
- apply manual management actions

### Admin And Configuration Flow

- read socket feature status
- enable socket feature support
- read and update lot-size configuration
- read and update target-account configuration

### Telegram Flow

- receive inbound Telegram updates
- enforce allowed chat and user rules when configured
- parse and execute supported signal messages
- serve limited operational commands such as config refresh and mode-aware execution

### System-To-System Flow

- Telegram webhook callback into API Gateway and Lambda
- MetaCopier REST execution calls
- MetaCopier websocket account updates into the ECS worker
- EventBridge scheduled runtime reconciliation

## Canonical Runtime Flow

1. A signal arrives from the web UI or Telegram.
2. The signal is parsed into the internal trade model.
3. The system resolves execution mode, target account, symbol mapping, and lot size.
4. The execution service creates a signal record and dedupe lock in DynamoDB.
5. The execution provider submits one MetaCopier order per TP leg using app-generated request IDs.
6. The system stores per-leg execution IDs, request IDs, and provider responses in the trade record.
7. Once a live position exists, the runtime applies signal-magnitude rebase so the SL and TP distances match the original signal from the actual fill price.
8. MetaCopier websocket events update open-position and history snapshots in the ECS worker.
9. When TP1 is confirmed by matching close evidence, the worker moves the remaining open legs to break-even.
10. When TP2 is confirmed by matching close evidence, the worker moves the final open leg stop according to the configured final-leg logic.
11. DynamoDB is updated only when runtime state, management state, or error state materially changes.
12. Operators can inspect the resulting trade state through the history and trade-detail APIs.

## Current Reusable Assets

### Active And Reused

- `infra/cdk/lib/tradingcopier-stack.ts`
- `backend/src/services/ExecutionService.ts`
- `backend/src/providers/MetaCopierExecutionProvider.ts`
- `backend/src/services/BreakevenWebsocketAutomation.ts`
- `backend/src/services/TradeRuntimeSyncService.ts`
- `backend/src/repositories/TradeRepository.ts`

### Reused Selectively

- shared Lambda deployment pattern using a single compiled backend asset
- shared DynamoDB repository model for both trade and settings entities
- Cognito-protected API Gateway routes for authenticated operations

### Local Development Assets

- `backend/src/local/localApi.ts`
- `backend/src/local/createLocalTable.ts`
- `backend/src/local/startBreakevenAutomation.ts`

These support local development and testing but are not the production runtime path.

## Notes On Live State

- The production stack currently runs in AWS account `732439976770`, region `eu-west-1`.
- The production runtime includes one ECS websocket worker and one 5-minute scheduled reconciliation Lambda.
- The active architecture intentionally keeps partial executions live and managed.
- A leg is expected to be considered `CLOSED` only when actual broker close evidence is available, not merely because it is absent from the latest open-position snapshot.
