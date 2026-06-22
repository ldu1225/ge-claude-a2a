import type { AgentCard } from "@a2a-js/sdk";

/**
 * Build the public Agent Card served at `/.well-known/agent-card.json`.
 *
 * Field choices follow the A2A v1.0 specification — and specifically the
 * Gemini Enterprise import validator, which:
 * - rejects bare "text" for default modes; requires real MIME types like
 *   "text/plain"
 * - expects `protocolVersion: "v1.0"` for the v1 wire format
 *
 * @see https://a2a-protocol.org/v1.0.0/specification
 * @see https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent
 */
export function buildAgentCard(baseUrl: string): AgentCard {
  const iconUrl = process.env["AGENT_ICON_URL"];
  return {
    name: "GE Claude & Gemini Agent",
    description:
      "AI coding assistant providing Claude Code and Gemini CLI capabilities via the A2A protocol. Backed by Vertex AI (Anthropic Claude + Google Gemini) and an isolated Cloud Workstation per user.",
    url: baseUrl,
    ...(iconUrl ? { iconUrl } : {}),
    documentationUrl: "https://github.com/yuting0624/ge-claude-a2a",
    protocolVersion: "v1.0",
    version: "0.2.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      // Declare the A2UI v0.8 extension so Gemini Enterprise will render
      // any A2A DataPart with mimeType "application/json+a2ui" emitted by
      // the executor as a native Material UI component.
      // @see https://a2ui.org/specification/v0.8-a2a-extension/
      extensions: [
        {
          uri: "https://a2ui.org/a2a-extension/a2ui/v0.8",
          description:
            "Renders rich UI cards, forms, lists, dashboards, and confirmation prompts in Gemini Enterprise via A2UI v0.8.",
          required: false,
          params: {
            supportedCatalogIds: [
              "https://a2ui.org/specification/v0_8/standard_catalog_definition.json",
            ],
            acceptsInlineCatalogs: false,
          },
        },
      ],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json+a2ui"],
    skills: [
      {
        id: "claude-code",
        name: "Claude Code",
        description:
          "Execute coding tasks with Claude Code (Anthropic Claude via Vertex AI). Has full read/write access to a per-user workspace.",
        tags: ["code", "claude", "ai-assistant"],
        examples: [
          "Fix the bug in src/index.ts",
          "Add unit tests for the auth module",
          "Refactor the database layer to use connection pooling",
        ],
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        description:
          "Execute coding tasks with Gemini CLI (Google Gemini via Vertex AI). Prefix prompts with @gemini to route here.",
        tags: ["code", "gemini", "ai-assistant"],
        examples: [
          "@gemini Explain how the API routes work",
          "@gemini Generate a REST API for user management",
          "@gemini Analyze this codebase for security issues",
        ],
      },
    ],
    provider: {
      organization: "Google Cloud",
      url: "https://cloud.google.com",
    },
  };
}
