#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cdk from "aws-cdk-lib";
import { TradingCopierStack } from "../lib/tradingcopier-stack";

const loadEnvFile = (filepath: string): void => {
  if (!existsSync(filepath)) return;
  const raw = readFileSync(filepath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
};

// Load repo-level deploy config first, then fallback to backend local env.
loadEnvFile(resolve(__dirname, "..", ".env"));
loadEnvFile(resolve(__dirname, "..", "..", "..", "backend", ".env"));

const app = new cdk.App();

new TradingCopierStack(app, "TradingCopierStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
