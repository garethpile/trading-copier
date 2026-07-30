# TradingCopier Architecture

## Document Update History

| Date | Update | Author |
| --- | --- | --- |
| 2026-07-23 | Updated deployment/config notes with the actual live AWS account, region, stack, and deploy profile mapping; documented that no separate AWS dev/test stack is currently wired in the repo; documented current VIPGold 4-leg same-entry behavior and its staged stop-management rules. | Codex |
| 2026-04-14 | Added Telegram-only `/mode test` dry-run behavior, documented caption normalization before parsing, and documented that Lambda deploys from compiled `backend/dist`, not `backend/src`. | Codex |
| 2026-03-29 | Updated the architecture document to reflect explicit `risktrades` TP-leg selection and the Telegram `/risktrades` command. | Codex |
| 2026-03-23 | Created the current-state as-is architecture document for TradingCopier based on the active repository and live deployment shape. | Codex |

## DEPLOYMENTS

This section lists the currently identifiable deployment locations so users can quickly check the live environment footprint.

| Environment | Friendly URL | API URL | Current Repo Evidence |
| --- | --- | --- | --- |
| Dev | Not currently defined in the active repo configuration. | Not currently defined in the active repo configuration. | The repository contains local development entrypoints and AWS profiles for a dev account, but no separate deployed `TradingCopier` dev stack is currently defined in the active CDK app. |
| Test | Not currently defined in the active repo configuration. | Not currently defined in the active repo configuration. | No dedicated test stack, hostname, or environment mapping is defined in the active CDK stack. |
| Prod | Not currently defined as a custom domain in the active repo configuration. | `https://ygkpu00da4.execute-api.eu-west-1.amazonaws.com` | The active CloudFormation stack is `TradingCopierStack` in AWS account `732439976770`, region `eu-west-1`, and the stack outputs expose the API base URL from API Gateway. |

Active stack names to check in AWS CloudFormation for the live environment:

- `TradingCopierStack`

### Current Deploy Profile Mapping

- **Live/prod deploy profile:** `aws-lean-prod-pile-eu-west-1`
- **Observed live AWS account:** `732439976770`
- **Observed live region:** `eu-west-1`
- **Observed live stack:** `TradingCopierStack`
- **Repo-level dev profile present locally but not mapped to an active AWS stack in this CDK app:** `aws-lean-dev-pile-eu-west-1`

### Current Environment Reality

- This repository currently has **one active AWS CDK stack target** for TradingCopier: `TradingCopierStack` in `eu-west-1`.
- The repository does include local development entrypoints and local AWS profile material, but it does **not** currently define a separate deployed AWS `dev` or `test` TradingCopier stack.
- In practical operator terms, "deploy to dev" is currently limited to local build/test/synth or a future explicit non-prod stack that still needs to be added to the repo.

## Purpose

This document describes the current-state architecture of TradingCopier.

> **Live AWS region:** `eu-west-1`
> 
> TradingCopier production state, including the live `TradeSignals` DynamoDB table checked for execution records, currently runs in AWS region `eu-west-1`.

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
- configurable TP-leg selection through `risktrades` values such as `1`, `1,2`, `1,2,3`, or `1,2,3,4`
- multi-leg TP execution against MetaCopier
- VIPGold-specific multi-order execution with a shared entry price and staged post-TP stop-loss management
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
- resolve the configured `risktrades` TP-leg subset
- generate per-leg request IDs
- submit one MetaCopier trade per TP leg
- persist combined execution results and high-level status
- apply template-specific execution plans such as the current VIPGold four-leg same-entry plan

High-level statuses currently used:

- `EXECUTING`
- `EXECUTED`
- `PARTIAL`
- `FAILED`

### Telegram Intake Runtime

Telegram intake runs through `TelegramWebhookFn`.

Responsibilities:

- receive Telegram webhook updates from Telegram
- normalize Telegram text and photo captions into parser-compatible trade lines before parsing
- parse signal messages
- resolve execution mode and target account
- resolve symbol mapping and lot size before execution
- expose limited Telegram control commands for execution mode, dry-run test mode, TP-leg selection, lot override, history, runtime sync, and news feed operations
- support Telegram-side VIPGold execution planning before handing off to the execution service
- call the execution service with an already-resolved execution request
- reply back into the Telegram chat with submission and result feedback

Current optimization:

- lot-size and target-account config bundles are cached in warm Lambda memory by `configUserId`
- `/metadatarefresh` forces a config reload in the webhook runtime
- Telegram photo-caption intake strips non-signal commentary, normalizes `Stop Loss` to `SL`, removes decorative emoji/pip suffix noise, and preserves the parser-required `SYMBOL | BUY/SELL entry` delimiter format
- Telegram `/mode test` is a chat-level dry-run override: it resolves symbol, lot, target account, and TP-leg selection exactly like a live submission but stops before `ExecutionService` calls MetaCopier
- Telegram `/risktrades` currently accepts up to leg `4` (`1`, `2`, `3`, `4`) even though the main live special case is the VIPGold four-leg template rather than the default multi-TP path

Deployment note:

- the production Telegram webhook Lambda is packaged from compiled backend output at `backend/dist`; changes under `backend/src` do not reach Lambda until the backend is rebuilt before CDK deploy

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
- read and update the explicit `risktrades` TP-leg list stored with target-account configuration

### Telegram Flow

- receive inbound Telegram updates
- enforce allowed chat and user rules when configured
- parse and execute supported signal messages
- serve limited operational commands such as `/mode`, `/mode test`, `/risktrades`, `/lot`, `/history`, `/admin`, `/sync`, and news-feed controls
- for VIPGold signals, expand the parsed signal into the current four-trade execution plan before submitting to MetaCopier

### System-To-System Flow

- Telegram webhook callback into API Gateway and Lambda
- MetaCopier REST execution calls
- MetaCopier websocket account updates into the ECS worker
- EventBridge scheduled runtime reconciliation

## Canonical Runtime Flow

1. A signal arrives from the web UI or Telegram.
2. For Telegram intake, the webhook normalizes text or photo captions into parser-compatible trade lines.
3. The normalized signal is parsed into the internal trade model.
4. The system resolves execution mode, target account, symbol mapping, lot size, and the configured `risktrades` TP-leg list.
5. The execution service creates a signal record and dedupe lock in DynamoDB.
6. The execution provider submits one MetaCopier order only for the selected TP legs using app-generated request IDs.
7. The system stores per-leg execution IDs, request IDs, and provider responses in the trade record.
8. Once a live position exists, the runtime applies signal-magnitude rebase so the SL and TP distances match the original signal from the actual fill price.
9. MetaCopier websocket events update open-position and history snapshots in the ECS worker.
10. For the current VIPGold strategy, the Telegram runtime expands a parsed zone signal into four limit orders using the same entry price placed $1 inside the nearest zone boundary.
11. In the current VIPGold plan, trades 1 and 2 target TP1, trade 3 targets the midpoint between TP1 and TP2, and trade 4 targets TP2.
12. When VIPGold trades 1 and 2 are both confirmed closed at TP1, the worker moves trades 3 and 4 to break-even.
13. When VIPGold trade 3 is confirmed closed at its midpoint TP, the worker moves trade 4 stop loss to TP1.
14. DynamoDB is updated only when runtime state, management state, or error state materially changes.
15. Operators can inspect the resulting trade state through the history and trade-detail APIs.

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
- The observed production deploy profile used operationally is `aws-lean-prod-pile-eu-west-1`.
- No separate AWS `dev` or `test` TradingCopier stack is currently defined in the active CDK app, even though local development entrypoints and non-prod profile material exist on the operator machine.
- The active architecture intentionally keeps partial executions live and managed.
- A leg is expected to be considered `CLOSED` only when actual broker close evidence is available, not merely because it is absent from the latest open-position snapshot.
