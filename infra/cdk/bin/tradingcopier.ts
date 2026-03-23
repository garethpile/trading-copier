#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cdk from "aws-cdk-lib";
import { TradingCopierStack } from "../lib/tradingcopier-stack";
import { applySolutionTags } from "../lib/tags";

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
const environment = process.env.APP_ENV ?? process.env.NODE_ENV ?? "unknown";
const costCenter = process.env.COST_CENTER;

const stack = new TradingCopierStack(app, "TradingCopierStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1"
  }
});

applySolutionTags(stack, {
  solution: "TradingCopier",
  component: "backend",
  environment,
  repo: "tradingcopier",
  serviceGroup: "trading",
  costCenter,
  lifecycle: environment === "prod" ? "active" : "nonprod"
});
