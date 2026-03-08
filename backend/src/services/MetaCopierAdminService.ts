import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface SocketFeatureStatusResult {
  status: "ENABLED" | "DISABLED" | "UNKNOWN";
  accountId: string;
  details?: unknown;
}

export interface SocketFeatureEnableResult {
  success: boolean;
  accountId: string;
  message: string;
  response?: unknown;
}

interface MetaCopierSecret {
  apiKey?: string;
  userEmail?: string;
}

const toObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const isSocketFeature = (feature: Record<string, unknown>): boolean => {
  const type = toObject(feature.type);
  const name = typeof type?.name === "string" ? type.name.toLowerCase() : "";
  const setting = toObject(feature.setting);
  const activateSocket = setting?.activateSocket;

  return name.includes("socket") || activateSocket === true;
};

export class MetaCopierAdminService {
  private readonly secretsClient = new SecretsManagerClient({});
  private readonly baseUrl: string;
  private readonly envApiKey: string;
  private readonly envUserEmail?: string;
  private readonly secretArn: string;
  private secretCache?: MetaCopierSecret;

  constructor() {
    this.baseUrl = process.env.METACOPIER_GLOBAL_BASE_URL ?? "https://api.metacopier.io";
    this.envApiKey = process.env.METACOPIER_API_KEY?.trim() ?? "";
    this.envUserEmail = process.env.METACOPIER_USER_EMAIL?.trim() || undefined;
    this.secretArn = process.env.METACOPIER_SECRET_ARN ?? "";
  }

  private async getSecret(): Promise<MetaCopierSecret> {
    if (this.secretCache) return this.secretCache;
    if (!this.secretArn) return {};

    const out = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
    if (!out.SecretString) return {};

    const parsed = JSON.parse(out.SecretString) as MetaCopierSecret;
    this.secretCache = parsed;
    return parsed;
  }

  private async getCredentials(): Promise<{ apiKey: string; userEmail?: string }> {
    if (this.envApiKey) {
      return { apiKey: this.envApiKey, userEmail: this.envUserEmail };
    }

    const secret = await this.getSecret();
    const apiKey = secret.apiKey?.trim() ?? "";
    const userEmail = this.envUserEmail ?? secret.userEmail?.trim();

    if (!apiKey) {
      throw new Error("METACOPIER API key is missing (env or Secrets Manager)");
    }

    return { apiKey, userEmail };
  }

  private async headers(): Promise<Record<string, string>> {
    const credentials = await this.getCredentials();
    const headers: Record<string, string> = {
      "X-API-KEY": credentials.apiKey,
      "Content-Type": "application/json"
    };

    if (credentials.userEmail) {
      headers["X-User-Email"] = credentials.userEmail;
    }

    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getSocketFeatureStatus(accountId: string): Promise<SocketFeatureStatusResult> {
    const headers = await this.headers();

    try {
      const endpoint = `${this.baseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${accountId}/features`;
      const response = await this.fetchWithTimeout(endpoint, {
        method: "GET",
        headers
      });
      const body = await this.readBody(response);
      if (!response.ok) {
        return {
          status: "UNKNOWN",
          accountId,
          details: {
            statusCode: response.status,
            response: body ?? null,
            message: response.statusText
          }
        };
      }

      const features = Array.isArray(body) ? body : [];
      const socket = features.find((item) => isSocketFeature(toObject(item) ?? {}));

      if (!socket) {
        return {
          status: "DISABLED",
          accountId,
          details: { featuresCount: features.length }
        };
      }

      return {
        status: "ENABLED",
        accountId,
        details: socket
      };
    } catch (error) {
      return {
        status: "UNKNOWN",
        accountId,
        details: {
          message: String(error)
        }
      };
    }
  }

  async enableSocketFeature(accountId: string): Promise<SocketFeatureEnableResult> {
    const headers = await this.headers();

    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/rest/api/v1/accounts/${accountId}/features`;
    const configuredTypeId = Number(process.env.METACOPIER_SOCKET_FEATURE_TYPE_ID ?? "26");
    const candidateTypeIds = Array.from(new Set([configuredTypeId, 25, 26].filter((v) => Number.isFinite(v) && v > 0)));

    try {
      let lastFailure: { status: number; body: unknown; statusText: string; typeId: number } | undefined;

      for (const typeId of candidateTypeIds) {
        const response = await this.fetchWithTimeout(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: { id: typeId },
            setting: { activateSocket: true }
          })
        });
        const body = await this.readBody(response);

        if (response.ok) {
          return {
            success: true,
            accountId,
            message: "Socket feature enabled",
            response: body
          };
        }

        if (response.status === 400 || response.status === 409) {
          const featureStatus = await this.getSocketFeatureStatus(accountId);
          if (featureStatus.status === "ENABLED") {
            return {
              success: true,
              accountId,
              message: "Socket feature already enabled",
              response: {
                upstreamStatus: response.status,
                upstreamResponse: body ?? response.statusText,
                featureStatus
              }
            };
          }
        }

        lastFailure = {
          status: response.status,
          body,
          statusText: response.statusText,
          typeId
        };
      }

      return {
        success: false,
        accountId,
        message: `Enable socket failed: ${lastFailure?.status ?? 500}`,
        response: lastFailure
      };
    } catch (error) {
      return {
        success: false,
        accountId,
        message: "Enable socket failed",
        response: String(error)
      };
    }
  }
}
