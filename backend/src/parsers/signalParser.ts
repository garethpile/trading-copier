import { ParseSignalResponse, ParsedTrade, TradeSide } from "../models/types";

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

export const parseSignal = (rawMessage: string): ParseSignalResponse => {
  const warnings: string[] = [];
  const errors: string[] = [];

  const lines = rawMessage
    .split(/\r?\n/)
    .map(stripDecorators)
    .filter(Boolean);

  let symbol: string | undefined;
  let side: TradeSide | undefined;
  let entry: number | undefined;
  let stopLoss: number | undefined;
  const tps: Array<{ index: number; value: number }> = [];
  let comment: string | undefined;

  for (const line of lines) {
    const entryLineMatch = line.match(/^([A-Z0-9]{3,10})\s*\|\s*(BUY|SELL)\s+([0-9]+(?:\.[0-9]+)?)$/i);
    if (entryLineMatch) {
      symbol = entryLineMatch[1].toUpperCase();
      side = entryLineMatch[2].toUpperCase() as TradeSide;
      entry = parseNumber(entryLineMatch[3]);
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

  if (!symbol) errors.push("Missing symbol");
  if (!side) errors.push("Missing side (BUY or SELL)");
  if (entry === undefined) errors.push("Missing entry");
  if (stopLoss === undefined) errors.push("Missing stop loss");

  const takeProfits = tps
    .sort((a, b) => a.index - b.index)
    .map((t) => t.value);

  if (takeProfits.length === 0) {
    errors.push("At least one take profit (TP1/TP2/TP3) is required");
  }

  if (side && entry !== undefined && stopLoss !== undefined) {
    if (side === "SELL" && stopLoss <= entry) {
      warnings.push("SELL trade usually has stop loss above entry");
    }
    if (side === "BUY" && stopLoss >= entry) {
      warnings.push("BUY trade usually has stop loss below entry");
    }

    if (takeProfits.length > 0) {
      if (side === "SELL" && takeProfits.some((tp) => tp >= entry)) {
        warnings.push("One or more take profits are not below entry for SELL");
      }
      if (side === "BUY" && takeProfits.some((tp) => tp <= entry)) {
        warnings.push("One or more take profits are not above entry for BUY");
      }
    }
  }

  const valid = errors.length === 0;
  const trade: ParsedTrade | undefined = valid
    ? {
        symbol: symbol!,
        side: side!,
        entry: entry!,
        stopLoss: stopLoss!,
        takeProfits,
        ...(comment ? { comment } : {})
      }
    : undefined;

  return {
    valid,
    trade,
    warnings,
    errors
  };
};
