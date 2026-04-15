import * as path from "node:path";
import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface WebhookStackProps extends StackProps {
  appId: string;
  openbrainInstallationId: string;
  agentId: string;
  environmentId: string;
}

export class WebhookStack extends Stack {
  constructor(scope: Construct, id: string, props: WebhookStackProps) {
    super(scope, id, props);

    const webhookSecret = new Secret(this, "GithubWebhookSecret", {
      secretName: "github-brain/webhook-secret",
      description: "GitHub App webhook signing secret (blanxlait-agent-manager)",
    });

    const appPrivateKey = new Secret(this, "GithubAppPrivateKey", {
      secretName: "github-brain/app-private-key",
      description: "GitHub App private key PEM (blanxlait-agent-manager)",
    });

    const anthropicKey = new Secret(this, "AnthropicApiKey", {
      secretName: "github-brain/anthropic-api-key",
      description: "Anthropic API key for Managed Agents",
    });

    const handler = new NodejsFunction(this, "WebhookHandler", {
      entry: path.join(__dirname, "..", "lambda", "handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        GH_APP_ID: props.appId,
        GH_INSTALLATION_ID_OPENBRAIN: props.openbrainInstallationId,
        AGENT_ID: props.agentId,
        ENVIRONMENT_ID: props.environmentId,
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        APP_PRIVATE_KEY_ARN: appPrivateKey.secretArn,
        ANTHROPIC_KEY_ARN: anthropicKey.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        format: OutputFormat.CJS,
        target: "node20",
      },
    });

    webhookSecret.grantRead(handler);
    appPrivateKey.grantRead(handler);
    anthropicKey.grantRead(handler);

    const api = new HttpApi(this, "WebhookApi", {
      apiName: "github-brain-webhook",
    });

    api.addRoutes({
      path: "/webhook",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("WebhookIntegration", handler),
    });

    new CfnOutput(this, "WebhookUrl", { value: `${api.url}webhook` });
  }
}
