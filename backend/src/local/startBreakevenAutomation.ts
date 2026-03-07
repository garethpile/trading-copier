import "dotenv/config";
import { TradeRepository } from "../repositories/TradeRepository";
import { BreakevenWebsocketAutomation } from "../services/BreakevenWebsocketAutomation";

const tableName = process.env.TRADE_SIGNALS_TABLE;
if (!tableName) {
  throw new Error("TRADE_SIGNALS_TABLE is required");
}

const repository = new TradeRepository(tableName);
const worker = new BreakevenWebsocketAutomation(repository);

console.log("Starting break-even websocket automation worker...");
worker.start();
