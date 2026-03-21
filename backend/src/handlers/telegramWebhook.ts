import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ExecuteTradeResolvedRequest, ExecutionMode, LotSizeConfig, ParsedTrade, TargetAccountsConfig } from "../models/types";
import { parseSignal } from "../parsers/signalParser";
import { TradeRepository } from "../repositories/TradeRepository";
import { ExecutionService, DuplicateTradeError } from "../services/ExecutionService";
import { validateResolvedExecutionRequest } from "../validators/tradeValidator";
import { jsonResponse } from "../utils/http";
import { TradeRuntimeSyncService } from "../services/TradeRuntimeSyncService";
import { getNewsFeedStatus, pauseNewsFeed, pollNewsFeedNow, resumeNewsFeed } from "../services/newsFeedBridge";

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

const getTimings = (providerResponse: unknown): Record<string, number> => {
  if (!providerResponse || typeof providerResponse !== "object") return {};
  const timings = (providerResponse as { timings?: unknown }).timings;
  if (!timings || typeof timings !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(timings as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.round(value);
    }
  }
  return out;
};

const formatExecutionLegs = (providerResponse: unknown): string[] => {
  if (!providerResponse || typeof providerResponse !== "object") return [];
  const legs = (providerResponse as { legs?: unknown }).legs;
  if (!Array.isArray(legs)) return [];
  return legs.map((raw) => {
    const leg = raw as { leg?: number; status?: string; message?: string; executionId?: string; providerResponse?: unknown };
    const providerTimings = getTimings(leg.providerResponse);
    const timingSuffix = providerTimings.totalMs !== undefined ? ` [mc=${providerTimings.totalMs}ms]` : "";
    return `TP${leg.leg ?? "?"}: ${leg.status ?? "UNKNOWN"}${leg.executionId ? ` (${leg.executionId})` : ""} - ${leg.message ?? "-"}${timingSuffix}`;
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
  executionUserId: string;
  rawMessage: string;
  parsedTrade: ParsedTrade;
  parseWarnings: string[];
  lotConfig: LotSizeConfig;
  targetConfig: TargetAccountsConfig;
  lotOverride?: number;
  updateId?: number;
}) => {
  const startedAt = Date.now();
  const mode = input.targetConfig.executionMode ?? "DEMO";
  const targetAccount = modeAccount(input.targetConfig, mode);
  const modeResolvedMs = Date.now() - startedAt;

  if (!targetAccount) {
    await sendTelegramMessage(input.botToken, input.chatId, "Execution failed: no target account configured for current mode.");
    return;
  }

  const symbol = input.parsedTrade.symbol.toUpperCase();
  const symbolConfig = input.lotConfig.symbols[symbol];
  const destinationBrokerSymbol =
    symbolConfig?.accountDestinationSymbols?.[targetAccount] || symbolConfig?.destinationBrokerSymbol || symbol;
  const lotSize = input.lotOverride ?? symbolConfig?.lotSize ?? input.lotConfig.defaultLotSize;

  const requestBuildStartedAt = Date.now();
  const request: ExecuteTradeResolvedRequest = {
    rawMessage: input.rawMessage,
    trade: input.parsedTrade,
    targetAccount,
    lotSize,
    destinationBrokerSymbol,
    mode,
    sourceMessageId: input.updateId !== undefined ? String(input.updateId) : undefined,
    receivedAt: new Date().toISOString()
  };
  const requestBuildMs = Date.now() - requestBuildStartedAt;

  const validationStartedAt = Date.now();
  const validationErrors = validateResolvedExecutionRequest(request, input.targetConfig.accounts, lotRange(), {
    requireProtectiveLevels: true
  });
  const validationMs = Date.now() - validationStartedAt;

  if (validationErrors.length > 0) {
    await sendTelegramMessage(input.botToken, input.chatId, `Validation failed:\n${validationErrors.join("\n")}`);
    return;
  }

  const ackStartedAt = Date.now();
  await sendTelegramMessage(
    input.botToken,
    input.chatId,
    [
      "Submitting trade...",
      `Mode: ${mode}`,
      `Symbol: ${symbol} -> ${destinationBrokerSymbol}`,
      `Account: ${targetAccount}`,
      `Lot: ${lotSize}`
    ].join("\n")
  );
  const ackMs = Date.now() - ackStartedAt;

  const executionService = new ExecutionService(input.repository);
  const executeStartedAt = Date.now();

  try {
    const result = await executionService.executeResolved(input.executionUserId, request, input.parseWarnings);
    const executeMs = Date.now() - executeStartedAt;
    const providerResponse = (result as { providerResponse?: unknown }).providerResponse;
    const timingBreakdown = getTimings(providerResponse);
    const legLines = formatExecutionLegs(providerResponse);

    const totalMs = Date.now() - startedAt;
    const replyStartedAt = Date.now();
    await sendTelegramMessage(
      input.botToken,
      input.chatId,
      [
        `Execution: ${result.status}`,
        `Signal ID: ${result.signalId ?? "-"}`,
        `Message: ${result.message}`,
        `Mode: ${mode}`,
        `Symbol: ${symbol} -> ${destinationBrokerSymbol}`,
        `Account: ${targetAccount}`,
        `Lot: ${lotSize}`,
        `Elapsed: ${totalMs}ms`,
        `Stage timings: mode=${modeResolvedMs}ms build=${requestBuildMs}ms validate=${validationMs}ms ack=${ackMs}ms exec=${executeMs}ms`,
        `Exec internals: dedupe=${timingBreakdown.dedupeMs ?? 0}ms persist=${timingBreakdown.createTradeMs ?? 0}ms legs=${timingBreakdown.executeLegsMs ?? 0}ms finalize=${timingBreakdown.updateTradeMs ?? 0}ms`,
        ...(timingBreakdown.totalMs !== undefined ? [`Exec total: ${timingBreakdown.totalMs}ms`] : []),
        ...(legLines.length > 0 ? ["Legs:", ...legLines] : [])
      ].join("\n")
    );
    const replyMs = Date.now() - replyStartedAt;

    console.log("telegramWebhook execution timing", {
      chatId: input.chatId,
      updateId: input.updateId,
      symbol,
      mode,
      targetAccount,
      lotSize,
      totalMs: Date.now() - startedAt,
      modeResolvedMs,
      requestBuildMs,
      validationMs,
      ackMs,
      executeMs,
      replyMs,
      timingBreakdown
    });
  } catch (error) {
    if (error instanceof DuplicateTradeError) {
      await sendTelegramMessage(
        input.botToken,
        input.chatId,
        [
          "Duplicate or in-flight trade blocked.",
          `Mode: ${mode}`,
          `Symbol: ${symbol} -> ${destinationBrokerSymbol}`,
          `Account: ${targetAccount}`,
          `Lot: ${lotSize}`,
          ...(error.existingSignalId ? [`Existing Signal ID: ${error.existingSignalId}`] : []),
          "If this was intentional, change the signal inputs or wait for the existing request to clear."
        ].join("\n")
      );
      return;
    }
    throw error;
  }
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const startedAt = Date.now();
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
      return jsonResponse(200, { ok: true, duplicate: true });
    }
  }

  const configUserId = resolveConfigUserId(chatId);
  const executionUserId = configUserId;

  const configLoadStartedAt = Date.now();
  const lotConfig = await repository.getLotSizeConfig(configUserId);
  const targetConfig = await repository.getTargetAccountsConfig(configUserId);
  const profile = await repository.getTelegramProfile(chatId);
  const configLoadMs = Date.now() - configLoadStartedAt;

  console.log("telegramWebhook request timing", {
    chatId,
    updateId,
    configUserId,
    configLoadMs,
    elapsedSoFarMs: Date.now() - startedAt
  });

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

  if (text === "/sync") {
    const runtimeSync = new TradeRuntimeSyncService(repository);
    const trades = await repository.getHistory(executionUserId, 20);
    const updated = await runtimeSync.sync(executionUserId, trades);
    const openCount = updated.filter((trade: { providerResponse?: unknown }) => {
      const providerResponse = trade.providerResponse && typeof trade.providerResponse === "object"
        ? (trade.providerResponse as { legs?: unknown })
        : undefined;
      const legs = Array.isArray(providerResponse?.legs) ? providerResponse.legs : [];
      return legs.some((leg) => leg && typeof leg === "object" && (leg as { runtimeState?: string }).runtimeState === "OPEN");
    }).length;
    await sendTelegramMessage(
      botToken,
      chatId,
      [
        "Runtime sync complete.",
        `Trades scanned: ${trades.length}`,
        `Trades still showing open legs: ${openCount}`
      ].join("\n")
    );
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
    executionUserId,
    rawMessage: text,
    parsedTrade: parsed.trade,
    parseWarnings: parsed.warnings,
    lotConfig,
    targetConfig,
    lotOverride: profile?.lotOverride,
    updateId
  });

  return jsonResponse(200, { ok: true });
};
