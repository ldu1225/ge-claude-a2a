import { WorkstationsClient, protos } from "@google-cloud/workstations";

type IWorkstation = protos.google.cloud.workstations.v1.IWorkstation;

// Read PROJECT_ID lazily — see workstation-client.ts for rationale.
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
const WRAPPER_PORT = 8080;

const client = new WorkstationsClient();

interface ResolvedWorkstation {
  host: string;
  port: number;
}

const resolvedCache = new Map<
  string,
  { resolved: ResolvedWorkstation; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function workstationId(userId: string): string {
  return `a2a-ws-${userId
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 50)}`;
}

/**
 * Workstation `state` is published as an enum (number) by the gRPC client and
 * as a string by the REST client. Normalise both to a comparable string.
 */
function isRunning(ws: IWorkstation): boolean {
  const state = ws.state;
  return state === "STATE_RUNNING" || state === 3; // 3 = STATE_RUNNING enum value
}

export async function resolveWorkstation(
  userId: string,
): Promise<ResolvedWorkstation> {
  const cached = resolvedCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.resolved;
  }

  const wsId = workstationId(userId);
  const parent = `projects/${getProjectId()}/locations/${REGION}/workstationClusters/${CLUSTER_ID}/workstationConfigs/${CONFIG_ID}`;
  const fullName = `${parent}/workstations/${wsId}`;

  let workstation: IWorkstation | undefined = await findWorkstation(
    parent,
    wsId,
  );

  if (!workstation) {
    console.log(`Creating workstation ${wsId} for user ${userId}`);
    const [operation] = await client.createWorkstation({
      parent,
      workstationId: wsId,
      workstation: {
        name: fullName,
        displayName: `A2A Agent - ${userId}`,
        annotations: { "a2a-user": userId },
      },
    });
    const [created] = await operation.promise();
    workstation = created;
  }

  if (!workstation) {
    throw new Error(`Failed to create or locate workstation ${wsId}`);
  }

  if (!isRunning(workstation)) {
    console.log(`Starting workstation ${wsId}`);
    const [startOp] = await client.startWorkstation({
      name: workstation.name ?? fullName,
    });
    const [started] = await startOp.promise();
    workstation = started ?? workstation;
  }

  const host = workstation.host;
  if (!host) {
    throw new Error(`Workstation ${wsId} has no host assigned`);
  }

  const resolved: ResolvedWorkstation = { host, port: WRAPPER_PORT };
  resolvedCache.set(userId, {
    resolved,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return resolved;
}

async function findWorkstation(
  parent: string,
  wsId: string,
): Promise<IWorkstation | undefined> {
  const [workstations] = await client.listWorkstations({ parent });
  return workstations.find((ws) =>
    ws.name?.endsWith(`/workstations/${wsId}`),
  );
}
