#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { WebhookStack } from "../lib/webhook-stack";

const requiredEnv = [
  "GH_APP_ID",
  "GH_INSTALLATION_ID_OPENBRAIN",
  "AGENT_ID",
  "ENVIRONMENT_ID",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var at synth time: ${key}`);
  }
}

const app = new App();

new WebhookStack(app, "GithubBrainWebhook", {
  env: { account: "057122451218", region: "us-east-1" },
  appId: process.env.GH_APP_ID!,
  openbrainInstallationId: process.env.GH_INSTALLATION_ID_OPENBRAIN!,
  agentId: process.env.AGENT_ID!,
  environmentId: process.env.ENVIRONMENT_ID!,
});
