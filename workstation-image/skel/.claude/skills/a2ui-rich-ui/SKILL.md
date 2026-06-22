---
name: a2ui-rich-ui
description: Use ONLY when the current turn is being delivered through Gemini Enterprise (a chat surface that natively renders A2UI cards/forms/dashboards). NEVER use when the current turn is happening in a terminal (Code OSS, SSH, or `claude --resume` from a shell prompt) — in a terminal the raw `<a2ui-json>` tags would be shown verbatim and ruin the reply. The same conversation can move between surfaces, so check EVERY turn, not just the first one; even if previous assistant turns contained `<a2ui-json>` blocks, drop them the moment the surface switches to a terminal. Within GE, prefer A2UI when a card, form, list, status board, confirmation, or approval prompt would communicate the answer better than plain markdown; skip it for short conversational replies that don't benefit from structure.
---

# Speak UI when it helps

You normally answer in markdown. When you have something inherently
structured to show — a summary card, a confirmation, a multi-field form,
a list of items the user might pick from, a side-by-side diff summary,
a progress dashboard — emit an **A2UI** payload alongside your text.
Gemini Enterprise renders A2UI v0.8 natively as Material-style components.

The wire format is fixed by the official A2UI Python parser
(`agent_sdks/python/src/a2ui/parser/parser.py` in google/A2UI), which
extracts JSON from `<a2ui-json>...</a2ui-json>` tags via a regex. The
runtime then packages the extracted JSON into an A2A `DataPart` with
MIME `application/json+a2ui` and ships it to the GE renderer.

If you decide to render UI:

1. Keep the prose reply short — 1-2 sentences as a header. The UI carries
   the detail. Conversational text can appear before, after, or between
   `<a2ui-json>` blocks.
2. Wrap the payload in **`<a2ui-json>...</a2ui-json>`** tags (literal XML-style
   tags, NOT a markdown code fence). The runtime detects these tags via
   the regex `<a2ui-json>(.*?)</a2ui-json>` and the user never sees them.
3. The body inside the tags is a **single JSON array** of messages
   (NOT JSONL, NOT a bare object). Use the v0.8 message shape
   (`beginRendering`, `surfaceUpdate`, `dataModelUpdate`).
4. Order rules:
   - Put `beginRendering` first in the array — this lets the streaming
     parser start rendering as soon as the surface is declared.
   - Within `surfaceUpdate.components`, the root component MUST be the
     first element, and every parent MUST appear before its children.
     The streaming renderer relies on this top-down order.
5. Pick a descriptive `surfaceId` (e.g. `"build-summary"`, `"pr-review"`),
   not a generic `"main"` — surface IDs scope component state and a
   collision could overwrite an earlier surface.
6. When in doubt, reach for `Card` + `Column` first, then add `Text`,
   `Image`, `Divider`, `Button`, `TextField`, `DateTimeInput`, `List` as
   needed.

## Design Aesthetics & High-Fidelity Layouts (CRITICAL for WOW factor)

A plain markdown block or basic text list inside a card looks unpolished. You MUST use A2UI's structured component tree to create visually stunning, premium developer dashboards that WOW the user. Follow these rules:

1. **Structured Columns & Rows instead of Large Text Blocks:**
   - NEVER dump a large block of bulleted list or file trees inside a single `Text` component.
   - Instead, split them into a `Column` of `Row`s.
   - For each row, put a beautiful, meaningful `Icon` on the left (e.g., `"checkCircle"`, `"code"`, `"folder"`, `"bolt"`, `"star"`, `"playArrow"`) and a clean `Text` block on the right.
2. **Material Icons for Visual Scannability:**
   - Use curated Material icons to represent states:
     - Success/Active: `"checkCircle"` or `"check"`
     - In Progress: `"hourglassEmpty"` or `"sync"`
     - Web Link: `"openInNew"` or `"language"`
     - File/Folder: `"description"` or `"folder"`
     - Design/Style: `"palette"` or `"brush"`
     - Start/Play: `"playArrow"`
3. **Status Banners (Nested Cards):**
   - Place key status information (e.g., "Server Active on Port 8000") inside a nested, clean `Card` component to give it a distinct background container and visual hierarchy.
4. **Dividers for Section Breaks:**
   - Use the `Divider` component between the header/status, the main workspace features, and the action button row. This creates clean grid alignment.
5. **Bold & Caption Typography:**
   - Use `usageHint: "h2"` for the main card title.
   - Use bold markdown syntax (e.g., `**Feature Name**`) inside `Text` components to highlight key labels.
   - Use `usageHint: "caption"` for sub-headings like "💻 BUILD LOGS" or "🛠️ ACTIONS" to create a premium, clean dashboard look.
6. **NO FILE LISTS OR CODE TREES IN THE CARD:**
   - NEVER list generated files, file trees, folder structures, or code snippets inside the A2UI Card. It clutters the interface and reduces readability. Keep the card focused exclusively on high-level features, active status, and interactive buttons.
7. **CLEAN HYPERLINKS FOR APP & IDE URLS (NO GENERIC NAVIGATION BUTTONS):**
   - NEVER create generic button components for launching the web application, opening the Web IDE, or viewing source code. Generic buttons like "웹앱 열기" or "소스 보기" make the card look generic and cluttered.
   - Instead, display these URLs cleanly as **clickable markdown hyperlinks** inside a `Text` component (e.g., `"🔗 [🚀 웹 애플리케이션 실행하기](https://<app-url>)"` and `"💻 [Open in Web IDE](https://<workstation-host-url>)"`) near the bottom of the card.
   - This keeps the layout incredibly premium and lets the user open the app and editor via standard, native browser hyperlinks.

8. **SPECIFIC INTERACTIVE FEATURE BUTTONS ONLY (TAILORED TO USER REQUESTS):**
   - Do NOT hardcode generic navigation buttons. Instead, design a **highly customized, interactive control console** whose buttons (`Button`) and input components (`Tabs`, `Slider`, `CheckBox`, `TextField`, `MultipleChoice`) are **100% tailored to the specific business features requested by the user**.
   - **Examples of Tailored Controls:**
     - **Weather App:** A `Button` to refresh weather (`"action": "refresh_weather"` with text `"🔄 새로고침"`), `Tabs` to switch cities (`[서울]`, `[부산]`, `[제주]`), and a `CheckBox` or `MultipleChoice` to toggle display units (`Celsius / Fahrenheit`).
     - **Games (e.g., Sudoku, Tetris):** `Button`s to start or pause (`"action": "start_game"`, `"action": "pause_game"`), `Tabs` or a `MultipleChoice` dropdown for difficulty selection (`[쉬움]`, `[보통]`, `[어려움]`), and a `Slider` to adjust game speed.
     - **Slide/Doc Generator:** `Button`s to download PDF (`"action": "download_pdf"`) or change templates (`"action": "change_template"`).
   - **Interactive Bidirectional Action Loops:**
     - Make sure every interactive input and button triggers a descriptive action (e.g., `change_difficulty`, `search_city`, `toggle_setting`, `apply_theme`).
     - When the user interacts with these components in the chat, the A2A router will send the event back to you. In your next turn, you **MUST** read the selected values, immediately rewrite the application's source code (CSS, JS, Python, HTML) on the workstation to apply their choices in real-time, restart the local server, and update the A2UI card. This proves the incredible power of bidirectional Agent-to-User live integration!

## Speed & Latency Optimization (CRITICAL to Prevent Chat Gateway Timeouts)

The Gemini Enterprise A2A client has a hard HTTP gateway timeout (around 60-90 seconds). If your turn takes longer than this limit, the user's chat interface will display a connection error ("Something went wrong..."), even if your background tasks succeed on the workstation.

To guarantee that your responses always complete in **under 60-70 seconds** and never time out, while maintaining the highest professional engineering standards, you MUST strictly adhere to these rules:

1. **PROPERLY STRUCTURED APPLICATIONS (NO LAZY SINGLE-FILE CRAMMING):**
   - ALWAYS build a properly structured, clean, and professional web application (e.g., separate `index.html`, `style.css`, and `app.js` files, and clean asset folders).
   - NEVER cram everything into a single, massive HTML file just to save time or bypass a timeout; this looks unprofessional, is hard to maintain, and is completely unacceptable to the customer.

2. **CONCISE, HIGH-EFFICIENCY CODING (TO PREVENT TIMEOUTS):**
   - To keep your execution time fast, write **extremely clean, modular, and highly concise code**. Skip unnecessary, heavy boilerplate or massive mock datasets on the first turn.
   - Focus on writing the core functional code directly and efficiently. Bypassing slow, non-essential tool calls (like running deep file searches or complex tests on the first turn) keeps your execution under the 60-second limit while delivering a beautifully structured workspace.
   - Build a solid, clean, and professional MVP first, and explain to the user that they can easily add more features, complex pages, or refactor components in subsequent turns (which will run in seconds and never time out).

3. **Instant Background Server Boot:**
   - When starting the local web preview server, always use a fast, lightweight background command:
     `python3 -m http.server 8000 &`
     which boots instantly in 0.1 seconds, rather than running heavy blocking frameworks that take 10-15 seconds to initialize.



## Detecting the current surface

The runtime forces you to make this call yourself — the same persistent
session can carry over from GE chat to a terminal `claude --resume` and
back. Look at signals on the **current** turn before deciding:

**You are in Gemini Enterprise when:**
- The system prompt explicitly says you are operating inside GE.
- The user message reads like something a non-engineer would type in a
  chat ("can you add inventory display to the product page").
- You see structured task IDs / context IDs that the runtime injected.

**You are in a terminal when ANY of these is true:**
- The user's prompt looks like a CLI command or a short imperative
  ("run the tests", "fix the lint error in main.py", "ls").
- They reference local files by path or use shell-ish syntax.
- They ask for diffs, command output, or stack traces verbatim.
- The runtime did not inject GE-specific system instructions.

When you detect the terminal surface, **do not emit any `<a2ui-json>`
block** this turn, even if the previous assistant turn (sent to GE)
contained one. Reply with plain markdown / code blocks. The same logic
applies in reverse: if the user moves back to GE, you may resume A2UI
replies even though the immediately preceding turns were terminal-style
text.

## Other reasons to skip A2UI even in GE

- The reply is conversational ("yes", "got it", a one-line answer).
- You are mid-clarifying-question and the user needs to type a free-form
  reply — keep it text so they can answer fast.
- You can't fit the message in the v0.8 catalog without inventing
  components.

## Output skeleton

```
Done — see the summary below.

<a2ui-json>
[
  {"beginRendering": {"surfaceId": "build-summary", "root": "root"}},
  {"surfaceUpdate": {"surfaceId": "build-summary", "components": [
    {"id": "root", "component": {"Card": {"child": "col"}}},
    {"id": "col", "component": {"Column": {"children": {"explicitList": ["title", "body"]}}}},
    {"id": "title", "component": {"Text": {"usageHint": "h2", "text": {"literalString": "Build complete"}}}},
    {"id": "body", "component": {"Text": {"text": {"literalString": "3 files changed, 5 tests added, all passing."}}}}
  ]}}
]
</a2ui-json>
```

That single block becomes a Material card in the GE chat.

## What components exist

The standard v0.8 catalog defines **exactly 18 components**, listed below.
**Do not invent new ones** — the GE renderer will surface the placeholder
`Unknown element <Name>` for anything else (we have hit this in production
with `Markdown`, which does not exist in v0.8). If you need something not
here, fall back to `Text` + `Column`.

The full whitelist (= every component the standard catalog ships with):
`Text`, `Image`, `Icon`, `Video`, `AudioPlayer`, `Row`, `Column`, `List`,
`Card`, `Tabs`, `Divider`, `Modal`, `Button`, `CheckBox`, `TextField`,
`DateTimeInput`, `MultipleChoice`, `Slider`.

### Layout
- **Row** — horizontal box. `children: {explicitList: [...]}`, `distribution`, `alignment`
- **Column** — vertical box. Same props as Row.
- **List** — scrollable. Static `explicitList` or dynamic `template` bound to data
- **Card** — single rounded container. `child: "id"`
- **Divider** — horizontal rule. `{}` is fine. Optional `axis: "horizontal"|"vertical"`.

### Display
- **Text** — `text: {literalString} | {path: "/data/key"}`, `usageHint: h1|h2|h3|h4|h5|caption|body`. Supports **simple Markdown** inside the literal/path string (bold, italic, lists, inline code) — there is no separate `Markdown` component in v0.8, just put the markdown text inside `Text`.
- **Image** — `url: {literalString | path}`, `fit: cover|contain|fill`, `usageHint`
- **Icon** — `name: {literalString}` (Material icon name, e.g. `"calendarToday"`, `"check"`)
- **Video** — `url: {literalString | path}`
- **AudioPlayer** — `url: {literalString | path}`

### Input
- **TextField** — `label`, `text` (binding), `type: text|number|email|password|multiline`
- **CheckBox** — `label`, `value` (binding to bool)
- **DateTimeInput** — `label`, `value` (binding), `enableDate`, `enableTime`
- **Slider** — `value`, `min`, `max`, `step`
- **MultipleChoice** — `label`, `value` (binding), `options: [...]`
- **Button** — `child: "id-of-Text"`, `primary: true|false`, `action: {name, context: [{key, value: {path: "..."}}]}`

### Container
- **Modal** — overlay container
- **Tabs** — tabbed container

## Actions

Buttons can fire actions. The runtime forwards them as a follow-up user
message, then the router rewrites the message into a structured prompt
before it reaches you (so you see explicit "[A2UI action] The user
clicked X" framing rather than the raw `action:X` text).

```
{"id":"submit","component":{"Button":{
  "child":"submit-label",
  "primary":true,
  "action":{
    "name":"approve_pr",
    "context":[{"key":"prNumber","value":{"path":"/prNumber"}}]
  }
}}}
```

When the user clicks Submit, you receive an `[A2UI action]` prompt
naming the action and including its context. Carry it out and reply
with a short status line, optionally followed by a new card.

### Naming actions

- Use `snake_case` verb-first names: `approve_pr`, `cancel`,
  `delete_record`, `view_details`, `retry`, `open_file`. The router
  validates against `^[a-zA-Z_][\w-]*$`.
- Reuse standard names across cards where possible — `cancel` and
  `confirm` are the canonical pair for confirmation dialogs.
- Include any data the handler needs in `context` via `path` bindings.
  Don't rely on the model-side data store still containing values from
  earlier turns.

### Destructive actions need a confirmation card

If the action mutates state outside this conversation — deleting data,
sending a message, calling an external API, costing money — surface a
confirmation card first instead of acting on the first click.

The pattern is two cards:
1. The card that triggers the action emits a button with the
   destructive action name (e.g. `drop_database`).
2. When you receive that action, reply with a confirmation card that
   has two buttons: `cancel` (no-op) and a *new* action name like
   `confirm_drop_database` carrying the same context.
3. Only when you receive `confirm_drop_database` do you actually do
   the work.

`examples/confirmation.json` shows the second card; the destructive
flow always lives across at least two turns.

## Data binding

Every text/image/value field accepts either:

- `{"literalString": "Hi"}` — hard-coded
- `{"path": "/some/key"}` — pulled from the data model

Push data with `dataModelUpdate` (placed in the same JSON array, after
`surfaceUpdate`):

```
{"dataModelUpdate":{"surfaceId":"build-summary","path":"/","contents":[
  {"key":"title","valueString":"Build complete"},
  {"key":"changes","valueNumber":3}
]}}
```

This lets you update a value (e.g. progress %) by emitting a follow-up
`<a2ui-json>` block with just the `dataModelUpdate`, without re-emitting
the whole tree.

## Patterns to copy

The `examples/` directory next to this file contains ready-to-tweak
JSON arrays for the most common shapes. Wrap each in `<a2ui-json>...</a2ui-json>`
when emitting.

- `examples/build-summary.json` — completion card with file count + test count
- `examples/confirmation.json` — destructive-op confirmation with cancel/confirm
- `examples/clarifying-form.json` — multi-field form when you need more info
- `examples/pr-list.json` — list of PRs with action buttons
- `examples/progress-dashboard.json` — multi-step pipeline status
- `examples/ultimate-dashboard.json` — The ultimate developer workspace dashboard. Renders real-time terminal logs, status updates, and interactive action buttons like `apply_theme` (with theme context) and `launch_app` to customize the created webapp on the workstation in real-time.

Steal the structure and rewrite the literal strings for your case.

## Interactive Web App Styling & Themes

When you create a web application and provide the `ultimate-dashboard` card, the user can click theme buttons which fire the `apply_theme` action.
When you receive the `[A2UI action] apply_theme` prompt:
1. Locate the CSS file or theme styling configuration of the web application in your workspace.
2. Edit the CSS variables or colors to match the requested theme:
   - `dark`: Sleek deep grays, rich black backgrounds, white text, and clean slate borders.
   - `glass`: Transparent HSL backgrounds with a frosted glass backdrop filter (`backdrop-filter: blur(10px)`), blur effect, and subtle white border highlighting.
   - `neon`: Electric dark backgrounds with vibrant neon cyan/magenta borders, box-shadow glows, and neon typography accents.
3. Apply the changes immediately to the file.
4. Return a `dataModelUpdate` message updating `/terminal_logs` to show the theme rebuild console output, and `/app_status` to show the new theme status.
5. Provide a short conversational reply confirming the theme has been successfully applied and asking the user to refresh their preview tab!

## Hard rules

- Wrap the payload in **`<a2ui-json>...</a2ui-json>`** XML-style tags. NOT
  a ```` ```a2ui ```` fence — the official parser regex looks for the tags.
- The body is a **single JSON array** `[...]` of messages. NOT JSONL, NOT
  a bare object.
- Put `beginRendering` first in the array. Within `components`, the root
  component must be first and parents must precede their children.
- All component IDs must be unique within the surface.
- Components reference children by ID, not by nesting. Flat list only.
- Use a descriptive `surfaceId`, not `"main"`, to avoid collisions.
- If the runtime is not GE (e.g. terminal), DO NOT emit the tags — they
  would be shown verbatim and ruin the reply.

## References

- Official A2UI repo: https://github.com/google/A2UI
- v0.8 sample payloads: `samples/agent/adk/gemini_enterprise/cloud_run/examples/0.8/`
- Wire-format constants: `agent_sdks/python/src/a2ui/schema/constants.py`
- GE component reference: https://docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents/a2ui-component-gallery-reference
