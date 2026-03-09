import crypto from "node:crypto";

export const makeSignalId = (createdAt: string): string => {
  const compact = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `sig_${compact}_${crypto.randomBytes(3).toString("hex")}`;
};

export const makeDedupeKey = (input: {
  symbol: string;
  side: string;
  orderType: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  targetAccount: string;
  lotSize: number;
}): string => {
  return [
    input.symbol,
    input.side,
    input.orderType,
    input.entry,
    input.stopLoss,
    ...input.takeProfits,
    input.targetAccount,
    input.lotSize
  ]
    .join("|")
    .toLowerCase();
};
