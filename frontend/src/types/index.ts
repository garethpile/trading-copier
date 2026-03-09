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

export interface ExecuteTradeResponse {
  status: "EXECUTED" | "FAILED" | "REJECTED";
  signalId?: string;
  executionId?: string;
  provider?: string;
  message: string;
  errors?: string[];
  warnings?: string[];
}

export interface TradeRecord {
  signalId: string;
  symbol: string;
  side: TradeSide;
  orderType?: TradeOrderType;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  targetAccount: string;
  lotSize: number;
  status: string;
  executionId?: string;
  provider?: string;
  createdAt: string;
  executedAt?: string;
  errorMessage?: string;
  providerResponse?: unknown;
}

export interface ConnectivityTestResponse {
  status: "OK" | "FAILED";
  provider: string;
  message: string;
  response?: unknown;
  error?: string;
}

export interface SocketFeatureStatusResponse {
  status: "ENABLED" | "DISABLED" | "UNKNOWN";
  accountId: string;
  details?: unknown;
}

export interface SocketFeatureEnableResponse {
  success: boolean;
  accountId: string;
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
}

export interface TargetAccountsConfig {
  accounts: string[];
  updatedAt?: string;
}
