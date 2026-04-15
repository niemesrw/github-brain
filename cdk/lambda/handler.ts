import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createAppAuth } from "@octokit/auth-app";

const sm = new SecretsManagerClient({});
const ddb = new DynamoDBClient({});
const secretCache = new Map<string, string>();

const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60; // exact-retry window
const TASK_TTL_SECONDS = 10 * 60; // burst-protection window per (repo, kind, ref)

async function markOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const table = process.env.DEDUPE_TABLE;
  if (!table) return true;
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          deliveryId: { S: key },
          ttl: { N: String(Math.floor(Date.now() / 1000) + ttlSeconds) },
        },
        ConditionExpression: "attribute_not_exists(deliveryId)",
      })
    );
    return true;
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

function taskKey(task: Task): string {
  if (task.kind === "dependabot-pr") {
    return `task:${task.repo}:${task.kind}:${task.prNumber}`;
  }
  return `task:${task.repo}:${task.kind}:${task.issueNumber}`;
}

async function getSecret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);
  if (cached) return cached;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error(`secret ${arn} has no SecretString`);
  secretCache.set(arn, res.SecretString);
  return res.SecretString;
}

function verifySignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const ALLOWED_REPO = "niemesrw/openbrain";
const INTERESTING_EVENTS = new Set(["pull_request", "check_suite", "issues"]);

type Task =
  | {
      kind: "dependabot-pr";
      repo: string;
      prNumber: number;
      prTitle: string;
      headBranch: string;
      author: string;
      action: string;
    }
  | {
      kind: "issue-triage";
      repo: string;
      issueNumber: number;
      issueTitle: string;
      issueBody: string;
      author: string;
      action: string;
    };

function classify(eventName: string, payload: any): Task | { skip: string } {
  const repo: string | undefined = payload.repository?.full_name;
  if (repo !== ALLOWED_REPO) return { skip: "repo not in allowlist" };

  if (eventName === "issues") {
    if (payload.action !== "opened" && payload.action !== "reopened") {
      return { skip: `issues action ${payload.action} not handled` };
    }
    const issue = payload.issue;
    if (!issue) return { skip: "no issue in payload" };
    if (issue.pull_request) return { skip: "issue is actually a PR" };
    return {
      kind: "issue-triage",
      repo,
      issueNumber: issue.number,
      issueTitle: issue.title ?? "",
      issueBody: issue.body ?? "",
      author: issue.user?.login ?? "unknown",
      action: payload.action,
    };
  }

  // pull_request or check_suite → Dependabot patch-merge path
  const pr = payload.pull_request ?? payload.check_suite?.pull_requests?.[0];
  const prAuthor: string | undefined = payload.pull_request?.user?.login;
  const headBranch: string | undefined =
    payload.pull_request?.head?.ref ?? payload.check_suite?.head_branch;
  const isDependabot = prAuthor === "dependabot[bot]" || headBranch?.startsWith("dependabot/");
  if (!isDependabot) return { skip: "not dependabot" };
  if (!pr?.number) return { skip: "no PR number on payload" };
  return {
    kind: "dependabot-pr",
    repo,
    prNumber: pr.number,
    prTitle: pr.title ?? payload.pull_request?.title ?? "",
    headBranch: headBranch ?? "",
    author: prAuthor ?? "dependabot[bot]",
    action: payload.action ?? "n/a",
  };
}

function buildPrompt(task: Task, token: string): string {
  const preamble = [
    `A short-lived GitHub installation token is provided below. Export it as GH_TOKEN and use the \`gh\` CLI.`,
    `GH_TOKEN=${token}`,
    ``,
  ];

  if (task.kind === "dependabot-pr") {
    return [
      `TASK: dependabot-pr`,
      `Repository: ${task.repo}`,
      `PR number: ${task.prNumber}`,
      `PR title: ${task.prTitle}`,
      `Head branch: ${task.headBranch}`,
      `Author: ${task.author}`,
      `Event action: ${task.action}`,
      ``,
      ...preamble,
      `Follow the "Task: dependabot-pr" rules in your system prompt.`,
    ].join("\n");
  }

  return [
    `TASK: issue-triage`,
    `Repository: ${task.repo}`,
    `Issue number: ${task.issueNumber}`,
    `Issue title: ${task.issueTitle}`,
    `Author: ${task.author}`,
    `Event action: ${task.action}`,
    ``,
    `Issue body:`,
    `---`,
    task.issueBody.slice(0, 8000),
    `---`,
    ``,
    ...preamble,
    `Follow the "Task: issue-triage" rules in your system prompt.`,
  ].join("\n");
}

function titleFor(task: Task): string {
  if (task.kind === "dependabot-pr") {
    return `dependabot-pr: ${task.repo}#${task.prNumber}`;
  }
  return `issue-triage: ${task.repo}#${task.issueNumber}`;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = event.body ?? "";
  const headers = event.headers;
  const signature = headers["x-hub-signature-256"];
  const eventName = headers["x-github-event"];
  const deliveryId = headers["x-github-delivery"];

  const webhookSecret = await getSecret(process.env.WEBHOOK_SECRET_ARN!);
  if (!verifySignature(body, signature, webhookSecret)) {
    console.log("signature mismatch", { deliveryId });
    return { statusCode: 401, body: "signature mismatch" };
  }

  if (!eventName || !INTERESTING_EVENTS.has(eventName)) {
    console.log("ignored: uninteresting event", { deliveryId, eventName });
    return { statusCode: 200, body: "ignored: uninteresting event" };
  }

  const payload = JSON.parse(body);
  const decision = classify(eventName, payload);
  if ("skip" in decision) {
    console.log("ignored", { deliveryId, eventName, reason: decision.skip });
    return { statusCode: 200, body: `ignored: ${decision.skip}` };
  }
  const task = decision;

  if (deliveryId && !(await markOnce(`delivery:${deliveryId}`, DELIVERY_TTL_SECONDS))) {
    console.log("ignored: duplicate delivery", { deliveryId, eventName });
    return { statusCode: 200, body: "ignored: duplicate delivery" };
  }

  if (!(await markOnce(taskKey(task), TASK_TTL_SECONDS))) {
    console.log("ignored: recent session for this task", {
      deliveryId,
      key: taskKey(task),
    });
    return { statusCode: 200, body: "ignored: recent session for this task" };
  }

  const [privateKey, anthropicKey] = await Promise.all([
    getSecret(process.env.APP_PRIVATE_KEY_ARN!),
    getSecret(process.env.ANTHROPIC_KEY_ARN!),
  ]);
  const auth = createAppAuth({ appId: process.env.GH_APP_ID!, privateKey });
  const { token } = await auth({
    type: "installation",
    installationId: Number(process.env.GH_INSTALLATION_ID_OPENBRAIN!),
  });
  const anthropicHeaders = {
    "x-api-key": anthropicKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
    "content-type": "application/json",
  };

  const sessionRes = await fetch("https://api.anthropic.com/v1/sessions", {
    method: "POST",
    headers: anthropicHeaders,
    body: JSON.stringify({
      agent: process.env.AGENT_ID,
      environment_id: process.env.ENVIRONMENT_ID,
      title: titleFor(task),
    }),
  });
  if (!sessionRes.ok) {
    console.error("session create failed", sessionRes.status, await sessionRes.text());
    return { statusCode: 500, body: "session create failed" };
  }
  const session = (await sessionRes.json()) as { id: string };

  const eventRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${session.id}/events`,
    {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: buildPrompt(task, token) }] },
        ],
      }),
    }
  );
  if (!eventRes.ok) {
    console.error("event send failed", eventRes.status, await eventRes.text());
    return { statusCode: 500, body: "event send failed" };
  }

  console.log("session dispatched", {
    session: session.id,
    task: task.kind,
    repo: task.repo,
    ref: task.kind === "dependabot-pr" ? task.prNumber : task.issueNumber,
    deliveryId,
  });
  return { statusCode: 202, body: JSON.stringify({ session: session.id }) };
}
