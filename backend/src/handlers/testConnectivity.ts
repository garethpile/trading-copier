import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { buildExecutionProvider } from "../providers/ExecutionProviderFactory";
import { getUserIdFromEvent } from "../utils/auth";
import { jsonResponse } from "../utils/http";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    // Enforce auth, even though user id is not directly used.
    getUserIdFromEvent(event);

    const provider = buildExecutionProvider();
    const result = await provider.testConnectivity();

    return jsonResponse(result.status === "OK" ? 200 : 502, result);
  } catch (error) {
    return jsonResponse(500, {
      status: "FAILED",
      provider: "MetaCopier",
      message: "Connectivity test failed",
      error: String(error)
    });
  }
};
