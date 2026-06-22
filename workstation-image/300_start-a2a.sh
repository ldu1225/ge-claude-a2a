#!/bin/bash
# Start the A2A server on workstation boot.
# Placed in /etc/workstation-startup.d/ to auto-run.
#
# This is the SAME compiled router code that runs on Cloud Run, just with
# no UserBuilder hook (Cloud Run has already identified the end user).

# Don't use set -e here — we want the script to keep going even if one
# subshell fails, so we can dump diagnostic info.
set -uo pipefail

# Cloud Workstations captures stdout/stderr from startup scripts in the
# instance serial console; tee to file as well so SSH-in debugging works.
LOG_FILE="/var/log/a2a-server.log"
SRV_DIR="/opt/a2a-server"
ACTIVITY_FILE="/tmp/a2a-last-activity"

# Helper: best-effort POST diagnostics to a sink we CAN see, since
# Workstation container stdout/stderr is not captured by Cloud Logging.
DIAG_URL="${A2A_DIAG_URL:-}" # opt-in: set A2A_DIAG_URL on the workstation config to enable startup diagnostics
diag() {
  local msg="$1"
  echo "$(date -Iseconds) $msg" | tee -a "$LOG_FILE"
  curl -sS -m 5 -X POST "$DIAG_URL" \
    -H 'Content-Type: text/plain' \
    --data-binary "$(date -Iseconds) ws=$(hostname) $msg" >/dev/null 2>&1 || true
}

diag "====== a2a startup begin ======"
diag "script: $0"
diag "whoami: $(whoami)"
diag "node: $(command -v node) ($(node --version 2>&1 || true))"
diag "SRV_DIR exists? $([[ -d $SRV_DIR ]] && echo yes || echo no)"
if [[ -d "$SRV_DIR" ]]; then
  diag "SRV_DIR ls: $(ls "$SRV_DIR" 2>&1 | tr '\n' ' ')"
  diag "SRV_DIR/dist ls: $(ls "$SRV_DIR/dist" 2>&1 | tr '\n' ' ' || true)"
fi

# Vertex AI authentication (no API keys needed; uses ADC from workstation SA)
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID="${ANTHROPIC_VERTEX_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
export CLOUD_ML_REGION="${CLOUD_ML_REGION:-us-east5}"
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}"
export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"

# Workspace lives on the persistent home disk so files survive workstation
# stops. Cloud Workstations mounts user home as a PD by default.
export A2A_WORKSPACE_ROOT="${A2A_WORKSPACE_ROOT:-/home/user/workspace}"
# Use the standard $HOME/.claude path so files Yuting edits via the
# Code OSS UI (CLAUDE.md, settings.json, etc.) line up with the SDK's
# expected locations.
export CLAUDE_HOME="${CLAUDE_HOME:-/home/user}"
# Pre-create everything we'll write to so an operator who SSHes in
# immediately sees the directories. Otherwise on a fresh workstation
# 'ls ~/.a2a-sessions' returns nothing and looks broken.
mkdir -p \
  "$A2A_WORKSPACE_ROOT" \
  "$CLAUDE_HOME/.claude" \
  "$CLAUDE_HOME/.claude/projects" \
  "$CLAUDE_HOME/.a2a-sessions" \
  2>&1 | tee -a "$LOG_FILE" || true

# Org-wide CLAUDE.md (operator instructions Claude Code auto-reads at
# session start). The image ships /etc/skel-a2a/CLAUDE.md; we copy it
# to the persistent home on FIRST boot only, so any edits the user
# makes via Code OSS survive across restarts. To force a re-sync, the
# user can `rm ~/CLAUDE.md` and reboot.
if [[ -f /etc/skel-a2a/CLAUDE.md && ! -f "$CLAUDE_HOME/CLAUDE.md" ]]; then
  cp /etc/skel-a2a/CLAUDE.md "$CLAUDE_HOME/CLAUDE.md"
  chown user:user "$CLAUDE_HOME/CLAUDE.md" 2>/dev/null || true
  diag "seeded $CLAUDE_HOME/CLAUDE.md from image template"
fi

# Org-wide skills bundle. Repo-managed by default: every boot we rsync
# the skel into ~/.claude/skills/, with --delete so example files that
# have been removed upstream don't linger. This means a fix shipped to
# /etc/skel-a2a/.claude/skills/ reaches every workstation on next boot
# without manual intervention.
#
# Opt-out: if a user wants to fork a skill locally and stop the auto-sync,
# they `touch ~/.claude/skills/<name>/.user-claimed`. The next boot leaves
# that skill alone. Removing the file resumes auto-sync.
#
# We exclude `.user-claimed` from the rsync so the sentinel itself
# survives the sync.
if [[ -d /etc/skel-a2a/.claude/skills ]]; then
  mkdir -p "$CLAUDE_HOME/.claude/skills"
  for skill_dir in /etc/skel-a2a/.claude/skills/*/; do
    [[ -d "$skill_dir" ]] || continue
    skill_name=$(basename "$skill_dir")
    target="$CLAUDE_HOME/.claude/skills/$skill_name"

    if [[ -f "$target/.user-claimed" ]]; then
      diag "skipped skill $skill_name (user-claimed; remove .user-claimed to resume sync)"
      continue
    fi

    rsync -a --delete --exclude='.user-claimed' "$skill_dir" "$target/"
    chown -R user:user "$target" 2>/dev/null || true
    diag "synced skill $skill_name into $target"
  done
fi

# Make Vertex AI auth + the helpful aliases automatic for SSH-in shells
# so the operator doesn't have to manually export them every time.
#
# IMPORTANT: /etc/profile.d/*.sh is only sourced for *login* shells. The
# Code OSS web terminal opens a *non-login* interactive shell, so anything
# we put under /etc/profile.d would not be visible there. Drop the file
# under /etc/bash.bashrc.d/ AND have /etc/bash.bashrc source it, so both
# login (gcloud workstations ssh) and non-login (Code OSS terminal) shells
# pick up the aliases / env.
mkdir -p /etc/bash.bashrc.d
if ! grep -q 'bash.bashrc.d' /etc/bash.bashrc 2>/dev/null; then
  cat >> /etc/bash.bashrc <<'BASHRC'
# Source A2A helpers for every interactive bash (login or not).
if [ -d /etc/bash.bashrc.d ]; then
  for _f in /etc/bash.bashrc.d/*.sh; do
    [ -r "$_f" ] && . "$_f"
  done
  unset _f
fi
BASHRC
fi
cat > /etc/bash.bashrc.d/a2a-claude-env.sh <<'EOF'
# Auto-injected by /etc/workstation-startup.d/300_start-a2a.sh.
# Tells Claude Code (CLI + SDK) to use Vertex AI / ADC.
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID="${ANTHROPIC_VERTEX_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
export CLOUD_ML_REGION="${CLOUD_ML_REGION:-us-east5}"
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}"
export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"

# Convenience aliases for resuming A2A conversations interactively.
#
# IMPORTANT: 'claude --resume' looks for transcripts under a directory name
# derived from the current working directory (e.g. /home/user/workspace/shared
# becomes ~/.claude/projects/-home-user-workspace-shared/). The A2A server
# always runs Claude from /home/user/workspace/shared, so any resume command
# has to cd there first or claude will report 'No conversations found'.
# a2a-sessions: list every contextId -> sessionId mapping with the first
#   user prompt from each session so you can recognise which is which.
# a2a-resume: resume the most recently updated session (no args needed).
# a2a-pick:   interactive picker over recent sessions, with a 1-line
#   preview of each conversation's first user message.
# a2a-cd:     just jump into the project directory the SDK uses.
alias a2a-cd='cd /home/user/workspace/shared'

a2a-sessions() {
  local f sid first
  if ! compgen -G ~/.a2a-sessions/*.json > /dev/null; then
    echo "no a2a sessions yet"
    return
  fi
  printf '%-22s %-38s %s\n' 'CONTEXT' 'SESSION' 'FIRST PROMPT'
  for f in $(ls -t ~/.a2a-sessions/*.json); do
    sid=$(jq -r .sessionId < "$f" 2>/dev/null)
    first=$(_a2a_first_prompt "$sid")
    printf '%-22s %-38s %s\n' "$(basename "$f" .json | cut -c1-20)" "$sid" "${first:0:60}"
  done
}

a2a-resume() {
  cd /home/user/workspace/shared || return
  local f sid
  f=$(ls -t ~/.a2a-sessions/*.json 2>/dev/null | head -1)
  if [[ -z "$f" ]]; then
    echo "no a2a sessions yet"
    return
  fi
  sid=$(jq -r .sessionId < "$f")
  echo "→ resuming sessionId=$sid"
  claude --resume "$sid"
}

a2a-pick() {
  cd /home/user/workspace/shared || return
  local files=()
  local labels=()
  local f sid first
  for f in $(ls -t ~/.a2a-sessions/*.json 2>/dev/null); do
    sid=$(jq -r .sessionId < "$f" 2>/dev/null)
    [[ -z "$sid" || "$sid" == "null" ]] && continue
    first=$(_a2a_first_prompt "$sid")
    files+=("$sid")
    labels+=("${first:0:70}  [${sid:0:8}]")
  done
  if (( ${#files[@]} == 0 )); then
    echo "no a2a sessions yet"
    return
  fi
  PS3=$'\nPick a session to resume (number, q to quit): '
  select label in "${labels[@]}"; do
    if [[ -n "$label" && -n "${files[$REPLY-1]:-}" ]]; then
      echo "→ resuming sessionId=${files[$REPLY-1]}"
      claude --resume "${files[$REPLY-1]}"
      return
    elif [[ "$REPLY" == "q" ]]; then
      return
    fi
  done
}

# Internal: extract the first user prompt from a Claude SDK transcript
# so the picker shows something more meaningful than a UUID.
_a2a_first_prompt() {
  local sid="$1"
  local jsonl=~/.claude/projects/-home-user-workspace-shared/${sid}.jsonl
  [[ -r "$jsonl" ]] || { echo '(no transcript)'; return; }
  jq -r 'select(.type=="user") | .message.content[]? | select(.type=="text") | .text' \
    < "$jsonl" 2>/dev/null \
  | head -1 \
  | tr '\n' ' ' \
  | sed -E 's/[[:space:]]+/ /g; s/^ +//; s/ +$//'
}
EOF
chmod 644 /etc/profile.d/a2a-claude-env.sh
# Drop a README so operators know what's in here.
cat > "$CLAUDE_HOME/.a2a-sessions/README.md" <<'EOF' 2>/dev/null || true
This directory holds the contextId -> Claude SDK sessionId pointers used
by the A2A executor. Each *.json file maps one Gemini Enterprise
conversation to a Claude Code session that lives under
~/.claude/projects/.

To resume an A2A conversation interactively:
  cat ~/.a2a-sessions/<contextId>.json | jq -r .sessionId
  claude --resume <sessionId>

Or just:
  claude --resume     # interactive picker over recent sessions
EOF

# CRITICAL: Make EVERYTHING under /home/user owned by 'user' so the
# operator who SSHes into the workstation via VS Code can actually edit
# the files Claude wrote. The startup script runs as root, so without
# this Yuting hits 'EACCES: permission denied' on CLAUDE.md / .claude/
# settings.json / etc.
chown -R user:user /home/user 2>&1 | tee -a "$LOG_FILE" || true
# Group-writable so future root-side processes (rare) don't relock files.
chmod -R u+rwX,g+rwX /home/user 2>&1 | tee -a "$LOG_FILE" || true

# This is a workstation behind the Cloud Run router; tell the router code
# not to attempt OAuth userinfo lookups.
export A2A_HEADER_DUMP_COUNT=0

# The Cloud Run side already isolates by user (one workstation per email);
# collapse all conversations to a single workspace dir so files persist
# across context switches. Without this each contextId would get its own
# subdir and 'the file from earlier in this chat' would seem to vanish.
export A2A_SINGLE_WORKDIR=true

# Always run Claude in-process inside the workstation; never re-forward.
export AGENT_FORWARD_MODE=local

# Echo runtime diagnostics back to Cloud Run so we can see them in logs.
# (workstation container stdout is NOT captured by Cloud Logging)
export A2A_DIAG_URL="$DIAG_URL"

# Cost-control: tell the wrapper where to record activity timestamps
export A2A_ACTIVITY_FILE="$ACTIVITY_FILE"
date -Iseconds > "$ACTIVITY_FILE"

cd "$SRV_DIR" || { diag "FATAL: cannot cd to $SRV_DIR"; exit 1; }
diag "cwd: $(pwd)"

# Run the A2A server as 'user' (not root) so any files Claude writes
# via the SDK — CLAUDE.md, settings.json, repo files, etc. — are owned
# by 'user' and editable from the workstation's Code OSS UI.
# We set HOME=/home/user explicitly so the SDK and any subprocess that
# reads $HOME (e.g. claude --resume looking for ~/.claude) lands in the
# right place. CLAUDE_HOME is also pinned for our own writePersistedSession.
touch "$LOG_FILE" && chown user:user "$LOG_FILE" || true

# Build an explicit env for runuser; --preserve-environment is too lossy
# (drops PATH for the target user) and we want full control over what
# the Node process sees.
#
# We wrap the actual `node` invocation in a respawn loop so the workstation
# self-heals when the inner A2A server dies for any reason (uncaught
# exception, OOM, SIGTERM from the Anthropic SDK, idle-killer, etc).
# Without this loop the cluster control-plane keeps reporting the
# workstation as RUNNING but every router request lands on a dead port
# 8080 and gets 503 forever — we hit this in production on 2026-04-23.
#
# Backoff schedule: 2s, 5s, 10s, 30s, 60s, then capped at 60s. If the
# server crashes >5 times within 5 minutes we bail and let the watchdog
# reboot the workstation — something is structurally wrong in that case
# and looping faster would just waste Vertex quota.
A2A_SERVER_PID_FILE="/var/log/a2a-server.pid"
touch "$A2A_SERVER_PID_FILE" && chown user:user "$A2A_SERVER_PID_FILE" || true

(
  set +e
  CRASH_COUNT=0
  CRASH_WINDOW_START=$(date +%s)
  BACKOFFS=(2 5 10 30 60)
  while true; do
    env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/home/user \
        USER=user \
        LOGNAME=user \
        SHELL=/bin/bash \
        PORT=8080 \
        BASE_URL="http://localhost:8080" \
        NODE_ENV=production \
        CLAUDE_HOME="$CLAUDE_HOME" \
        A2A_WORKSPACE_ROOT="$A2A_WORKSPACE_ROOT" \
        A2A_SESSION_STORE_DIR="$CLAUDE_HOME/.a2a-sessions" \
        A2A_SINGLE_WORKDIR="$A2A_SINGLE_WORKDIR" \
        A2A_HEADER_DUMP_COUNT=0 \
        AGENT_FORWARD_MODE="$AGENT_FORWARD_MODE" \
        A2A_DIAG_URL="$A2A_DIAG_URL" \
        A2A_ACTIVITY_FILE="$A2A_ACTIVITY_FILE" \
        CLAUDE_CODE_USE_VERTEX="$CLAUDE_CODE_USE_VERTEX" \
        ANTHROPIC_VERTEX_PROJECT_ID="$ANTHROPIC_VERTEX_PROJECT_ID" \
        CLOUD_ML_REGION="$CLOUD_ML_REGION" \
        GOOGLE_GENAI_USE_VERTEXAI="$GOOGLE_GENAI_USE_VERTEXAI" \
        GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" \
        GOOGLE_CLOUD_LOCATION="$GOOGLE_CLOUD_LOCATION" \
      runuser -u user -- \
        node "$SRV_DIR/dist/index.js" >> "$LOG_FILE" 2>&1 &
    NODE_PID=$!
    echo "$NODE_PID" > "$A2A_SERVER_PID_FILE"
    diag "A2A server started (PID $NODE_PID, runuser=user, attempt $((CRASH_COUNT + 1)))"
    wait "$NODE_PID"
    EXIT_CODE=$?
    NOW=$(date +%s)
    if (( NOW - CRASH_WINDOW_START > 300 )); then
      CRASH_COUNT=0
      CRASH_WINDOW_START=$NOW
    fi
    CRASH_COUNT=$((CRASH_COUNT + 1))
    BACKOFF_IDX=$((CRASH_COUNT - 1))
    if (( BACKOFF_IDX >= ${#BACKOFFS[@]} )); then
      BACKOFF_IDX=$((${#BACKOFFS[@]} - 1))
    fi
    BACKOFF=${BACKOFFS[$BACKOFF_IDX]}
    diag "A2A server PID $NODE_PID exited code=$EXIT_CODE (crash $CRASH_COUNT in current 5-min window); restarting in ${BACKOFF}s. Last log lines: $(tail -10 "$LOG_FILE" 2>&1 | tr '\n' ' ' | head -c 800)"
    if (( CRASH_COUNT > 5 )); then
      diag "A2A server crashed >5 times in 5 min; giving up so the idle watchdog reboots the workstation"
      break
    fi
    sleep "$BACKOFF"
  done
) >> "$LOG_FILE" 2>&1 &
RESPAWN_PID=$!
diag "A2A respawn supervisor started (PID $RESPAWN_PID)"

# Wait briefly for the supervisor to spawn the first node child so the
# health-check loop below has something to talk to. WRAPPER_PID is kept
# pointing at the supervisor: killing it (e.g. from the idle watchdog)
# tears down the whole tree.
WRAPPER_PID=$RESPAWN_PID
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -s "$A2A_SERVER_PID_FILE" ]] && kill -0 "$(cat "$A2A_SERVER_PID_FILE")" 2>/dev/null; then
    break
  fi
  sleep 1
done

# Verify the server is actually listening shortly after launch.
for i in 1 2 3 4 5 6; do
  sleep 5
  if curl -sS -m 3 http://localhost:8080/health >/dev/null 2>&1; then
    diag "server health-check OK after ${i}x5s"
    break
  fi
  if ! kill -0 "$WRAPPER_PID" 2>/dev/null; then
    diag "FATAL: node exited early. Last log lines: $(tail -20 "$LOG_FILE" 2>&1 | tr '\n' ' ')"
    break
  fi
  diag "waiting for server... ${i}x5s"
done

# ----------------------------------------------------------------------------
# Idle watchdog (cost control). Forces shutdown after no HTTP activity for
# A2A_IDLE_LIMIT_SECONDS (default 15 min). Cloud Workstations' native
# idle_timeout only counts SSH activity, so this fills the gap for the
# HTTP-driven a2a workload.
# ----------------------------------------------------------------------------
IDLE_LIMIT_SECONDS="${A2A_IDLE_LIMIT_SECONDS:-900}"
CHECK_INTERVAL="${A2A_IDLE_CHECK_INTERVAL:-60}"

(
  while true; do
    sleep "$CHECK_INTERVAL"
    if [[ -f "$ACTIVITY_FILE" ]]; then
      LAST_ACTIVITY=$(stat -c %Y "$ACTIVITY_FILE" 2>/dev/null || echo 0)
    else
      LAST_ACTIVITY=0
    fi
    NOW=$(date +%s)
    AGE=$((NOW - LAST_ACTIVITY))

    if (( AGE > IDLE_LIMIT_SECONDS )); then
      echo "$(date -Iseconds) Idle watchdog: no activity for ${AGE}s (limit ${IDLE_LIMIT_SECONDS}s), shutting down workstation" | tee -a "$LOG_FILE"
      kill -TERM "$WRAPPER_PID" 2>/dev/null || true
      sleep 5
      sudo shutdown -h now || shutdown -h now || true
      exit 0
    fi
  done
) &
WATCHDOG_PID=$!
echo "$(date -Iseconds) Idle watchdog started (PID $WATCHDOG_PID, limit ${IDLE_LIMIT_SECONDS}s)" | tee -a "$LOG_FILE"
