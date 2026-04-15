import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createAppAuth } from "@octokit/auth-app";

const sm = new SecretsManagerClient({});
const secretCache = new Map<string, string>();

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
const INTERESTING_EVENTS = new Set(["pull_request", "check_suite"]);

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
    return { statusCode: 200, body: "ignored: uninteresting event" };
  }

  const payload = JSON.parse(body);
  const repo: string | undefined = payload.repository?.full_name;
  if (repo !== ALLOWED_REPO) {
    return { statusCode: 200, body: "ignored: repo not in allowlist" };
  }

  const pr = payload.pull_request ?? payload.check_suite?.pull_requests?.[0];
  const prAuthor: string | undefined = payload.pull_request?.user?.login;
  const headBranch: string | undefined =
    payload.pull_request?.head?.ref ?? payload.check_suite?.head_branch;
  const isDependabot = prAuthor === "dependabot[bot]" || headBranch?.startsWith("dependabot/");
  if (!isDependabot) {
    return { statusCode: 200, body: "ignored: not dependabot" };
  }

  const privateKey = await getSecret(process.env.APP_PRIVATE_KEY_ARN!);
  const auth = createAppAuth({
    appId: process.env.GH_APP_ID!,
    privateKey,
  });
  const { token } = await auth({
    type: "installation",
    installationId: Number(process.env.GH_INSTALLATION_ID_OPENBRAIN!),
  });

  const anthropicKey = await getSecret(process.env.ANTHROPIC_KEY_ARN!);
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
      title: `${eventName} ${payload.action ?? ""}: ${repo}#${pr?.number ?? "?"}`,
    }),
  });
  if (!sessionRes.ok) {
    console.error("session create failed", sessionRes.status, await sessionRes.text());
    return { statusCode: 500, body: "session create failed" };
  }
  const session = (await sessionRes.json()) as { id: string };

  const prompt = [
    `GitHub event: ${eventName} (action: ${payload.action ?? "n/a"})`,
    `Repository: ${repo}`,
    `PR number: ${pr?.number ?? "unknown"}`,
    `PR title: ${pr?.title ?? "unknown"}`,
    `Head branch: ${headBranch ?? "unknown"}`,
    `Author: ${prAuthor ?? "unknown"}`,
    ``,
    `A short-lived GitHub installation token is provided below. Export it as GH_TOKEN and use the \`gh\` CLI to inspect and act on the PR.`,
    `GH_TOKEN=${token}`,
    ``,
    `Your job: decide whether this is a Dependabot patch bump (e.g. 1.2.3 → 1.2.4) on green CI.`,
    `- If yes: merge it with \`gh pr merge\` using the squash strategy and capture the decision to Open Brain.`,
    `- If minor, major, or CI is not green: leave a single comment on the PR flagging it for human review, and do NOT merge.`,
    `When done, stop — no further action needed.`,
  ].join("\n");

  const eventRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${session.id}/events`,
    {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      }),
    }
  );
  if (!eventRes.ok) {
    console.error("event send failed", eventRes.status, await eventRes.text());
    return { statusCode: 500, body: "event send failed" };
  }

  console.log("session dispatched", {
    session: session.id,
    repo,
    pr: pr?.number,
    deliveryId,
  });
  return { statusCode: 202, body: JSON.stringify({ session: session.id }) };
}
