# Cloud Workstations base image with Code OSS so users can also SSH in
# and inspect their workspace if they want.
FROM us-central1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest

USER root

# System packages used by the agents:
#   procps -> pgrep/ps for the Gemini CLI's internal process inspection
#   git    -> common workflow helper Claude Agent SDK relies on
#   sudo   -> the in-container idle watchdog uses 'sudo shutdown'
#   rsync  -> 300_start-a2a.sh uses it to refresh repo-managed skills
#             from /etc/skel-a2a on every boot (with --delete so removed
#             example files don't linger).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends \
        nodejs \
        systemd-sysv \
        sudo \
        git \
        procps \
        gnupg \
        rsync \
        ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) so Claude can `gh pr create`, `gh issue list`, etc.
# Authentication is the user's responsibility (`gh auth login` from the
# Code OSS terminal); we deliberately don't bake credentials into the
# image.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Gemini CLI is still spawned as a subprocess; install it globally.
# Also install Claude Code CLI globally so SSH-in operators can resume
# sessions interactively (claude --resume <session-id>) and inspect them.
# The A2A server itself uses the SDK's bundled binary, not this one.
RUN npm install -g --no-audit --no-fund \
        @google/gemini-cli \
        @anthropic-ai/claude-code && \
    npm cache clean --force

# ---- A2A server (same code as the Cloud Run router) ----
# The workstation runs the exact same A2A SDK + Claude Agent SDK server the
# router uses; no UserBuilder, no forward — just runs Claude in-process for
# whichever user the Cloud Run router has already identified.
WORKDIR /opt/a2a-server
COPY a2a-router/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY a2a-router/tsconfig.json ./
COPY a2a-router/src/ ./src/
RUN npm install --no-save --no-audit --no-fund \
        typescript@5.5 \
        @types/node@20 \
        @types/express@4 && \
    npx tsc && \
    npm prune --omit=dev

# Force the glibc native binary for Claude Agent SDK. The SDK auto-detection
# (see node_modules/.../assistant.mjs LV() function) tries the musl variant
# FIRST on Linux and only falls back to glibc when the musl package isn't
# installed. Cloud Build's npm install picks up the musl variant via
# optionalDependencies, so we must:
#   1. Install the glibc package explicitly (in case it was skipped).
#   2. Delete the musl package so the SDK falls through to glibc.
# The workstation base image is Debian (glibc); the musl variant aborts at
# runtime with 'native binary not found'.
RUN npm install --no-save --no-audit --no-fund \
        @anthropic-ai/claude-agent-sdk-linux-x64@0.2.116 && \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
           node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl \
           node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64 \
           node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64 \
           node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64 \
           node_modules/@anthropic-ai/claude-agent-sdk-win32-x64 \
           node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64

# Startup script. Cloud Workstations runs files under
# /etc/workstation-startup.d/* in lexicographical order. Numbers <=200 are
# reserved for the base image (000_configure-docker, 010_add-user, ...), so
# we use 300_ to ensure our hook runs AFTER the user has been created and
# the persistent disk has been mounted onto /home/user.
COPY workstation-image/300_start-a2a.sh /etc/workstation-startup.d/300_start-a2a.sh
RUN chmod +x /etc/workstation-startup.d/300_start-a2a.sh

# Default org-wide CLAUDE.md ships in /etc/skel-a2a/. The startup script
# copies it to /home/user/CLAUDE.md on first boot only, so users (and
# their per-project repo-level CLAUDE.md files) can override / extend
# it without us clobbering their edits on every restart.
RUN mkdir -p /etc/skel-a2a /etc/skel-a2a/.claude/skills
COPY workstation-image/CLAUDE.md.template /etc/skel-a2a/CLAUDE.md
# Org-wide skill bundle. Anything under workstation-image/skel/ is laid
# down under /etc/skel-a2a/ at build time, then the startup script
# rsync-style copies new files to ~/ on first boot. The first concrete
# skill bundled is `a2ui-rich-ui`, which teaches Claude when and how to
# emit Gemini-Enterprise-renderable A2UI cards/forms/dashboards.
COPY workstation-image/skel/.claude/ /etc/skel-a2a/.claude/

# /home/user is mounted from the persistent disk at workstation runtime.
# Don't chown at build time — the user account doesn't exist in the base
# image yet (Cloud Workstations creates it during start). The startup
# script handles directory creation with the correct ownership.

# Default Vertex AI auth env. ANTHROPIC_VERTEX_PROJECT_ID and
# GOOGLE_CLOUD_PROJECT are injected at runtime by the workstation config
# (set by Terraform from var.project_id).
ENV CLAUDE_CODE_USE_VERTEX=1 \
    CLOUD_ML_REGION=us-east5 \
    GOOGLE_GENAI_USE_VERTEXAI=true \
    GOOGLE_CLOUD_LOCATION=global \
    A2A_WORKSPACE_ROOT=/home/user/workspace \
    CLAUDE_HOME=/home/user

WORKDIR /home/user/workspace
