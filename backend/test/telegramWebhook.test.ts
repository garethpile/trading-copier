import test from "node:test";
import assert from "node:assert/strict";
import { resolveTelegramSignalText } from "../src/handlers/telegramWebhook";

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

  assert.match(result, /^EURGBP\| Potential upward movement/);
  assert.match(result, /BUY 0\.86882/);
  assert.match(result, /TP3 0\.87803/);
});

test("resolveTelegramSignalText normalizes bot commands in text", () => {
  const result = resolveTelegramSignalText({
    text: "/MODE@TradingCopierBot live"
  });

  assert.equal(result, "/mode live");
});
