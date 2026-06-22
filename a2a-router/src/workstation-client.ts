/**
 * Provision and forward A2A traffic to a per-user Cloud Workstation.
 *
 * Workstations have an internet-reachable hostname pattern:
 *   https://<port>-<workstation>.<cluster>.cloudworkstations.dev
 * but require a short-lived access token in the Authorization header. We
 * obtain that token from the Workstations control-plane API.
 *
 * One workstation per A2A end user. The workstation runs the
 * A2A server (port 8080) which itself implements an A2A server
 * — so this module is essentially "ssh-tunnel-and-POST" plumbing.
 */

import { WorkstationsClient, protos } from "@google-cloud/workstations";

type IWorkstation = protos.google.cloud.workstations.v1.IWorkstation;

// PROJECT_ID is read lazily (not at module load) because this module is
// also imported by the workstation-side router (running in `local` mode),
// where the workstation env only sets ANTHROPIC_VERTEX_PROJECT_ID /
// GOOGLE_CLOUD_PROJECT, not PROJECT_ID. We only actually need PROJECT_ID
// when forwarding to a workstation, which never happens in local mode.
function getProjectId(): string {
  const v =
    process.env["PROJECT_ID"] ?? process.env["GOOGLE_CLOUD_PROJECT"];
  if (!v) {
    throw new Error(
      "PROJECT_ID (or GOOGLE_CLOUD_PROJECT) env var is required for workstation forwarding",
    );
  }
  return v;
}
const REGION = process.env["WORKSTATION_REGION"] ?? "asia-northeast3";
const CLUSTER_ID = process.env["CLUSTER_ID"] ?? "ai-agents-cluster";
const CONFIG_ID = process.env["CONFIG_ID"] ?? "a2a-agent-config";
const WRAPPER_PORT = parseInt(
  process.env["WORKSTATION_WRAPPER_PORT"] ?? "8080",
  10,
);

const client = new WorkstationsClient();

/** Cache running workstation host + access token between turns. */
interface WsCacheEntry {
  host: string;
  bearerToken: string;
  bearerExpiresAt: number;
}
const cache = new Map<string, WsCacheEntry>();
// Re-mint access token a bit before it actually expires so concurrent
// requests don't race the boundary.
const TOKEN_REFRESH_SLACK_MS = 60_000;

function configParent(): string {
  return (
    `projects/${getProjectId()}/locations/${REGION}/` +
    `workstationClusters/${CLUSTER_ID}/workstationConfigs/${CONFIG_ID}`
  );
}

function workstationName(workstationId: string): string {
  return `${configParent()}/workstations/${workstationId}`;
}

function isRunning(ws: IWorkstation | undefined | null): boolean {
  if (!ws) return false;
  // gRPC client returns enum number, REST returns string.
  return ws.state === "STATE_RUNNING" || (ws.state as unknown as number) === 3;
}

async function findWorkstation(
  workstationId: string,
): Promise<IWorkstation | undefined> {
  const [list] = await client.listWorkstations({ parent: configParent() });
  return list.find((ws) =>
    ws.name?.endsWith(`/workstations/${workstationId}`),
  );
}

/**
 * Idempotently ensure the named workstation exists and is running; return
 * its public hostname (without scheme).
 */
async function ensureRunning(
  workstationId: string,
  displayName: string,
): Promise<string> {
  let ws: IWorkstation | undefined = await findWorkstation(workstationId);

  if (!ws) {
    console.log(
      `workstation: creating ${workstationId} (display="${displayName}")`,
    );
    const [op] = await client.createWorkstation({
      parent: configParent(),
      workstationId,
      workstation: {
        name: workstationName(workstationId),
        displayName,
        annotations: { "a2a-managed": "true" },
      },
    });
    const [created] = await op.promise();
    ws = created;
  }

  if (!ws) {
    throw new Error(`workstation: failed to create or locate ${workstationId}`);
  }

  if (!isRunning(ws)) {
    console.log(`workstation: starting ${workstationId}`);
    const [op] = await client.startWorkstation({
      name: ws.name ?? workstationName(workstationId),
    });
    const [started] = await op.promise();
    ws = started ?? ws;
  }

  if (!ws.host) {
    throw new Error(
      `workstation: ${workstationId} is running but has no host assigned`,
    );
  }
  return ws.host;
}

async function mintAccessToken(workstationId: string): Promise<{
  token: string;
  expiresAt: number;
}> {
  const [resp] = await client.generateAccessToken({
    workstation: workstationName(workstationId),
  });
  if (!resp.accessToken) {
    throw new Error(
      `workstation: generateAccessToken returned empty token for ${workstationId}`,
    );
  }
  // expireTime is { seconds, nanos } | undefined
  const sec =
    (resp.expireTime?.seconds && Number(resp.expireTime.seconds)) || 0;
  const expiresAt =
    sec > 0 ? sec * 1000 - TOKEN_REFRESH_SLACK_MS : Date.now() + 4 * 60_000;
  return { token: resp.accessToken, expiresAt };
}

interface ResolvedTarget {
  /** Full URL to POST to, e.g. https://8080-foo.cluster-bar.cloudworkstations.dev */
  url: string;
  /** Bearer token to put in Authorization header. */
  bearerToken: string;
}

/**
 * Cloud Workstations reports STATE_RUNNING as soon as the container has
 * started, but our inner Node.js A2A server needs another ~10-20 seconds
 * to bind port 8080. Poll /health (which our index.ts serves) until it
 * answers 200, with a hard ceiling so a totally broken container doesn't
 * pin a request.
 */
async function waitForA2AServer(
  baseUrl: string,
  bearerToken: string,
): Promise<void> {
  const startedAt = Date.now();
  // 240 s budget for the inner server to boot. The first request after a
  // workstation config / image change forces Cloud Workstations to pull the
  // new container image on the host, which alone takes 60-90s before our
  // /etc/workstation-startup.d/ script even gets to run. After that the
  // script does package init + node startup which is another ~20-30s.
  // 90s is enough for steady-state cold boots but not for image-pull boots.
  const deadline = startedAt + 240_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      if (res.ok) {
        console.log(
          `workstation: A2A server ready in ${Date.now() - startedAt}ms (attempt ${attempt})`,
        );
        return;
      }
    } catch {
      // Network/connection error — server not up yet, keep polling.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `workstation: inner A2A server did not become ready within ${Date.now() - startedAt}ms`,
  );
}

/**
 * Get a ready-to-use HTTPS target for the given workstation_id, creating
 * and starting the workstation if necessary.
 */
export async function getWorkstationTarget(
  workstationId: string,
  displayName: string,
): Promise<ResolvedTarget> {
  const cached = cache.get(workstationId);

  // Always re-check the workstation's actual state. The previous fast-path
  // returned the cached host+token whenever the bearer was still in its 1h
  // validity window, but that misses the case where the workstation has
  // idle-stopped (default 15min) since we last forwarded. Posting to a
  // stopped workstation hangs silently until GE's outer SSE timeout fires,
  // and the user sees "GE で話しかけても起動しない" because we never call
  // startWorkstation on the second attempt. ensureRunning() is itself
  // idempotent and short-circuits to a single describeWorkstation call when
  // the workstation is already running, so the cost in the hot path is
  // only ~50-100ms.
  const host = await ensureRunning(workstationId, displayName);

  if (
    cached &&
    cached.host === host &&
    cached.bearerExpiresAt > Date.now()
  ) {
    return {
      url: `https://${WRAPPER_PORT}-${host}`,
      bearerToken: cached.bearerToken,
    };
  }

  const tok = await mintAccessToken(workstationId);
  const target: ResolvedTarget = {
    url: `https://${WRAPPER_PORT}-${host}`,
    bearerToken: tok.token,
  };

  // Block until the inner server is actually answering. Without this,
  // the very first request after a cold start hits the workstation
  // ingress before our Node process binds port 8080 and we get a 503
  // "Unable to forward to backend". Skip when the cache hit confirms the
  // host is unchanged and we're only refreshing the bearer token.
  if (!(cached && cached.host === host)) {
    await waitForA2AServer(target.url, target.bearerToken);
  }

  cache.set(workstationId, {
    host,
    bearerToken: tok.token,
    bearerExpiresAt: tok.expiresAt,
  });

  return target;
}

/**
 * Drop a cache entry on workstation-side errors so the next request rebuilds
 * the host + token.
 */
export function invalidateWorkstationCache(workstationId: string): void {
  cache.delete(workstationId);
}
