#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { TradingCopierStack } from "../lib/tradingcopier-stack";

const app = new cdk.App();

new TradingCopierStack(app, "TradingCopierStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
