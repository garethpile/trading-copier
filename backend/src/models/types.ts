export type TradeSide = "BUY" | "SELL";
export type TradeOrderType = "MARKET" | "LIMIT";

export interface ParsedTrade {
  symbol: string;
  side: TradeSide;
  orderType: TradeOrderType;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  comment?: string;
}

export interface ParseSignalRequest {
  rawMessage: string;
}

export interface ParseSignalResponse {
  valid: boolean;
  trade?: ParsedTrade;
  warnings: string[];
  errors: string[];
}

export interface ExecuteTradeRequest {
  rawMessage: string;
  trade: ParsedTrade;
  targetAccount: string;
  lotSize: number;
  note?: string;
}

export interface ExecuteTradeResolvedRequest extends ExecuteTradeRequest {
  destinationBrokerSymbol: string;
  mode?: ExecutionMode;
  dedupeKey?: string;
  sourceMessageId?: string;
  receivedAt?: string;
}

export type TradeStatus = "PARSED" | "EXECUTING" | "EXECUTED" | "FAILED" | "REJECTED";

export interface TradeRecord {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "TRADE";
  signalId: string;
  userId: string;
  rawMessage: string;
  symbol: string;
  side: TradeSide;
  orderType?: TradeOrderType;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  comment?: string;
  targetAccount: string;
  lotSize: number;
  note?: string;
  status: TradeStatus;
  dedupeKey: string;
  parseWarnings: string[];
  provider: string;
  providerResponse?: unknown;
  executionId?: string;
  errorMessage?: string;
  createdAt: string;
  executedAt?: string;
}

export interface TradeExecutionResult {
  status: "EXECUTED" | "FAILED";
  executionId?: string;
  requestId?: number;
  providerResponse?: unknown;
  message: string;
}

export interface ConnectivityTestResult {
  status: "OK" | "FAILED";
  provider: string;
  message: string;
  response?: unknown;
}

export interface LotSizeConfig {
  defaultLotSize: number;
  symbols: Record<string, SymbolConfig>;
  updatedAt?: string;
}

export interface SymbolConfig {
  lotSize: number;
  destinationBrokerSymbol: string;
  accountDestinationSymbols?: Record<string, string>;
}

export interface UpdateLotSizeConfigRequest {
  defaultLotSize?: number;
  symbols?: Record<string, SymbolConfig>;
}

export interface TargetAccountsConfig {
  accounts: string[];
  executionMode?: ExecutionMode;
  modeAccounts?: Partial<Record<ExecutionMode, string>>;
  updatedAt?: string;
}

export type ExecutionMode = "DEMO" | "LIVE";

export interface TelegramDraft {
  chatId: string;
  rawMessage: string;
  trade: ParsedTrade;
  warnings: string[];
  targetAccount: string;
  lotSize: number;
  destinationBrokerSymbol: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramProfile {
  chatId: string;
  lotOverride?: number;
  lastProcessedUpdateId?: number;
  updatedAt: string;
}

export interface ExecutionProvider {
  executeTrade(input: {
    symbol: string;
    destinationBrokerSymbol?: string;
    side: TradeSide;
    orderType: TradeOrderType;
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    lotSize: number;
    targetAccount: string;
    note?: string;
    requestId?: number;
  }): Promise<TradeExecutionResult>;
  testConnectivity(): Promise<ConnectivityTestResult>;
}
