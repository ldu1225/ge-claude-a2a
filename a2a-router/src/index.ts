import { writeFile } from "node:fs/promises";
import express from "express";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  UnauthenticatedUser,
  type User,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";
import { buildAgentCard } from "./agent-card.js";
import { ClaudeAgentExecutor } from "./executor.js";
import { resolveUser } from "./user-resolver.js";

const ACTIVITY_FILE = process.env["A2A_ACTIVITY_FILE"];

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const BASE_URL =
  process.env["BASE_URL"] ?? `http://localhost:${PORT}`;

const app = express();

// One-time-per-deploy header dump so we can discover what user identity
// hints (if any) Gemini Enterprise sends in. Dumps the first N POST
// requests then goes quiet.
let headerDumpRemaining = parseInt(
  process.env["A2A_HEADER_DUMP_COUNT"] ?? "0",
  10,
);
app.use((req, _res, next) => {
  // Cost-control activity touch for the workstation idle watchdog.
  if (req.method === "POST" && ACTIVITY_FILE) {
    void writeFile(ACTIVITY_FILE, new Date().toISOString()).catch(() => {});
  }
  if (req.method === "POST" && headerDumpRemaining > 0) {
    headerDumpRemaining--;
    const filtered: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (
        k === "content-type" ||
        k === "content-length" ||
        k === "accept-encoding" ||
        k === "connection" ||
        k === "host" ||
        k === "user-agent"
      ) {
        continue;
      }
      filtered[k] = v;
    }
    console.log(
      `[hdr-dump] POST ${req.url} ${JSON.stringify(filtered).slice(0, 1500)}`,
    );
  }
  next();
});

// Plain health check — handy for uptime monitors.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Diagnostic sink for workstation startup scripts. Workstation container
// stdout is not captured by Cloud Logging, so we let the workstation POST
// its bootstrap diagnostics here and we log them to Cloud Run logs which
// ARE captured. Bounded body length, no auth (best-effort visibility).
app.post("/__startup_diag", express.text({ limit: "8kb" }), (req, res) => {
  const body = typeof req.body === "string" ? req.body : "<non-string>";
  console.log(`[ws-diag] ${body.replace(/\s+/g, " ").slice(0, 800)}`);
  res.status(204).end();
});

// Build the agent card and the SDK request handler.
const agentCard = buildAgentCard(BASE_URL);
const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new ClaudeAgentExecutor(),
);

/**
 * UserBuilder hook: turn an inbound Express request into an A2A `User` by
 * resolving the OAuth bearer Gemini Enterprise attaches when the agent is
 * registered with an OAuth client. Falls back to UnauthenticatedUser when
 * the request only carries the Discovery Engine SA token.
 */
class GoogleOAuthUser implements User {
  constructor(
    private readonly _email: string,
    private readonly _sub: string,
  ) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this._email;
  }
  get sub(): string {
    return this._sub;
  }
}

const userBuilder = async (req: express.Request): Promise<User> => {
  try {
    const resolved = await resolveUser(req);
    if (resolved) return new GoogleOAuthUser(resolved.email, resolved.sub);
  } catch (err) {
    console.warn(`userBuilder: ${(err as Error).message}`);
  }
  return new UnauthenticatedUser();
};

// Raise JSON body limit before A2AExpressApp registers its own parser.
// Default is 100KB; Gemini Enterprise can pack large multi-turn context
// (e.g. previous tool outputs from a PRD search + GitHub Issue lookup)
// into a single Message, easily blowing past 100KB and triggering a
// 413 PayloadTooLargeError. Express body-parser uses first-match, so
// mounting our parser first wins. 10MB matches Cloud Run's max request
// size and is generous enough for any realistic agent context.
app.use(express.json({ limit: "10mb" }));

new A2AExpressApp(requestHandler, userBuilder).setupRoutes(app, "");

app.listen(PORT, () => {
  console.log(`A2A server listening on port ${PORT}`);
  console.log(`Agent card: ${BASE_URL}/.well-known/agent-card.json`);
});
