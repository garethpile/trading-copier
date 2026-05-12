import { ParseSignalResponse, ParsedTrade, TradeOrderType, TradeSide, TradeTemplate } from "../models/types";

const normalizeInput = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[│┃¦｜]/g, "|")
    .replace(/\u00A0/g, " ");

const stripDecorators = (line: string): string =>
  line
    .replace(/[✅❌🟢🔴⚠️🔥⭐]+/g, "")
    .replace(/^[-*•\s]+/, "")
    .trim();

const parseNumber = (raw?: string): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

const finalizeTrade = (input: {
  symbol?: string;
  side?: TradeSide;
  orderType: TradeOrderType;
  entry?: number;
  stopLoss?: number;
  takeProfits: number[];
  comment?: string;
  warnings: string[];
  errors: string[];
  template: TradeTemplate;
  entryRangeLow?: number;
  entryRangeHigh?: number;
}) => {
  const { warnings, errors } = input;
  if (!input.symbol) errors.push("Missing symbol");
  if (!input.side) errors.push("Missing side (BUY or SELL)");
  if (input.entry === undefined) errors.push("Missing entry");
  if (input.stopLoss === undefined) errors.push("Missing stop loss");
  if (input.takeProfits.length === 0) {
    errors.push("At least one take profit (TP1/TP2/TP3) is required");
  }

  if (input.side && input.entry !== undefined && input.stopLoss !== undefined) {
    if (input.side === "SELL" && input.stopLoss <= input.entry) {
      warnings.push("SELL trade usually has stop loss above entry");
    }
    if (input.side === "BUY" && input.stopLoss >= input.entry) {
      warnings.push("BUY trade usually has stop loss below entry");
    }

    if (input.takeProfits.length > 0) {
      if (input.side === "SELL" && input.takeProfits.some((tp) => tp >= input.entry!)) {
        warnings.push("One or more take profits are not below entry for SELL");
      }
      if (input.side === "BUY" && input.takeProfits.some((tp) => tp <= input.entry!)) {
        warnings.push("One or more take profits are not above entry for BUY");
      }
    }
  }

  const valid = errors.length === 0;
  const trade: ParsedTrade | undefined = valid
    ? {
        symbol: input.symbol!,
        side: input.side!,
        orderType: input.orderType,
        entry: input.entry!,
        stopLoss: input.stopLoss!,
        takeProfits: input.takeProfits,
        template: input.template,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.entryRangeLow !== undefined ? { entryRangeLow: input.entryRangeLow } : {}),
        ...(input.entryRangeHigh !== undefined ? { entryRangeHigh: input.entryRangeHigh } : {})
      }
    : undefined;

  return { valid, trade, warnings, errors } satisfies ParseSignalResponse;
};

const parseEvoluteSignal = (rawMessage: string): ParseSignalResponse => {
  const warnings: string[] = [];
  const errors: string[] = [];

  const lines = normalizeInput(rawMessage)
    .split(/\r?\n/)
    .map(stripDecorators)
    .filter(Boolean);

  let symbol: string | undefined;
  let side: TradeSide | undefined;
  let orderType: TradeOrderType = "MARKET";
  let entry: number | undefined;
  let stopLoss: number | undefined;
  const tps: Array<{ index: number; value: number }> = [];
  let comment: string | undefined;

  for (const line of lines) {
    const entryLineMatch = line.match(
      /^([A-Z0-9]{3,10})\s*\|\s*(BUY|SELL)(?:\s+(LIMIT))?\s+([0-9]+(?:\.[0-9]+)?)$/i
    );
    if (entryLineMatch) {
      symbol = entryLineMatch[1].toUpperCase();
      side = entryLineMatch[2].toUpperCase() as TradeSide;
      orderType = entryLineMatch[3] ? "LIMIT" : "MARKET";
      entry = parseNumber(entryLineMatch[4]);
      continue;
    }

    const commentMatch = line.match(/^([A-Z0-9]{3,10})\s*\|\s*(?!BUY\b|SELL\b)(.+)$/i);
    if (commentMatch) {
      symbol ??= commentMatch[1].toUpperCase();
      comment = commentMatch[2].trim();
      continue;
    }

    const stopLossMatch = line.match(/^(?:SL|STOP\s*LOSS)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (stopLossMatch) {
      stopLoss = parseNumber(stopLossMatch[1]);
      continue;
    }

    const tpMatch = line.match(/^TP\s*([1-9])\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (tpMatch) {
      const idx = Number(tpMatch[1]);
      const val = parseNumber(tpMatch[2]);
      if (val !== undefined) {
        tps.push({ index: idx, value: val });
      }
      continue;
    }
  }

  return finalizeTrade({
    symbol,
    side,
    orderType,
    entry,
    stopLoss,
    takeProfits: tps.sort((a, b) => a.index - b.index).map((t) => t.value),
    comment,
    warnings,
    errors,
    template: "EVOLUTE"
  });
};

const parseVipGoldSignal = (rawMessage: string): ParseSignalResponse => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const lines = normalizeInput(rawMessage)
    .split(/\r?\n/)
    .map(stripDecorators)
    .filter(Boolean);

  let symbol: string | undefined;
  let side: TradeSide | undefined;
  let stopLoss: number | undefined;
  const takeProfits: number[] = [];
  let comment: string | undefined;
  let entryRangeLow: number | undefined;
  let entryRangeHigh: number | undefined;

  for (const line of lines) {
    const entryRangeMatch = line.match(/([A-Z0-9]{3,10}(?:\/[A-Z0-9]{3,10})?)\s+(BUY|SELL)\s+([0-9]+(?:\.[0-9]+)?)\s*[-–]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (entryRangeMatch) {
      symbol = entryRangeMatch[1].replace(/\//g, "").toUpperCase();
      side = entryRangeMatch[2].toUpperCase() as TradeSide;
      const a = parseNumber(entryRangeMatch[3]);
      const b = parseNumber(entryRangeMatch[4]);
      if (a !== undefined && b !== undefined) {
        entryRangeLow = Math.min(a, b);
        entryRangeHigh = Math.max(a, b);
      }
      continue;
    }

    const stopLossMatch = line.match(/(?:SL|STOP\s*LOSS|STOPLOSS)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (stopLossMatch) {
      stopLoss = parseNumber(stopLossMatch[1]);
      continue;
    }

    const genericTpMatch = line.match(/(?:TP\s*[1-9]?|TAKE\s*PROFIT)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (genericTpMatch) {
      const tp = parseNumber(genericTpMatch[1]);
      if (tp !== undefined) takeProfits.push(tp);
      continue;
    }

    if (!comment && /acting as:|demand zone|support area|retest zone|bullish|bearish/i.test(line)) {
      comment = line.trim();
    }
  }

  const boundaryEntry =
    side === "BUY"
      ? entryRangeHigh
      : side === "SELL"
        ? entryRangeLow
        : undefined;

  return finalizeTrade({
    symbol,
    side,
    orderType: "LIMIT",
    entry: boundaryEntry,
    stopLoss,
    takeProfits,
    comment,
    warnings,
    errors,
    template: "VIPGOLD",
    entryRangeLow,
    entryRangeHigh
  });
};

export const parseSignal = (rawMessage: string, options?: { template?: TradeTemplate }): ParseSignalResponse => {
  const template = options?.template ?? "EVOLUTE";
  return template === "VIPGOLD" ? parseVipGoldSignal(rawMessage) : parseEvoluteSignal(rawMessage);
};
