import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { parseSignal } from "../parsers/signalParser";
import { jsonResponse } from "../utils/http";
import { ParseSignalRequest } from "../models/types";

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
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(500, {
      valid: false,
      warnings: [],
      errors: ["Unexpected error", String(error)]
    });
  }
};
