/**
 * Claude Agent SDK + Gemini CLI executor for the A2A router.
 *
 * Two big improvements over the previous spawn-claude-per-request version:
 *
 * 1. Conversation continuity. We map each A2A `contextId` to a Claude SDK
 *    `sessionId`. The first turn starts a new session; subsequent turns in the
 *    same context resume that session (`resume: <sessionId>`), so Claude
 *    actually remembers what was said.
 *
 * 2. Real-time streaming. The SDK exposes an async generator of
 *    `SDKMessage`s. We forward each assistant text delta as an A2A
 *    `artifact-update`, so GE renders a live "typing" response instead of
 *    the all-or-nothing buffer the old `claude --print` mode produced.
 *
 * Gemini still spawns the `gemini` CLI for now (no equivalent SDK yet).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as ClaudeOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import type {
  DataPart,
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
  TextPart,
} from "@a2a-js/sdk";
import { forwardToWorkstation } from "./forwarder.js";
import {
  getWorkstationTarget,
  invalidateWorkstationCache,
} from "./workstation-client.js";
import { workstationIdForUser } from "./user-resolver.js";

/**
 * When set to "workstation", every authenticated request is forwarded to the
 * user's per-user Cloud Workstation instead of running Claude locally. The
 * workstation runs the same router image with the same executor inside, so
 * the actual Claude run happens there with persistent disk + isolation.
 *
 * Anonymous requests always run locally (no workstation to forward to).
 */
const FORWARD_MODE = (process.env["AGENT_FORWARD_MODE"] ?? "local").toLowerCase();

const WORKSPACE_ROOT = process.env["A2A_WORKSPACE_ROOT"] ?? "/tmp/workspace";
const CLAUDE_HOME = process.env["CLAUDE_HOME"] ?? "/tmp/claude-home";
// When this server runs INSIDE a per-user workstation, the workstation
// itself already provides isolation; collapsing every conversation into a
// single shared workspace dir means files survive context switches.
const A2A_SINGLE_WORKDIR = (
  process.env["A2A_SINGLE_WORKDIR"] ?? "false"
).toLowerCase();
const SPAWN_TIMEOUT_MS = parseInt(
  process.env["A2A_SPAWN_TIMEOUT_MS"] ?? "300000", // 5 min per Gemini turn
  10,
);

if (!existsSync(WORKSPACE_ROOT)) mkdirSync(WORKSPACE_ROOT, { recursive: true });
if (!existsSync(CLAUDE_HOME)) mkdirSync(CLAUDE_HOME, { recursive: true });

function ensureWorkdir(key: string): string {
  // Sanitize so user emails / context ids are safe filesystem segments.
  const safe = key.replace(/[^a-z0-9._-]/gi, "_").slice(0, 200);
  const dir = join(WORKSPACE_ROOT, safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function extractText(message?: Message): string {
  if (!message?.parts) return "";
  return message.parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function chooseAgent(message?: Message): "claude-code" | "gemini-cli" {
  const meta = message?.metadata as { skillId?: string } | undefined;
  if (meta?.skillId === "gemini-cli" || meta?.skillId === "claude-code") {
    return meta.skillId;
  }
  const text = extractText(message).toLowerCase();
  if (text.startsWith("@gemini") || text.includes("[gemini]")) return "gemini-cli";
  return "claude-code";
}

// A2UI button click → A2A Message wire format (v0.8 extension).
//
// When the user clicks a Button in a rendered A2UI card, GE constructs
// a userAction payload and sends it as a DataPart on the next user
// message (alongside a generic placeholder TextPart like "User action
// triggered." / "ユーザー アクションがトリガーされました。" so non-A2UI
// clients still see something).
//
//   message.parts = [
//     { kind: "text", text: "User action triggered." },          // fallback
//     { kind: "data", data: {                                    // real payload
//       userAction: {
//         name: "approve_pr",
//         surfaceId: "pr-review",
//         sourceComponentId: "approve-button",
//         timestamp: "2026-04-23T07:29:31Z",
//         context: { prNumber: 42, ... }
//       }
//     }, metadata: { mimeType: "application/json+a2ui" }}
//   ]
//
// Schema: https://github.com/google/A2UI/blob/main/specification/v0_8/json/client_to_server.json
//
// The legacy `action:<name> {ctx}` text format is kept as a fallback for
// clients that flatten the payload into text instead of a DataPart.
const A2UI_ACTION_RE = /^action:([a-zA-Z_][\w-]*)\s*(\{[\s\S]*\})?\s*$/;

interface InterpretedAction {
  name: string;
  context: Record<string, unknown>;
  surfaceId?: string;
  sourceComponentId?: string;
  source: "dataPart" | "text";
}

/**
 * Pull a v0.8 `userAction` payload out of the message DataParts. Returns
 * undefined when no part carries one. This is the canonical A2UI v0.8
 * wire format — see the schema linked above and the GE cloud_run sample
 * at samples/agent/adk/gemini_enterprise/cloud_run/agent_executor.py in
 * google/A2UI which does the equivalent dispatch.
 */
function parseActionFromDataParts(
  message?: Message,
): InterpretedAction | undefined {
  if (!message?.parts) return undefined;
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const data = (part as DataPart).data as Record<string, unknown> | undefined;
    const userAction = data?.["userAction"];
    if (!userAction || typeof userAction !== "object") continue;
    const ua = userAction as Record<string, unknown>;
    const name = typeof ua["name"] === "string" ? (ua["name"] as string) : "";
    if (!name) continue;
    const rawCtx = ua["context"];
    const context: Record<string, unknown> =
      rawCtx && typeof rawCtx === "object" && !Array.isArray(rawCtx)
        ? (rawCtx as Record<string, unknown>)
        : {};
    return {
      name,
      context,
      surfaceId:
        typeof ua["surfaceId"] === "string"
          ? (ua["surfaceId"] as string)
          : undefined,
      sourceComponentId:
        typeof ua["sourceComponentId"] === "string"
          ? (ua["sourceComponentId"] as string)
          : undefined,
      source: "dataPart",
    };
  }
  return undefined;
}

function parseAction(prompt: string): InterpretedAction | undefined {
  const match = prompt.trim().match(A2UI_ACTION_RE);
  if (!match) return undefined;
  const [, name, ctxJson] = match;
  if (!name) return undefined;
  let context: Record<string, unknown> = {};
  if (ctxJson) {
    try {
      const parsed = JSON.parse(ctxJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      } else {
        console.warn(
          `executor: action context was not a JSON object, ignoring: ${ctxJson.slice(0, 80)}`,
        );
      }
    } catch (err) {
      console.warn(
        `executor: action context was not valid JSON, ignoring: ${(err as Error).message}`,
      );
    }
  }
  return { name, context, source: "text" };
}

/**
 * Rewrite a button-click message into a structured prompt that Claude can
 * reliably reason about. Without this transform Claude sees something like
 * "ユーザー アクションがトリガーされました。" (the GE-generated placeholder
 * TextPart) and has to guess from history what was clicked. The rewrite
 * makes the intent explicit, names the action, includes the resolved
 * context, and reminds Claude how to react (especially around destructive
 * confirmations).
 *
 * Action source preference:
 *   1. `userAction` DataPart (canonical v0.8 wire format)
 *   2. `action:<name> {ctx}` plain-text fallback
 *   3. None — return original prompt unchanged.
 */
function interpretActionPrompt(
  prompt: string,
  message?: Message,
): {
  prompt: string;
  action?: InterpretedAction;
} {
  const action = parseActionFromDataParts(message) ?? parseAction(prompt);
  if (!action) return { prompt };

  const ctxJson = JSON.stringify(action.context);
  const sourceTag =
    action.surfaceId && action.sourceComponentId
      ? ` (surface="${action.surfaceId}" component="${action.sourceComponentId}")`
      : "";
  const rewritten =
    `[A2UI action] The user clicked the "${action.name}" button in your ` +
    `previous A2UI card${sourceTag}.\n` +
    `Context: ${ctxJson}\n\n` +
    `Carry out this action. If the action is destructive (deletes data, ` +
    `sends an external request, costs money) and you have not already ` +
    `shown a confirmation card for it, surface one now instead of acting ` +
    `immediately. Otherwise, do the work and reply with a short status ` +
    `update — emit a follow-up <a2ui-json> card only if the new state ` +
    `would communicate better as a card than as text.`;
  return { prompt: rewritten, action };
}

/**
 * Per-context Claude session state. The SDK assigns a fresh sessionId on the
 * first turn; we cache it so subsequent turns can resume the same conversation.
 *
 * The cache is persisted to A2A_SESSION_STORE_DIR (default $CLAUDE_HOME/.a2a-sessions)
 * so that conversation continuity survives Cloud Run / Workstation restarts.
 * Without persistence, an idle-shutdown of the workstation between turns causes
 * Claude to forget everything the user said earlier in the same chat.
 */
interface ClaudeSession {
  sessionId?: string;
  workDir: string;
  lastUsedAt: number;
}

const SESSION_STORE_DIR =
  process.env["A2A_SESSION_STORE_DIR"] ??
  `${process.env["CLAUDE_HOME"] ?? "/tmp/claude-home"}/.a2a-sessions`;

export class ClaudeAgentExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly geminiProcs = new Map<string, ChildProcess>();
  // Optional cleanup so abandoned sessions don't leak forever.
  private readonly sessionTtlMs = parseInt(
    process.env["A2A_SESSION_TTL_MS"] ?? "3600000", // 1 h
    10,
  );

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, referenceTasks } = ctx;
    const agentId = chooseAgent(userMessage);
    const rawPrompt = extractText(userMessage);
    const { prompt, action } = interpretActionPrompt(rawPrompt, userMessage);
    const startedAt = Date.now();

    // Resolve the GE end-user from the per-request UserBuilder hook. When
    // an OAuth client is registered the user is authenticated; otherwise we
    // fall back to a contextId-derived placeholder so per-conversation
    // workspace isolation still works.
    const user = ctx.context?.user;
    const userId =
      user?.isAuthenticated && user.userName
        ? user.userName.toLowerCase()
        : `anon:${contextId}`;
    // Workspace key:
    //   - Cloud Run (anonymous fallback) keeps per-user isolation by email.
    //   - Workstation forward target receives unauthenticated forwards
    //     (anon:<ctx>); the workstation already represents one user, so
    //     collapse all conversations into the persistent /workspace root
    //     instead of fragmenting them into per-context subdirectories.
    //   - Use a stable single 'shared' directory inside the workstation
    //     so 'a file from a previous conversation' is reachable.
    const workspaceKey =
      A2A_SINGLE_WORKDIR === "true" ? "shared" : userId;
    const workDir = ensureWorkdir(workspaceKey);

    console.log(
      `[${taskId}] execute agent=${agentId} user=${userId} ` +
        `ctx=${contextId} cwd=${workDir} ` +
        `refTasks=${referenceTasks?.length ?? 0} promptChars=${prompt.length} ` +
        (action
          ? `a2uiAction=${action.name} (src=${action.source}${action.surfaceId ? `, surface=${action.surfaceId}` : ""}) `
          : "") +
        `prompt="${prompt.slice(0, 120).replace(/\n/g, " \u21B5 ")}"`,
    );
    // One-time diagnostic: log message metadata so we can find user-identity hints
    // GE may attach. Truncated and rate-limited so it doesn't spam logs.
    const meta = (userMessage as unknown as { metadata?: unknown }).metadata;
    if (meta) {
      console.log(
        `[${taskId}] msg-meta: ${JSON.stringify(meta).slice(0, 500)}`,
      );
    }

    const willForward =
      FORWARD_MODE === "workstation" &&
      user?.isAuthenticated &&
      !!user.userName;

    // Register the task so subsequent status/artifact events have a parent.
    // We always publish this from Cloud Run so the SDK ResultManager has a
    // task to attach upstream events to (when forwarding) or local events
    // to (when running in-process).
    const task: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: userMessage ? [userMessage] : [],
    };
    bus.publish(task);

    if (!prompt) {
      publishStatus(bus, taskId, contextId, "failed", "Empty prompt", true);
      bus.finished();
      return;
    }

    publishStatus(
      bus,
      taskId,
      contextId,
      "working",
      willForward
        ? `Provisioning your workstation…`
        : `Starting ${agentId}…`,
    );

    try {
      if (
        FORWARD_MODE === "workstation" &&
        user?.isAuthenticated &&
        user.userName
      ) {
        await this.forwardToUserWorkstation(
          taskId,
          contextId,
          userMessage!,
          user.userName,
          bus,
        );
      } else if (agentId === "claude-code") {
        await this.runClaude(
          taskId,
          contextId,
          prompt,
          workDir,
          bus,
          referenceTasks,
          contextId, // session cache key: per-conversation memory
        );
      } else {
        await this.runGemini(taskId, contextId, prompt, workDir, bus);
      }
      const dur = Date.now() - startedAt;
      console.log(`[${taskId}] completed in ${dur}ms`);
      publishStatus(bus, taskId, contextId, "completed", undefined, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dur = Date.now() - startedAt;
      console.error(`[${taskId}] failed after ${dur}ms: ${message}`);
      publishStatus(bus, taskId, contextId, "failed", message, true);
    } finally {
      bus.finished();
      this.cleanupExpiredSessions();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const proc = this.geminiProcs.get(taskId);
    if (proc) {
      proc.kill("SIGTERM");
      this.geminiProcs.delete(taskId);
    }
    publishStatus(bus, taskId, "" /* contextId unknown */, "canceled", "Task canceled", true);
    bus.finished();
  }

  // ─── Workstation forward ────────────────────────────────────

  private async forwardToUserWorkstation(
    taskId: string,
    contextId: string,
    userMessage: Message,
    userEmail: string,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const workstationId = workstationIdForUser(userEmail);
    console.log(
      `[${taskId}] forwarding to workstation ${workstationId} for ${userEmail}`,
    );

    // Try once with cached state, then once more with a fresh target if
    // the upstream returned 404 / 503 / 401 — those are the symptoms of a
    // recycled (deleted/recreated/stopped) workstation that's still in our
    // host+token cache.
    let attempts = 0;
    while (true) {
      attempts++;
      let target;
      try {
        target = await getWorkstationTarget(
          workstationId,
          `A2A - ${userEmail}`,
        );
      } catch (err) {
        throw new Error(
          `workstation provisioning failed: ${(err as Error).message}`,
        );
      }
      try {
        await forwardToWorkstation({
          baseUrl: target.url,
          bearerToken: target.bearerToken,
          taskId,
          contextId,
          userMessage,
          bus,
        });
        return;
      } catch (err) {
        const message = (err as Error).message;
        // Treat any HTTP-level rejection from the workstation ingress, plus
        // generic network errors that point at a stopped/recycled
        // workstation, as recyclable. Without ECONNRESET / ETIMEDOUT /
        // "fetch failed" in here, an idle-stopped workstation produces a
        // silent hang that never retries with a fresh start.
        const recyclable =
          /\b(404|502|503|504|401|403)\b/.test(message) ||
          /(workstation unreachable|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))/i.test(
            message,
          );
        invalidateWorkstationCache(workstationId);
        if (recyclable && attempts === 1) {
          console.log(
            `[${taskId}] retrying forward after recyclable error: ${message.slice(0, 200)}`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  // ─── Claude (Agent SDK) ────────────────────────────────────────────────

  private async runClaude(
    taskId: string,
    contextId: string,
    prompt: string,
    workDir: string,
    bus: ExecutionEventBus,
    referenceTasks: ReadonlyArray<Task> | undefined,
    sessionKey: string,
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionKey, workDir);

    // If GE handed us prior conversation context (reference tasks from
    // other agents in the same chat) and we don't yet have a Claude session
    // for this contextId, splice the history into the prompt so Claude sees
    // it. Once we have our own session, the SDK's resume handles continuity
    // for subsequent turns.
    let effectivePrompt = prompt;
    if (!session.sessionId && referenceTasks && referenceTasks.length > 0) {
      const summary = summarizeReferenceTasks(referenceTasks);
      if (summary) {
        effectivePrompt =
          `[Conversation context from prior turns in this Gemini Enterprise chat]\n` +
          `${summary}\n\n` +
          `[Current user message]\n${prompt}`;
        console.log(
          `[${taskId}] injected ${referenceTasks.length} prior task(s) into prompt (${summary.length} chars)`,
        );
      }
    }

    const options: ClaudeOptions = {
      cwd: workDir,
      permissionMode: "bypassPermissions",
      // Optional default model override; users can still set 'model' in
      // ~/.claude/settings.json which takes precedence at SDK init time.
      ...(process.env["A2A_DEFAULT_MODEL"]
        ? { model: process.env["A2A_DEFAULT_MODEL"] }
        : {}),
      // Encourage Claude to narrate before acting so the GE user sees forward
      // motion during long autonomous turns. The tool calls themselves are
      // surfaced separately via extractToolCalls() below.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "## Surface: Gemini Enterprise chat\n" +
          "You are operating inside a Gemini Enterprise chat where the user " +
          "only sees text streamed back to them. " +
          "CRITICAL: Always start your very first output message in a new session with the greeting: " +
          "\"🤖 **안녕하세요! Gemini Enterprise에서 실행 중인 Claude Code 에이전트입니다.**\" as a prominent top header, followed by a double newline.\n\n" +
          "Before using any tool, write " +
          "a short (1-2 sentence) plain-text sentence explaining what you're " +
          "about to do and why. Keep these preambles concise. After finishing " +
          "a multi-step task, end with a short summary of what changed and " +
          "what to look at next.\n\n" +
          "This surface RENDERS A2UI v0.8 (Gemini Enterprise A2UI extension). " +
          "When the response contains a web application, game, dashboard, or structured status that would communicate the answer better as a card, follow the `a2ui-rich-ui` skill in ~/.claude/skills/ and emit one `<a2ui-json>...</a2ui-json>` block alongside your text reply. " +
          "For simple conversational answers or clarifying questions, you may skip the A2UI block.\n\n" +
          "IMPORTANT: this surface marker only applies to the CURRENT turn. " +
          "The same persistent session may be resumed later from a terminal " +
          "via `claude --resume`. When that happens this system instruction " +
          "will not be present, and you must NOT emit <a2ui-json> blocks — " +
          "the terminal would show the raw XML tags. The `a2ui-rich-ui` " +
          "skill includes explicit guidance for detecting that surface change.",
      },
      env: {
        ...process.env,
        HOME: CLAUDE_HOME,
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID:
          process.env["ANTHROPIC_VERTEX_PROJECT_ID"] ??
          process.env["PROJECT_ID"] ??
          "",
        CLOUD_ML_REGION: process.env["CLOUD_ML_REGION"] ?? "us-east5",
        CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
        IS_SANDBOX: "1",
      } as Record<string, string>,
      includePartialMessages: true,
      ...(session.sessionId ? { resume: session.sessionId } : {}),
    };

    // Diagnostics: confirm we are actually invoking resume.
    console.log(
      `[${taskId}] claudeQuery options.resume=${session.sessionId ?? "(none, fresh session)"}`,
    );
    void diagPost(
      `[${taskId}] claudeQuery resume=${session.sessionId ?? "none"} ctx=${contextId}`,
    );

    let accumulated = "";
    let sawPartial = false;

    let messageCount = 0;
    // GE renders the artifact stream by concatenating every chunk it sees
    // AND any 'final' artifact-update with append=false. There is no
    // combination of (append, lastChunk) that gives both per-token
    // streaming AND a clean final render — either we get duplicated
    // leading characters, or we lose part of the response. So: don't
    // stream tokens. Buffer the full text and emit ONE artifact at the
    // end. We still surface tool-call status events live so the user
    // sees forward motion during long turns.
    for await (const sdkMessage of claudeQuery({
      prompt: effectivePrompt,
      options,
    })) {
      messageCount++;
      const newSessionId = handleSessionUpdate(sdkMessage);
      if (newSessionId && newSessionId !== session.sessionId) {
        session.sessionId = newSessionId;
        writePersistedSession(contextId, newSessionId);
        console.log(
          `[${taskId}] cached Claude session ${newSessionId} for context ${contextId}`,
        );
        void diagPost(
          `[${taskId}] cached sessionId=${newSessionId} ctx=${contextId}`,
        );
      }
      session.lastUsedAt = Date.now();

      if (sdkMessage.type === "stream_event") {
        const delta = extractAssistantText(sdkMessage);
        if (delta) {
          accumulated += delta;
          sawPartial = true;
        }
      } else if (sdkMessage.type === "assistant") {
        // Surface tool calls as working-status updates so the GE user can
        // see what Claude is doing during long autonomous turns.
        const tools = extractToolCalls(sdkMessage);
        for (const t of tools) {
          publishStatus(bus, taskId, contextId, "working", t);
        }
        // If we never saw partial deltas (rare, e.g. tool-only turn) the
        // final assistant block IS the response.
        if (!sawPartial) {
          const text = extractAssistantText(sdkMessage);
          if (text) {
            accumulated += text;
          }
        }
      } else if (sdkMessage.type === "user") {
        // tool_result messages come back as 'user' with synthetic origin.
        // Surface a short success/error indicator so the user sees forward
        // motion between long tool calls.
        const status = extractToolResultStatus(sdkMessage);
        if (status) publishStatus(bus, taskId, contextId, "working", status);
      } else if ((sdkMessage as { type?: string }).type === "tool_progress") {
        // SDKToolProgressMessage — fires periodically for long-running tools.
        const tp = sdkMessage as unknown as {
          tool_name?: string;
          elapsed_time_seconds?: number;
        };
        if (tp.tool_name) {
          const secs = Math.round(tp.elapsed_time_seconds ?? 0);
          publishStatus(
            bus,
            taskId,
            contextId,
            "working",
            `⏱ ${tp.tool_name} still running (${secs}s)…`,
          );
        }
      }

      if (sdkMessage.type === "result") {
        console.log(
          `[${taskId}] Claude SDK result subtype=${sdkMessage.subtype} ` +
            `messages=${messageCount} accChars=${accumulated.length}`,
        );
        if (sdkMessage.subtype !== "success") {
          throw new Error(
            `Claude SDK error (${sdkMessage.subtype}): ${
              "error" in sdkMessage && typeof sdkMessage.error === "string"
                ? sdkMessage.error
                : "see Cloud Run logs"
            }`,
          );
        }
        // Single buffered artifact — see the long comment above the loop
        // for why we don't stream the chunks individually.
        publishFinalArtifact(
          bus,
          taskId,
          contextId,
          "🤖 **[Gemini Enterprise - Claude Code]**\n\n" + appendResumeFooter(accumulated, session.sessionId),
        );
        return;
      }
    }

    // The generator finished without a `result` — surface that explicitly.
    console.warn(
      `[${taskId}] Claude SDK stream ended without result (messages=${messageCount} accChars=${accumulated.length})`,
    );
    publishFinalArtifact(
      bus,
      taskId,
      contextId,
      "🤖 **[Gemini Enterprise - Claude Code]**\n\n" + appendResumeFooter(accumulated, session.sessionId),
    );
  }

  // ─── Gemini (CLI subprocess) ───────────────────────────────────────────

  private runGemini(
    taskId: string,
    contextId: string,
    prompt: string,
    workDir: string,
    bus: ExecutionEventBus,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        "gemini",
        ["--yolo", "--skip-trust", "--prompt", prompt],
        {
          cwd: workDir,
          env: {
            ...process.env,
            HOME: CLAUDE_HOME,
            GOOGLE_GENAI_USE_VERTEXAI: "true",
            GOOGLE_CLOUD_PROJECT:
              process.env["GOOGLE_CLOUD_PROJECT"] ??
              process.env["PROJECT_ID"] ??
              "",
            GOOGLE_CLOUD_LOCATION:
              process.env["GOOGLE_CLOUD_LOCATION"] ?? "global",
            CI: "true",
            GEMINI_CLI_TRUST_WORKSPACE: "true",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.geminiProcs.set(taskId, proc);

      const timer = setTimeout(() => {
        console.warn(`[${taskId}] gemini exceeded ${SPAWN_TIMEOUT_MS}ms, killing`);
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
      }, SPAWN_TIMEOUT_MS);

      let full = "";
      let stderr = "";
      proc.stdout?.on("data", (data: Buffer) => {
        full += data.toString();
      });
      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        const line = text.trim();
        if (line) console.warn(`[${taskId}] gemini stderr: ${line}`);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        this.geminiProcs.delete(taskId);
        reject(new Error(`Failed to spawn gemini: ${err.message}`));
      });
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        this.geminiProcs.delete(taskId);
        if (code === 0) {
          publishFinalArtifact(bus, taskId, contextId, "🤖 **[Gemini Enterprise - Gemini CLI]**\n\n" + full);
          resolve();
        } else {
          const detail = stderr.trim() || full.trim() || "(no output)";
          const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
          reject(new Error(`gemini ${reason}: ${detail}`));
        }
      });
    });
  }

  // ─── Session bookkeeping ───────────────────────────────────────────────

  private getOrCreateSession(contextId: string, workDir: string): ClaudeSession {
    const existing = this.sessions.get(contextId);
    if (existing) return existing;

    // Try to recover a sessionId persisted by an earlier process incarnation
    // (Cloud Run instance recycle, Workstation idle shutdown, etc.).
    const persisted = readPersistedSession(contextId);
    if (persisted) {
      console.log(
        `[session] recovered sessionId=${persisted} for context ${contextId} from disk`,
      );
      void diagPost(`[session] recovered sessionId=${persisted} ctx=${contextId}`);
    } else {
      void diagPost(`[session] NO persisted sessionId for ctx=${contextId}`);
    }
    const fresh: ClaudeSession = {
      ...(persisted ? { sessionId: persisted } : {}),
      workDir,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(contextId, fresh);
    return fresh;
  }

  private cleanupExpiredSessions(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        console.log(`Evicted stale Claude session for context ${id}`);
      }
    }
  }
}

// ─── Out-of-band diagnostics (workstation only) ───────────────────

/**
 * Workstation container stdout is not captured by Cloud Logging, but the
 * Cloud Run router has a /__startup_diag sink that does end up there. Let
 * the workstation push runtime diagnostics back so we can see what's
 * happening inside.
 */
const DIAG_URL = process.env["A2A_DIAG_URL"];
async function diagPost(line: string): Promise<void> {
  if (!DIAG_URL) return;
  try {
    await fetch(DIAG_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `${new Date().toISOString()} ${line}`,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort
  }
}

// ─── A2UI extraction (Gemini Enterprise rich UI) ───────────────

const A2UI_TAG_RE = /<a2ui-json>\s*([\s\S]*?)\s*<\/a2ui-json>/m;
const A2UI_FENCE_RE = /```a2ui\s*\n([\s\S]*?)```/m;
// Inner ```json ... ``` wrapper that some LLMs add inside the tags;
// the official A2UI Python parser strips this as sanitization.
const INNER_JSON_FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

/**
 * Pull the first <a2ui-json>...</a2ui-json> block out of Claude's reply
 * and return both the cleaned text and the parsed A2UI v0.8 messages.
 * The Claude skill in workstation-image/skel/.claude/skills/a2ui-rich-ui
 * teaches the model to wrap an A2UI payload in these tags whenever the
 * answer would render better as a card / form / list / dashboard than as
 * plain markdown.
 *
 * Format: a JSON array of v0.8 messages (beginRendering, surfaceUpdate,
 * dataModelUpdate). The XML-style tags match the canonical regex used by
 * google/A2UI's Python parser at agent_sdks/python/src/a2ui/parser/parser.py.
 *
 * Each parsed message becomes its own A2A DataPart with MIME
 * `application/json+a2ui` (see publishFinalArtifact below). This matches
 * the official A2UI Python SDK's create_a2ui_part / parse_response_to_parts
 * shape, which is what Gemini Enterprise's renderer expects when the
 * `https://a2ui.org/a2a-extension/a2ui/v0.8` extension is negotiated.
 *
 * Backcompat: the legacy ```a2ui ... ``` markdown fence with JSONL body
 * is still recognised so workstations seeded with the older skill keep
 * working until they are reprovisioned.
 *
 * Disabled by setting A2A_DISABLE_A2UI=true in the workstation env.
 */
function extractA2UI(body: string): {
  cleanedText: string;
  messages?: object[];
} {
  if (process.env["A2A_DISABLE_A2UI"] === "true") {
    return { cleanedText: body };
  }

  const tagMatch = body.match(A2UI_TAG_RE);
  if (tagMatch?.[1]) {
    const messages = parseA2UIArrayBody(tagMatch[1].trim());
    if (!messages) return { cleanedText: body };
    const cleanedText = body
      .replace(A2UI_TAG_RE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { cleanedText, messages };
  }

  const fenceMatch = body.match(A2UI_FENCE_RE);
  if (fenceMatch?.[1]) {
    const messages = parseA2UIJsonlBody(fenceMatch[1].trim());
    if (!messages) return { cleanedText: body };
    const cleanedText = body
      .replace(A2UI_FENCE_RE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { cleanedText, messages };
  }

  return { cleanedText: body };
}

function repairJson(str: string): string {
  let cleaned = str.trim();

  // 1. Replace unescaped literal newlines inside double quotes with \n
  cleaned = cleaned.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (match, p1) => {
    return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
  });

  // 2. Remove trailing commas inside objects and arrays
  cleaned = cleaned.replace(/,(\s*[\]}])/g, "$1");

  // 3. Balance unmatched brackets/braces at the end of the string
  const stack: ("{" | "[")[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "{") stack.push("{");
    else if (c === "[") stack.push("[");
    else if (c === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
    } else if (c === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
    }
  }

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") cleaned += "}";
    else if (open === "[") cleaned += "]";
  }

  return cleaned;
}

/**
 * Parse the body of an <a2ui-json> block. Per the A2UI v0.8 spec the body
 * is a JSON array of messages, but tolerate (a) a single object that the
 * model emitted instead of a 1-element array and (b) an inner ```json ... ```
 * wrapper that the official Python parser also strips.
 */
function parseA2UIArrayBody(raw: string): object[] | undefined {
  let inner = raw;
  const innerFence = inner.match(INNER_JSON_FENCE_RE);
  if (innerFence?.[1]) inner = innerFence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch (err) {
    try {
      const repaired = repairJson(inner);
      parsed = JSON.parse(repaired);
      console.log("executor: successfully repaired and parsed invalid <a2ui-json> block!");
    } catch (repairErr) {
      console.warn(
        `executor: <a2ui-json> body was not valid JSON, and repair failed: ${(err as Error).message} (repair error: ${(repairErr as Error).message})`,
      );
      return undefined;
    }
  }

  if (Array.isArray(parsed)) {
    const messages = parsed.filter(
      (m): m is object => typeof m === "object" && m !== null,
    );
    return messages.length > 0 ? messages : undefined;
  }
  if (typeof parsed === "object" && parsed !== null) {
    return [parsed as object];
  }
  console.warn(
    "executor: <a2ui-json> body was neither a JSON array nor an object, falling back to text",
  );
  return undefined;
}

/**
 * Legacy backcompat: parse the body of a ```a2ui ... ``` markdown fence
 * as JSONL (one message per line). Kept so workstations that still have
 * the older skill keep rendering A2UI until they are reprovisioned.
 */
function parseA2UIJsonlBody(raw: string): object[] | undefined {
  const messages: object[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (typeof obj === "object" && obj !== null) {
        messages.push(obj);
      }
    } catch {
      console.warn(
        `executor: legacy a2ui fence contained unparseable line, falling back to text: ${trimmed.slice(0, 80)}`,
      );
      return undefined;
    }
  }
  return messages.length > 0 ? messages : undefined;
}

// ─── Resume footer (GE → Workstation handoff) ───────────────────

/**
 * Append a one-line "continue this conversation in the workstation"
 * footer to every Claude reply, when we know the SDK session id. The
 * operator can SSH into the workstation, copy-paste the command, and
 * resume the same Claude session from the terminal.
 *
 * Disabled by setting A2A_DISABLE_RESUME_FOOTER=true in the workstation env.
 */
function appendResumeFooter(
  body: string,
  sessionId: string | undefined,
): string {
  if (!sessionId) return body;
  if (process.env["A2A_DISABLE_RESUME_FOOTER"] === "true") return body;
  const footer =
    `\n\n---\n` +
    `🔗 **Continue in Workstation SSH:** \`claude --resume ${sessionId}\`  \n` +
    `_(or just \`a2a-resume\` for the most recent session)_`;
  return body + footer;
}

// ─── Persistent session map ────────────────────────────────────

function sessionFile(contextId: string): string {
  const safe = contextId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 200);
  return join(SESSION_STORE_DIR, `${safe}.json`);
}

function readPersistedSession(contextId: string): string | undefined {
  try {
    if (!existsSync(SESSION_STORE_DIR)) return undefined;
    const file = sessionFile(contextId);
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      sessionId?: string;
    };
    return data.sessionId;
  } catch (err) {
    console.warn(`[session] failed to read ${contextId}: ${(err as Error).message}`);
    return undefined;
  }
}

function writePersistedSession(contextId: string, sessionId: string): void {
  const file = sessionFile(contextId);
  try {
    if (!existsSync(SESSION_STORE_DIR)) {
      mkdirSync(SESSION_STORE_DIR, { recursive: true });
    }
    writeFileSync(
      file,
      JSON.stringify(
        { sessionId, contextId, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    void diagPost(`[session] wrote ${file} sessionId=${sessionId}`);
  } catch (err) {
    const msg = `[session] failed to persist ${contextId} to ${file}: ${(err as Error).message}`;
    console.warn(msg);
    void diagPost(msg);
  }
}

// ─── Reference task helpers ──────────────────────────────────────

/**
 * Render the conversation history GE hands us as A2A `referenceTasks` into a
 * compact transcript Claude can read. We keep it bounded so a long Gemini
 * Enterprise chat doesn't blow the context window on the very first message.
 */
function summarizeReferenceTasks(tasks: ReadonlyArray<Task>): string {
  const MAX_CHARS = 12_000;
  const lines: string[] = [];

  // Iterate oldest-first when possible so transcript reads chronologically.
  for (const task of tasks) {
    const history = task.history ?? [];
    for (const msg of history) {
      const text = (msg.parts ?? [])
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (!text) continue;
      const role = msg.role === "agent" ? "assistant" : msg.role;
      lines.push(`${role}: ${text}`);
    }
  }

  if (lines.length === 0) return "";

  let transcript = lines.join("\n");
  if (transcript.length > MAX_CHARS) {
    // Keep the most recent portion; that's what GE users care about.
    transcript =
      `… (earlier conversation truncated)\n` +
      transcript.slice(transcript.length - MAX_CHARS);
  }
  return transcript;
}

// ─── SDKMessage helpers ──────────────────────────────────────────────────

function handleSessionUpdate(msg: SDKMessage): string | undefined {
  // The 'system' init message and 'result' message both carry session_id.
  const candidate = (msg as unknown as { session_id?: string }).session_id;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Render a tool-use block as a short, user-friendly status line. Used to
 * keep the GE chat alive while Claude is autonomously working.
 */
function renderToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Bash": {
      const cmd = typeof i["command"] === "string" ? (i["command"] as string) : "";
      const desc = typeof i["description"] === "string" ? (i["description"] as string) : "";
      const head = desc ? `⚙ ${desc}` : `⚙ \`${cmd.slice(0, 100)}\``;
      return head;
    }
    case "Read": {
      const f = typeof i["file_path"] === "string" ? (i["file_path"] as string) : "";
      return `📖 Reading ${f}`;
    }
    case "Write": {
      const f = typeof i["file_path"] === "string" ? (i["file_path"] as string) : "";
      return `✍ Writing ${f}`;
    }
    case "Edit":
    case "MultiEdit": {
      const f = typeof i["file_path"] === "string" ? (i["file_path"] as string) : "";
      return `✏ Editing ${f}`;
    }
    case "Glob": {
      const p = typeof i["pattern"] === "string" ? (i["pattern"] as string) : "";
      return `🔍 Searching files matching \`${p}\``;
    }
    case "Grep": {
      const p = typeof i["pattern"] === "string" ? (i["pattern"] as string) : "";
      return `🔎 Searching for \`${p}\``;
    }
    case "WebFetch": {
      const u = typeof i["url"] === "string" ? (i["url"] as string) : "";
      return `🌐 Fetching ${u}`;
    }
    case "WebSearch": {
      const q = typeof i["query"] === "string" ? (i["query"] as string) : "";
      return `🔍 Web search: ${q}`;
    }
    case "TodoWrite":
      return `📋 Updating task list`;
    case "Task": {
      const desc =
        typeof i["description"] === "string"
          ? (i["description"] as string)
          : typeof i["subagent_type"] === "string"
            ? (i["subagent_type"] as string)
            : "subtask";
      return `🚀 Delegating: ${desc}`;
    }
    default:
      return `🔧 Tool: ${name}`;
  }
}

/**
 * Pull tool-use blocks out of an assistant message, formatted as user-friendly
 * status lines.
 */
function extractToolCalls(msg: SDKMessage): string[] {
  if (msg.type !== "assistant") return [];
  const blocks =
    (msg as unknown as { message?: { content?: Array<unknown> } }).message?.content ?? [];
  const out: string[] = [];
  for (const b of blocks) {
    const block = b as { type?: string; name?: string; input?: unknown };
    if (block.type === "tool_use" && typeof block.name === "string") {
      out.push(renderToolCall(block.name, block.input));
    }
  }
  return out;
}

/**
 * Quick "tool finished" indicator extracted from a synthetic user message
 * carrying tool_result blocks. Returns null if there's nothing useful to show.
 */
function extractToolResultStatus(msg: SDKMessage): string | null {
  if (msg.type !== "user") return null;
  const message = (msg as unknown as { message?: { content?: Array<unknown> } }).message;
  const blocks = message?.content ?? [];
  for (const b of blocks) {
    const block = b as { type?: string; is_error?: boolean };
    if (block.type === "tool_result") {
      return block.is_error === true ? "⚠ tool returned error" : "✓ tool finished";
    }
  }
  return null;
}

/**
 * Pull human-readable text out of an SDKMessage. The SDK emits a mix of
 * content-block types; we grab text deltas (partial) and full text blocks
 * (final assistant message), and ignore tool_use / thinking / images. That
 * keeps the user-visible stream clean.
 */
function extractAssistantText(msg: SDKMessage): string {
  if (msg.type === "stream_event") {
    // Partial assistant message (streaming). The SDK wraps the raw Anthropic
    // event under `event` with the same shape as the API stream.
    const event = (msg as unknown as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return event.delta.text ?? "";
    }
    return "";
  }
  if (msg.type === "assistant") {
    // Final assistant message. Concatenate text blocks; skip tool_use etc.
    const message = (msg as unknown as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
    const blocks = message?.content ?? [];
    return blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
  }
  return "";
}

// ─── A2A event publishers ────────────────────────────────────────────────

function publishStatus(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: string,
  final = false,
): void {
  const event: TaskStatusUpdateEvent = {
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(message
        ? {
            message: {
              kind: "message",
              messageId: randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: message }],
            } as Message,
          }
        : {}),
    },
    final,
  };
  bus.publish(event);
}

function publishStreamingChunk(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  artifactId: string,
  text: string,
  isFirst: boolean,
): void {
  // First chunk replaces (append=false), subsequent chunks append. This is
  // the spec-recommended pattern from a2a-protocol.org/spec.
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    artifact: {
      artifactId,
      name: "response",
      parts: [{ kind: "text", text }],
    },
    append: !isFirst,
    lastChunk: false,
  };
  bus.publish(event);
}

function publishLastChunkMarker(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  artifactId: string,
  fullText: string,
): void {
  // Send the full accumulated text as the last chunk so reconnecting
  // clients can reconstruct the artifact from this single event. We use
  // append=true + lastChunk=true so it adds to whatever the stream had
  // already accumulated; the SDK then computes a single canonical artifact
  // from the sum of (append=false initial + append=true increments +
  // lastChunk total).
  //
  // We previously tried 'empty + lastChunk' to avoid the leading-character
  // duplication GE shows, but it suppressed the entire response — GE only
  // surfaces the text from the LAST chunk. So we have to send the full
  // text here.
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    artifact: {
      artifactId,
      name: "response",
      parts: [{ kind: "text", text: fullText }],
    },
    append: false,
    lastChunk: true,
  };
  bus.publish(event);
}

function publishFinalArtifact(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  text: string,
): void {
  // Strip the optional <a2ui-json> block out of the text and ship each
  // A2UI message as its own structured DataPart. GE renders these as
  // native Material components when the agent has negotiated the A2UI
  // v0.8 extension via the agent card; clients that don't understand
  // the part type just see the cleaned-up text reply.
  //
  // One DataPart per message matches the official A2UI Python SDK
  // (create_a2ui_part / parse_response_to_parts in
  // agent_sdks/python/src/a2ui/a2a/parts.py).
  const { cleanedText, messages } = extractA2UI(text);

  const parts: (TextPart | DataPart)[] = [
    { kind: "text", text: cleanedText },
  ];
  if (messages) {
    for (const message of messages) {
      parts.push({
        kind: "data",
        data: message as Record<string, unknown>,
        metadata: { mimeType: "application/json+a2ui" },
      });
    }
  }

  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    artifact: {
      artifactId: `response-${randomUUID()}`,
      name: "response",
      parts: parts as Part[],
    },
    append: false,
    lastChunk: true,
  };
  bus.publish(event);
}
