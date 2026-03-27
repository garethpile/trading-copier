import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { parseSignal } from "../parsers/signalParser";
import { jsonResponse } from "../utils/http";
import { ParseSignalRequest } from "../models/types";

const summarizeRawMessage = (rawMessage: string) => {
  const lines = rawMessage.split(/\r?\n/);
  const nonAscii = Array.from(new Set(
    Array.from(rawMessage)
      .filter((char) => char.charCodeAt(0) > 127)
      .map((char) => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
  ));

  return {
    length: rawMessage.length,
    lineCount: lines.length,
    preview: JSON.stringify(rawMessage.slice(0, 500)),
    lines: lines.slice(0, 12).map((line, index) => ({
      index: index + 1,
      text: JSON.stringify(line),
      length: line.length
    })),
    nonAscii
  };
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "{}") as Partial<ParseSignalRequest>;
    if (!body.rawMessage || typeof body.rawMessage !== "string") {
      return jsonResponse(400, {
        valid: false,
        warnings: [],
        errors: ["rawMessage is required"]
      });
    }

    const result = parseSignal(body.rawMessage);
    if (!result.valid) {
      console.error("parseSignal failed", {
        errors: result.errors,
        warnings: result.warnings,
        rawSummary: summarizeRawMessage(body.rawMessage)
      });
    }
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(500, {
      valid: false,
      warnings: [],
      errors: ["Unexpected error", String(error)]
    });
  }
};
