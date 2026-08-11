import test from "node:test";
import assert from "node:assert/strict";
import { parseSignal } from "../src/parsers/signalParser";
import {
  buildVipGoldExecutionPlan,
  resolveTelegramExecutionMode,
  resolveTelegramSignalText
} from "../src/handlers/telegramWebhook";

test("resolveTelegramSignalText prefers text when present", () => {
  const result = resolveTelegramSignalText({
    text: "EURGBP | BUY 0.86882",
    caption: "ignored caption"
  });

  assert.equal(result, "EURGBP | BUY 0.86882");
});

test("resolveTelegramSignalText falls back to caption for photo signals", () => {
  const result = resolveTelegramSignalText({
    caption: `EURGBP| Potential upward movement

EURGBP| BUY 0.86882

❌ Stop Loss 0.86575(30 pips)

✅TP1 0.87080
✅TP2 0.87182
✅TP3 0.87803`
  });

  assert.equal(
    result,
    ["EURGBP | BUY 0.86882", "SL 0.86575", "TP1 0.87080", "TP2 0.87182", "TP3 0.87803"].join("\n")
  );

  const parsed = parseSignal(result);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.trade, {
    symbol: "EURGBP",
    side: "BUY",
    orderType: "MARKET",
    entry: 0.86882,
    stopLoss: 0.86575,
    takeProfits: [0.8708, 0.87182, 0.87803],
    template: "EVOLUTE"
  });
});

test("resolveTelegramSignalText normalizes bot commands in text", () => {
  const result = resolveTelegramSignalText({
    text: "/MODE@TradingCopierBot live"
  });

  assert.equal(result, "/mode live");
});

test("resolveTelegramSignalText preserves parser-compatible entry line delimiters", () => {
  const result = resolveTelegramSignalText({
    caption: `EURUSD| Potential upward movement

EURUSD| BUY 1.16867

❌ Stop Loss 1.16567(30 pips)

✅TP1 1.17067
✅TP2 1.17166
✅TP3 1.17467`
  });

  assert.match(result, /^EURUSD \| BUY 1\.16867$/m);

  const parsed = parseSignal(result);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.errors, []);
});

test("resolveTelegramExecutionMode prefers telegram profile override including TEST", () => {
  assert.equal(resolveTelegramExecutionMode({ executionMode: "TEST" }, { executionMode: "DEMO" }), "TEST");
  assert.equal(resolveTelegramExecutionMode({ executionMode: "LIVE" }, { executionMode: "DEMO" }), "LIVE");
  assert.equal(resolveTelegramExecutionMode(undefined, { executionMode: "LIVE" }), "LIVE");
  assert.equal(resolveTelegramExecutionMode(undefined, {}), "DEMO");
});

test("buildVipGoldExecutionPlan puts BUY legs 1-2 at the near boundary and legs 3-4 at midpoint", () => {
  const plan = buildVipGoldExecutionPlan({
    symbol: "XAUUSD",
    side: "BUY",
    orderType: "LIMIT",
    entry: 3340,
    stopLoss: 3325,
    takeProfits: [3350, 3360],
    template: "VIPGOLD",
    entryRangeLow: 3330,
    entryRangeHigh: 3340
  });

  assert.deepEqual(plan, [
    { leg: 1, entry: 3340, takeProfit: 3350 },
    { leg: 2, entry: 3340, takeProfit: 3350 },
    { leg: 3, entry: 3335, takeProfit: 3355 },
    { leg: 4, entry: 3335, takeProfit: 3360 }
  ]);
});

test("buildVipGoldExecutionPlan puts SELL legs 1-2 at the near boundary and legs 3-4 at midpoint", () => {
  const plan = buildVipGoldExecutionPlan({
    symbol: "XAUUSD",
    side: "SELL",
    orderType: "LIMIT",
    entry: 3330,
    stopLoss: 3345,
    takeProfits: [3320, 3310],
    template: "VIPGOLD",
    entryRangeLow: 3330,
    entryRangeHigh: 3340
  });

  assert.deepEqual(plan, [
    { leg: 1, entry: 3330, takeProfit: 3320 },
    { leg: 2, entry: 3330, takeProfit: 3320 },
    { leg: 3, entry: 3335, takeProfit: 3315 },
    { leg: 4, entry: 3335, takeProfit: 3310 }
  ]);
});
