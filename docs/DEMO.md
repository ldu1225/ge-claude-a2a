# Demo Script — Gemini Enterprise × Claude Code

A live walkthrough of the per-user Cloud Workstation + Claude Agent SDK demo.

## Setup checklist (before customer call)

- [ ] Cloud Run revision: `gcloud run services describe a2a-router --region us-central1 --format='value(status.latestReadyRevisionName)'`
- [ ] Workstation image up to date: `gcloud workstations configs describe a2a-agent-config --cluster ai-agents-cluster --region asia-northeast1 --format='value(container.image)'`
- [ ] Smoke test:
  ```bash
  TOKEN=$(gcloud auth print-access-token)
  curl -sS -X POST <YOUR_ROUTER_URL>/ \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"kind":"message","messageId":"smoke","role":"user","parts":[{"kind":"text","text":"Reply with OK"}]}},"id":1}' \
    | jq -r '.result.artifacts[-1].parts[-1].text // .result.status.message.parts[0].text'
  ```
  Should print "OK". First call after a workstation idle-shutdown takes 90-300 s (cold start).

---

## Recommended demo arc (≈ 15 min)

### 1. Register the agent (1 min, can be pre-done)
- GE Console → Agents → Add Agents → Custom agent via A2A
- Paste the agent card JSON (URL: `<YOUR_ROUTER_URL>/.well-known/agent-card.json`)
- Authorize agent → existing OAuth client (`<YOUR_OAUTH_CLIENT_ID>`)

### 2. "Hello world" turn (proves it's alive)
> "Reply with: WORKSTATION OK"

Cold start: 60-90 s. Warm: 5-10 s. Talking points while waiting:
- One Claude Code per GE end user — user identity comes from the OAuth bearer
- Provisioning is idempotent: first turn creates the workstation, subsequent turns reuse it
- 15 min idle → workstation shuts itself down (cost control)

### 3. Conversation memory (the killer feature)
> "Remember: my project codename is BANANA. Just say acknowledged."
> ... wait for response ...
> "What is my project codename?"

→ Should reply "BANANA". Talking points:
- contextId from GE → Claude SDK sessionId mapped on persistent disk
- Survives workstation restarts; can be replayed manually via `claude --resume <id>`

### 4. Multi-step coding work (workspace persistence)
> "In /home/user/workspace/shared/ create a Python web app called 'tasktracker' with a single GET /health endpoint. Don't ask for confirmation."

Watch the live status updates: `✍ Writing app.py`, `⚙ pip install flask`, etc.

> "Run the app locally on port 3000 and curl /health"

Note: only ports 80, 3000, and 1024+ are exposed by Cloud Workstations
ingress. 8080 is reserved for the A2A server inside the workstation.

### 5. SSH continuity (the magic moment)
- Open the workstation in a browser (Cloud Workstations console → Launch)
- In the Code OSS terminal:
  ```bash
  a2a-sessions          # list every contextId -> sessionId mapping
  a2a-resume            # interactive resume of the most recent session
  ```
- Continue the same conversation from the workstation terminal.
- Switch back to GE → ask "what file did we just edit?" — Claude remembers.

### 6. Multi-LLM (optional)
> "@gemini explain this code"

Routes to Gemini CLI (also via Vertex AI). Same workstation, same files.

### 7. Customisation talking points
- `/home/user/.claude/CLAUDE.md` — repo / project guidance Claude reads on every turn
- `/home/user/.claude/settings.json` — set `"model": "claude-opus-4-7"` etc.
- Both editable via Code OSS UI (we run the agent as `user`, not root)

---

## Talking points (architecture deep-dive)

- **Frontend**: Gemini Enterprise (GE) handles auth, RAG, prompt safety. We're just one custom agent.
- **A2A**: GE speaks the open Agent2Agent protocol over JSON-RPC + SSE.
  Spec: <https://a2a-protocol.org/v1.0.0/specification>
- **Cloud Run router**: Stateless, pure A2A protocol shim. Identifies the user via OAuth, forwards to that user's workstation.
- **Cloud Workstations**: One per user, persistent disk, runs the same router code in "local" mode (no forwarding). Claude Agent SDK + Gemini CLI bundled in the custom image.
- **Vertex AI**: Both Claude (Anthropic) and Gemini are accessed via Vertex AI ADC — no API keys anywhere.
- **Persistence story**:
  - `~/.claude/projects/*.jsonl` — Claude SDK conversation transcripts (read by `--resume`)
  - `~/.a2a-sessions/<contextId>.json` — A2A contextId → SDK sessionId pointer
  - `~/workspace/shared/` — files Claude writes during the conversation
  - All on the per-user persistent disk; survive idle shutdowns and image refreshes.

---

## Common questions & answers

**Q: Why the per-user workstation, not just per-user namespacing on Cloud Run?**
A: Cloud Run is stateless and short-lived; conversation memory and generated files would die on instance recycle. Per-user PD gives true continuity and isolation — file Yuting writes never reaches Yuu, and vice versa.

**Q: How does GE know which user is talking?**
A: The customer registers an OAuth client on the agent. GE then forwards
the user's OAuth bearer on every request. We exchange it at
`/oauth2/v3/userinfo` for the user's email.

**Q: Cost?**
A: Workstation: ~$0.30/hour active, $0/hour stopped (e2-standard-4).
Persistent disk: ~$5/month per user (50 GB). Idle shutdown after 15 min
inactivity, max 2 h running → ~$90/month for 10 active users at 1 h/day.

**Q: Can I run Opus 4.7 instead of Sonnet?**
A: Yes. Edit `~/.claude/settings.json` in the workstation's Code OSS:
`{"model": "claude-opus-4-7"}`. The SDK reads this on the next turn.

**Q: What if the workstation is recycled mid-conversation?**
A: First turn after recycle reads the persisted sessionId pointer from
PD, replays the SDK transcript via `resume:<id>`, and Claude remembers.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Provisioning your workstation…` then 503 | First-turn race; the inner Node server hadn't bound port 8080 yet | Already mitigated (we poll /health for 90 s before forwarding). If it still happens, send the same prompt again. |
| `forward: workstation returned 404` | Router cached a deleted workstation's hostname | Already auto-recovers (one retry with fresh target). If persistent, restart the Cloud Run revision. |
| Agent "doesn't remember" earlier message in same chat | contextId changed (GE side bug, rare) OR workstation was recycled and the persisted sessionId file was wiped | Check Cloud Run logs for `[session] recovered sessionId=` on the affected turn. |
| `EACCES` editing files via Code OSS | Root-owned files from an old image | Rebuild + delete workstation; new image runs everything as `user`. |

## Live URLs

- Agent card: <<YOUR_ROUTER_URL>/.well-known/agent-card.json>
- Cloud Run logs: <https://console.cloud.google.com/run/detail/us-central1/a2a-router/logs?project=YOUR_PROJECT_ID>
- Workstations console: <https://console.cloud.google.com/workstations/list?project=YOUR_PROJECT_ID>
- GitHub: <https://github.com/yuting0624/ge-claude-a2a>
