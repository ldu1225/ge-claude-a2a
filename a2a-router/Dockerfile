FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim

# System packages used by the agents:
#   procps -> pgrep/ps for the Gemini CLI's internal process inspection
#   git    -> common workflow helper Claude Agent SDK relies on
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        procps && \
    rm -rf /var/lib/apt/lists/*

# Gemini CLI is still spawned as a subprocess; install it globally.
# Claude Code is now driven through @anthropic-ai/claude-agent-sdk, which
# bundles its own native binary as an optional dependency installed via npm,
# so we do NOT install claude-code globally any more.
RUN npm install -g --no-audit --no-fund @google/gemini-cli && \
    npm cache clean --force

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && \
    npm install --no-save --no-audit --no-fund \
        @anthropic-ai/claude-agent-sdk-linux-x64@0.2.116 && \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
           node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl \
           node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64 \
           node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64 \
           node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64 \
           node_modules/@anthropic-ai/claude-agent-sdk-win32-x64 \
           node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64
COPY --from=build /app/dist dist/

# Claude Code refuses --permission-mode bypassPermissions when running as
# root, so create a non-root user and switch to it.
RUN useradd -m -u 1001 -s /bin/bash a2a && \
    mkdir -p /home/a2a/.claude /tmp/workspace /tmp/claude-home && \
    chown -R a2a:a2a /app /home/a2a /tmp/workspace /tmp/claude-home
USER a2a
ENV HOME=/home/a2a

# Default Vertex AI auth env. PROJECT_ID and ANTHROPIC_VERTEX_PROJECT_ID
# are injected at runtime by Cloud Run (set by Terraform / deploy.sh).
ENV NODE_ENV=production \
    CLAUDE_CODE_USE_VERTEX=1 \
    CLOUD_ML_REGION=us-east5 \
    GOOGLE_GENAI_USE_VERTEXAI=true \
    GOOGLE_CLOUD_LOCATION=global \
    A2A_WORKSPACE_ROOT=/tmp/workspace \
    CLAUDE_HOME=/home/a2a

EXPOSE 8080
CMD ["node", "dist/index.js"]
