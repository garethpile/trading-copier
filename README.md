# TradingCopier MVP

Secure single-user trade intake and approval web app.

## Monorepo Structure

- `frontend`: React + TypeScript UI
- `backend`: AWS Lambda TypeScript handlers and services
- `infra/cdk`: AWS CDK stack (Cognito, API, DynamoDB, Secrets)

## MVP Features Implemented

- Cognito-authenticated frontend login
- Paste raw signal and parse preview (`POST /parse-signal`)
- Deterministic regex parser for open-trade signals
- Approval + execute flow (`POST /execute-trade`)
- Fast resolved execution flow for bot-driven intake (`POST /execute-trade-fast`)
- Market execution mode (entry price treated as reference; order executes at current market price)
- MetaCopier connectivity test (`POST /connectivity-test`)
- Optional WebSocket break-even automation worker (TP1 close -> move TP2/TP3 SL to BE)
- Backend re-validation before execution
- Idempotency/duplicate protection via dedupe lock in DynamoDB
- Trade audit persistence to `TradeSignals` table
- Trade history (`GET /trade-history`)
- Optional trade detail (`GET /trade/{signalId}`)
- MetaCopier provider adapter abstraction

## Local Build

```bash
npm run install:all
npm run build
npm test
```

## Local End-to-End Emulation (No AWS Deploy)

This runs the full API contract locally:
- `POST /parse-signal`
- `POST /execute-trade`
- `GET /trade-history`
- `GET /trade/{signalId}`

It uses:
- local API shim that invokes the same Lambda handlers
- DynamoDB Local in Docker
- mock execution provider (`EXECUTION_PROVIDER=mock`)
- frontend local auth bypass (no Cognito required)

```bash
cp backend/.env.local.example backend/.env
cp frontend/.env.local.example frontend/.env
npm run local:dynamodb
npm run local:table
```

Start backend local API:

```bash
npm run local:api
```

In another terminal, start frontend:

```bash
npm run local:web
```

Open `http://localhost:5173`.

Start break-even automation worker (optional, separate terminal):

```bash
npm run -w backend dev:be-automation
```

Notes for automation:
- MetaCopier account must have the **Socket** feature enabled.
- Worker subscribes to `/user/queue/accounts/changes` on `wss://api.metacopier.io/ws/api/v1`.
- When TP1 leg is detected as closed, worker attempts `PUT /rest/api/v1/accounts/{accountId}/positions/{positionId}` for remaining open legs.

## Frontend Run (AWS Cognito)

```bash
cp frontend/.env.example frontend/.env
npm run -w frontend dev
```

## Backend Notes

The backend is intended for Lambda deployment through CDK. Configure values from `backend/.env.example` via Lambda environment variables.

## Deploy Infra (CDK)

```bash
npm run -w backend build
export METACOPIER_API_KEY='your-real-api-key'
export CDK_DEFAULT_REGION='eu-west-1'
npm run -w infra/cdk synth
npm run -w infra/cdk deploy
```

MetaCopier integration defaults:
- Trading host: `https://api-london.metacopier.io`
- Global host (non-trading endpoints): `https://api.metacopier.io`
- Auth header: `X-API-KEY`
- Trade open endpoint: `POST /rest/api/v1/accounts/{accountId}/positions`

## Important Operational Notes

- Set real MetaCopier API base URL and secret before executing live trades.
- Create the single Cognito user manually (or automate later).
- This MVP supports open-trade signal parsing only (no modifications/closures).
Set real MetaCopier API base URL and secret before executing live trades.
- Create the single Cognito user manually (or automate later).
- This MVP supports open-trade signal parsing only (no modifications/closures).
