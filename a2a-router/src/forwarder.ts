/**
 * Forward an A2A JSON-RPC turn to the user's Cloud Workstation, then
 * stream events back through the local ExecutionEventBus.
 *
 * The workstation runs the SAME router code on port 8080 with no
 * UserBuilder hook, so it accepts plain `message/stream` JSON-RPC and
 * speaks A2A SSE responses. This module is essentially a "decode SSE
 * lines, forward each event to bus, terminate when result-final".
 */

import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";

interface ForwardOptions {
  /** Workstation public URL, e.g. https://8080-ws-foo.cluster-bar.cloudworkstations.dev */
  baseUrl: string;
  /** Bearer token returned by Workstations' generateAccessToken. */
  bearerToken: string;
  /** A2A taskId to use upstream and to publish events under. */
  taskId: string;
  /** A2A contextId. */
  contextId: string;
  /** The user-visible message that triggered this turn. */
  userMessage: Message;
  /** Local event bus to publish translated events to. */
  bus: ExecutionEventBus;
  /** Hard ceiling on the upstream call. */
  timeoutMs?: number;
}

type AnyA2AEvent =
  | (Task & { kind: "task" })
  | (TaskStatusUpdateEvent & { kind: "status-update" })
  | (TaskArtifactUpdateEvent & { kind: "artifact-update" });

function isA2AEvent(v: unknown): v is AnyA2AEvent {
  if (!v || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return k === "task" || k === "status-update" || k === "artifact-update";
}

/**
 * POST `message/stream` to the workstation and pump SSE events back into
 * `bus`. Resolves once the upstream emits a `final` status event or the
 * stream ends.
 */
export async function forwardToWorkstation(
  opts: ForwardOptions,
): Promise<void> {
  const {
    baseUrl,
    bearerToken,
    taskId,
    contextId,
    userMessage,
    bus,
    timeoutMs = 600_000,
  } = opts;

  // Drop the upstream taskId (the workstation will refuse it with
  // "Task not found" because its DefaultRequestHandler maintains its own
  // task store), BUT preserve the contextId so the workstation correlates
  // multi-turn conversations and Claude SDK resume:<sessionId> caches hit.
  // Without this, every turn looks like a brand-new conversation to the
  // workstation and Claude has no memory between turns.
  const upstreamMessage = { ...userMessage, contextId } as Message & {
    taskId?: string;
    contextId?: string;
  };
  delete upstreamMessage.taskId;

  const body = {
    jsonrpc: "2.0" as const,
    id: randomUUID(),
    method: "message/stream",
    params: {
      message: upstreamMessage,
      configuration: {
        // Tell the workstation handler to associate the request with
        // this conversation context, so subsequent turns reuse the same
        // Claude SDK sessionId.
        acceptedOutputModes: ["text/plain"],
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref();

  let upstream: Response;
  try {
    upstream = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `forward: workstation unreachable: ${(err as Error).message}`,
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    clearTimeout(timer);
    throw new Error(
      `forward: workstation returned ${upstream.status} ${upstream.statusText}: ${detail.slice(0, 500)}`,
    );
  }

  if (!upstream.body) {
    clearTimeout(timer);
    throw new Error("forward: workstation response has no body");
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames separated by blank lines.
      let blankIdx = buffer.indexOf("\n\n");
      while (blankIdx !== -1) {
        const frame = buffer.slice(0, blankIdx);
        buffer = buffer.slice(blankIdx + 2);

        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          try {
            const parsed = JSON.parse(json) as {
              result?: unknown;
              error?: unknown;
            };
            if (parsed.error) {
              throw new Error(
                `forward: workstation error: ${JSON.stringify(parsed.error)}`,
              );
            }
            if (isA2AEvent(parsed.result)) {
              const event = parsed.result;
              // Rewrite the upstream-assigned task/context ids back to ours
              // so our local ResultManager keeps tracking a single task.
              // (Skip the very first 'task' event — the local handler has
              //  already published its own, and pushing a second one with a
              //  different upstream id would confuse downstream clients.)
              if (event.kind === "task") {
                continue;
              }
              if (
                event.kind === "status-update" ||
                event.kind === "artifact-update"
              ) {
                event.taskId = taskId;
                event.contextId = contextId;
              }
              bus.publish(event);
              if (
                event.kind === "status-update" &&
                event.final === true
              ) {
                // Upstream signalled end-of-stream.
                clearTimeout(timer);
                return;
              }
            }
          } catch (err) {
            console.warn(
              `forward: failed to parse SSE frame: ${(err as Error).message} (json="${json.slice(0, 200)}")`,
            );
          }
        }
        blankIdx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
