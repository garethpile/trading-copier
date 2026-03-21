import * as cdk from "aws-cdk-lib";
import { IConstruct } from "constructs";

export type SolutionTagOptions = {
  solution: string;
  component: string;
  environment?: string;
  owner?: string;
  managedBy?: string;
  repo?: string;
  serviceGroup?: string;
  costCenter?: string;
  paymentEngine?: string;
  lifecycle?: string;
};

export const applySolutionTags = (scope: IConstruct, options: SolutionTagOptions): void => {
  const tags: Record<string, string | undefined> = {
    Solution: options.solution,
    Component: options.component,
    Environment: options.environment,
    Owner: options.owner ?? "Gareth",
    ManagedBy: options.managedBy ?? "CDK",
    Repo: options.repo,
    ServiceGroup: options.serviceGroup,
    CostCenter: options.costCenter,
    PaymentEngine: options.paymentEngine,
    Lifecycle: options.lifecycle
  };

  for (const [key, value] of Object.entries(tags)) {
    if (value && value.trim()) {
      cdk.Tags.of(scope).add(key, value);
    }
  }
};
