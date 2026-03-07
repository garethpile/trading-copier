import test from "node:test";
import assert from "node:assert/strict";
import { parseSignal } from "../src/parsers/signalParser";

test("parse sample signal", () => {
  const input = `XAUUSD | Potential downward movement

XAUUSD | SELL 5102

❌ Stop Loss 5110 (80 pips)

✅TP1 5094
✅TP2 5088
✅TP3 5075`;

  const result = parseSignal(input);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.trade, {
    symbol: "XAUUSD",
    side: "SELL",
    entry: 5102,
    stopLoss: 5110,
    takeProfits: [5094, 5088, 5075],
    comment: "Potential downward movement"
  });
});

test("missing required fields", () => {
  const input = "XAUUSD | SELL";
  const result = parseSignal(input);

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});
