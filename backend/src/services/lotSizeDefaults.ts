import { SymbolConfig } from "../models/types";

export const DEFAULT_FALLBACK_LOT_SIZE = 0.01;

export const DEFAULT_SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  BTCUSD: { lotSize: 0.01, destinationBrokerSymbol: "BTCUSD+" },
  CADJPY: { lotSize: 0.05, destinationBrokerSymbol: "CADJPY+" },
  EURAUD: { lotSize: 0.01, destinationBrokerSymbol: "EURAUD+" },
  EURNZD: { lotSize: 0.05, destinationBrokerSymbol: "EURNZD+" },
  EURUSD: { lotSize: 0.01, destinationBrokerSymbol: "EURUSD+" },
  NZDJPY: { lotSize: 0.05, destinationBrokerSymbol: "NZDJPY+" },
  XAUUSD: { lotSize: 0.02, destinationBrokerSymbol: "XAUUSD+" }
};
