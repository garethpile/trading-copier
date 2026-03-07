import { APIGatewayProxyEventV2 } from "aws-lambda";

export const getUserIdFromEvent = (event: APIGatewayProxyEventV2): string => {
  const claims = (event.requestContext as APIGatewayProxyEventV2["requestContext"] & {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  }).authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (!sub || typeof sub !== "string") {
    throw new Error("Unauthenticated request");
  }
  return sub;
};
