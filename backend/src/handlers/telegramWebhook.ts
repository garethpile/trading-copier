import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ExecuteTradeRequest, ExecutionMode, LotSizeConfig, ParsedTrade, TargetAccountsConfig } from "../models/types";
import { parseSignal } from "../parsers/signalParser";
import { TradeRepository } from "../repositories/TradeRepository";
import { ExecutionService } from "../services/ExecutionService";
import { validateExecutionRequest } from "../validators/tradeValidator";
import { jsonResponse } from "../utils/http";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; username?: string };
  };
};

const lotRange = () => ({
  min: Number(process.env.LOT_SIZE_MIN ?? "0.01"),
  max: Number(process.env.LOT_SIZE_MAX ?? "50")
});

const splitCsvSet = (value?: string): Set<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );

const normalizeText = (value?: string): string => (value ?? "").trim();

const modeAccount = (config: TargetAccountsConfig, mode: ExecutionMode): string => {
  const mapped = config.modeAccounts?.[mode];
  if (mapped && config.accounts.includes(mapped)) return mapped;
  if (mode === "LIVE") return config.accounts[1] ?? config.accounts[0] ?? "";
  return config.accounts[0] ?? "";
};

const formatPreview = (input: {
  trade: ParsedTrade;
  destinationBrokerSymbol: string;
  lotSize: number;
  targetAccount: string;
  mode: ExecutionMode;
  symbolCount: number;
}): string => {
  const tpText = input.trade.takeProfits.map((tp, idx) => `TP${idx + 1}: ${tp}`).join(" | ");
  return [
    "Trade Parsed -> Executing",
    `Mode: ${input.mode}`,
    `Symbol: ${input.trade.symbol} -> ${input.destinationBrokerSymbol}`,
    `Side/Type: ${input.trade.side} ${input.trade.orderType}`,
    `Entry: ${input.trade.entry}`,
    `SL: ${input.trade.stopLoss}`,
    tpText,
    `Account: ${input.targetAccount}`,
    `Lot: ${input.lotSize}`,
    `Mapped symbols loaded: ${input.symbolCount}`
  ].join("\n");
};

const formatExecutionLegs = (providerResponse: unknown): string[] => {
  if (!providerResponse || typeof providerResponse !== "object") return [];
  const legs = (providerResponse as { legs?: unknown }).legs;
  if (!Array.isArray(legs)) return [];
  return legs.map((raw) => {
    const leg = raw as { leg?: number; status?: string; message?: string; executionId?: string };
    return `TP${leg.leg ?? "?"}: ${leg.status ?? "UNKNOWN"}${leg.executionId ? ` (${leg.executionId})` : ""} - ${leg.message ?? "-"}`;
  });
};

const resolveConfigUserId = (chatId: string): string => process.env.TELEGRAM_CONFIG_USER_ID?.trim() || `telegram:${chatId}`;

const sendTelegramMessage = async (botToken: string, chatId: string, text: string): Promise<void> => {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
};

const isAllowed = (input: {
  chatId: string;
  userId?: string;
  allowedChats: Set<string>;
  allowedUsers: Set<string>;
}): boolean => {
  const chatAllowed = input.allowedChats.size === 0 || input.allowedChats.has(input.chatId);
  const userAllowed = input.allowedUsers.size === 0 || (input.userId ? input.allowedUsers.has(input.userId) : false);
  return chatAllowed && userAllowed;
};

const handleHistory = async (
  repository: TradeRepository,
  botToken: string,
  chatId: string,
  executionUserId: string
): Promise<void> => {
  const items = await repository.getHistory(executionUserId, 5);
  if (items.length === 0) {
    await sendTelegramMessage(botToken, chatId, "No trade history.");
    return;
  }
  const lines = items.map((item) => `${item.signalId} | ${item.symbol} ${item.side} ${item.orderType ?? "MARKET"} | ${item.status}`);
  await sendTelegramMessage(botToken, chatId, `Recent trades:\n${lines.join("\n")}`);
};

const handleAdmin = async (
  repository: TradeRepository,
  botToken: string,
  chatId: string,
  configUserId: string
): Promise<void> => {
  const lotConfig = await repository.getLotSizeConfig(configUserId);
  const targetConfig = await repository.getTargetAccountsConfig(configUserId);
  await sendTelegramMessage(
    botToken,
    chatId,
    [
      "Admin Summary",
      `Execution mode: ${targetConfig.executionMode ?? "DEMO"}`,
      `DEMO account: ${modeAccount(targetConfig, "DEMO") || "-"}`,
      `LIVE account: ${modeAccount(targetConfig, "LIVE") || "-"}`,
      `Default lot: ${lotConfig.defaultLotSize}`,
      `Configured symbols: ${Object.keys(lotConfig.symbols).length}`,
      "Use Web UI for full config updates."
    ].join("\n")
  );
};

const executeParsedTrade = async (input: {
  repository: TradeRepository;
  botToken: string;
  chatId: string;
  configUserId: string;
  executionUserId: string;
  rawMessage: string;
  parsedTrade: ParsedTrade;
  parseWarnings: string[];
  lotConfig: LotSizeConfig;
  targetConfig: TargetAccountsConfig;
  lotOverride?: number;
}) => {
  const mode = input.targetConfig.executionMode ?? "DEMO";
  const targetAccount = modeAccount(input.targetConfig, mode);
  if (!targetAccount) {
    await sendTelegramMessage(input.botToken, input.chatId, "Execution failed: no target account configured for current mode.");
    return;
  }

  const symbol = input.parsedTrade.symbol.toUpperCase();
  const symbolConfig = input.lotConfig.symbols[symbol];
  const destinationBrokerSymbol =
    symbolConfig?.accountDestinationSymbols?.[targetAccount] || symbolConfig?.destinationBrokerSymbol || symbol;
  const lotSize = input.lotOverride ?? symbolConfig?.lotSize ?? input.lotConfig.defaultLotSize;

  await sendTelegramMessage(
    input.botToken,
    input.chatId,
    formatPreview({
      trade: input.parsedTrade,
      destinationBrokerSymbol,
      lotSize,
      targetAccount,
      mode,
      symbolCount: Object.keys(input.lotConfig.symbols).length
    })
  );

  const request: ExecuteTradeRequest = {
    rawMessage: input.rawMessage,
    trade: input.parsedTrade,
    targetAccount,
    lotSize
  };

  const validationErrors = validateExecutionRequest(request, input.targetConfig.accounts, lotRange(), {
    requireProtectiveLevels: true
  });
  if (validationErrors.length > 0) {
    await sendTelegramMessage(input.botToken, input.chatId, `Validation failed:\n${validationErrors.join("\n")}`);
    return;
  }

  const executionService = new ExecutionService(input.repository);
  const result = await executionService.execute(input.executionUserId, request, input.parseWarnings, {
    configOwnerUserId: input.configUserId
  });
  const legLines = formatExecutionLegs((result as { providerResponse?: unknown }).providerResponse);
  await sendTelegramMessage(
    input.botToken,
    input.chatId,
    [
      `Execution: ${result.status}`,
      `Signal ID: ${result.signalId ?? "-"}`,
      `Message: ${result.message}`,
      ...(legLines.length > 0 ? ["Legs:", ...legLines] : [])
    ].join("\n")
  );
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const tableName = process.env.TRADE_SIGNALS_TABLE;
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (!tableName || !botToken) {
    return jsonResponse(500, { message: "Telegram webhook not configured" });
  }

  if (webhookSecret) {
    const providedSecret =
      normalizeText(event.headers["x-telegram-bot-api-secret-token"]) ||
      normalizeText(event.queryStringParameters?.secret);
    if (!providedSecret || providedSecret !== webhookSecret) {
      return jsonResponse(401, { message: "Unauthorized webhook" });
    }
  }

  const repository = new TradeRepository(tableName);
  const update = event.body ? (JSON.parse(event.body) as TelegramUpdate) : {};
  const updateId = typeof update.update_id === "number" ? update.update_id : undefined;
  const text = normalizeText(update.message?.text);
  const chatId = String(update.message?.chat?.id ?? "");
  const fromUserId = update.message?.from?.id !== undefined ? String(update.message.from.id) : undefined;
  if (!chatId || !text) {
    return jsonResponse(200, { ok: true });
  }

  const allowedChats = splitCsvSet(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const allowedUsers = splitCsvSet(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (!isAllowed({ chatId, userId: fromUserId, allowedChats, allowedUsers })) {
    return jsonResponse(200, { ok: true });
  }

  if (updateId !== undefined) {
    const accepted = await repository.claimTelegramUpdate(chatId, updateId);
    if (!accepted) {
      // Duplicate/older Telegram delivery, already handled.
      return jsonResponse(200, { ok: true, duplicate: true });
    }
  }

  const configUserId = resolveConfigUserId(chatId);
  // Use the config owner user id for execution records so Telegram and Web share one trade ledger/history.
  const executionUserId = configUserId;
  const lotConfig = await repository.getLotSizeConfig(configUserId);
  const targetConfig = await repository.getTargetAccountsConfig(configUserId);
  const profile = await repository.getTelegramProfile(chatId);

  if (text === "/start") {
    await sendTelegramMessage(
      botToken,
      chatId,
      [
        "Trading Copier Bot ready.",
        "Paste a signal and it will execute immediately.",
        `Mode: ${targetConfig.executionMode ?? "DEMO"}`,
        `DEMO account: ${modeAccount(targetConfig, "DEMO") || "-"}`,
        `LIVE account: ${modeAccount(targetConfig, "LIVE") || "-"}`,
        `Lot override: ${profile?.lotOverride ?? "none"}`,
        "Commands: /mode demo, /mode live, /lot <size>, /lot reset, /history, /admin",
        `Loaded symbols: ${Object.keys(lotConfig.symbols).length}`
      ].join("\n")
    );
    return jsonResponse(200, { ok: true });
  }

  if (text === "/history") {
    await handleHistory(repository, botToken, chatId, executionUserId);
    return jsonResponse(200, { ok: true });
  }

  if (text === "/admin") {
    await handleAdmin(repository, botToken, chatId, configUserId);
    return jsonResponse(200, { ok: true });
  }

  if (text.startsWith("/mode")) {
    const modeArg = text.split(/\s+/)[1]?.toUpperCase();
    if (modeArg !== "DEMO" && modeArg !== "LIVE") {
      await sendTelegramMessage(botToken, chatId, "Usage: /mode demo OR /mode live");
      return jsonResponse(200, { ok: true });
    }
    const nextMode = modeArg as ExecutionMode;
    const nextConfig: TargetAccountsConfig = {
      ...targetConfig,
      executionMode: nextMode,
      updatedAt: new Date().toISOString()
    };
    await repository.putTargetAccountsConfig(configUserId, nextConfig);
    await sendTelegramMessage(
      botToken,
      chatId,
      `Execution mode set to ${nextMode}. Active account: ${modeAccount(nextConfig, nextMode) || "-"}`
    );
    return jsonResponse(200, { ok: true });
  }

  if (text.startsWith("/lot")) {
    const parts = text.split(/\s+/).filter(Boolean);
    const arg = parts[1]?.toLowerCase();
    if (!arg) {
      await sendTelegramMessage(botToken, chatId, `Current lot override: ${profile?.lotOverride ?? "none"}`);
      return jsonResponse(200, { ok: true });
    }

    if (arg === "reset") {
      await repository.putTelegramProfile({ chatId, lotOverride: undefined, updatedAt: new Date().toISOString() });
      await sendTelegramMessage(botToken, chatId, "Lot override cleared.");
      return jsonResponse(200, { ok: true });
    }

    const newLot = Number(parts[1]);
    const range = lotRange();
    if (!Number.isFinite(newLot) || newLot < range.min || newLot > range.max) {
      await sendTelegramMessage(botToken, chatId, `Invalid lot. Allowed range: ${range.min} - ${range.max}`);
      return jsonResponse(200, { ok: true });
    }

    await repository.putTelegramProfile({ chatId, lotOverride: newLot, updatedAt: new Date().toISOString() });
    await sendTelegramMessage(botToken, chatId, `Lot override set to ${newLot}.`);
    return jsonResponse(200, { ok: true });
  }

  const parsed = parseSignal(text);
  if (!parsed.valid || !parsed.trade) {
    await sendTelegramMessage(botToken, chatId, `Parse failed:\n${parsed.errors.join("\n")}`);
    return jsonResponse(200, { ok: true });
  }

  await executeParsedTrade({
    repository,
    botToken,
    chatId,
    configUserId,
    executionUserId,
    rawMessage: text,
    parsedTrade: parsed.trade,
    parseWarnings: parsed.warnings,
    lotConfig,
    targetConfig,
    lotOverride: profile?.lotOverride
  });

  return jsonResponse(200, { ok: true });
};
