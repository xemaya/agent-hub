# Codex desktop push through the existing native queue

## Scope

Reuse the already-established local integration pattern from
`integrations/seo-feishu-bridge/seo_feishu_bridge.py` in the parent workspace:
`codex queue --thread <native ID> --message <instruction>`, followed by an
explicit result callback from inside that same native session.

This does not install a new App, change how the desktop starts, restart it,
spawn `codex exec resume`, connect to its protected App Tools pipe, or require
a shared app-server. The earlier shared-backend/launcher experiment has been
removed from the proposed change. It remains recoverable in Git history.

## Use inside the existing desktop chat

```bash
agent-hub worker register-current --push \\
  --data-dir "$HOME/.agent-hub/connector" \\
  --name "Codex desktop developer" --cwd "$PWD" \\
  --capabilities coding,review,analysis
```

`agent-hub desktop attach --push` is an alias. The CLI uses the native
`CODEX_SESSION_ID`, checks the actual desktop process in its ancestry, registers
the same external Worker, and starts a background SSE bridge to the already
enrolled Connector. It never picks a recent session or creates another model
session. Repeated attachment reuses a live bridge. Desktop process exit closes
the channel and revokes push capability.

Each Hub command is durably recorded before one native queue invocation. The
queued text contains the instruction, native ID, command ID, and exact callback
arguments. `codex queue` acceptance is acknowledged but is not task success.
The desktop can finish its current work before processing the queued message.

When the instruction is complete, the native session invokes:

```bash
agent-hub desktop report --command-id COMMAND_ID --status succeeded \\
  --data-dir "$HOME/.agent-hub/connector" < complete-result.txt
```

The result is read from stdin. Local authentication is loaded by the CLI and is
never put into the queued prompt. A receipt must match the current native
session's delivery record. A separate exclusive receipt marker prevents double
reporting, including uncertain HTTP outcomes. Failed work uses `--status failed`.

No native queue error, timeout, connector disconnect or duplicate record causes
automatic redelivery. Unknown outcomes remain unknown. Explicit reattachment
after a disconnect does not replay old delivery records.

## Validation (2026-10-28)

- `npm run check` and all 92 tests passed after removing the unrelated launcher
  and interactive console implementation.
- Isolated Hub/Connector tests prove a native queue call uses the exact target
  ID and does not create an exec/resume process; acceptance alone remains
  running until the in-session CLI callback completes the command.
- Tests reject another session's receipt and duplicate reports, preserve an
  unknown result after queue failure, prevent duplicate delivery, and tolerate
  a fast final callback before the queue subprocess returns.
- The actual originating desktop chat was attached without restart. Its native
  Worker was read back as external with `push_capable: true`.
- A single live current-session command/receipt probe remains to be completed
  after the current turn ends. Do not treat bridge attachment or accepted queue
  output as proof that the model received or completed it.

The existing Feishu listener was not enabled, and no Feishu message was sent.
The existing macOS bootstrap test fixture now works on a feature branch and
does not depend on an external package download; its installer also checks the
selected local Connector URL instead of accidentally consulting port 8788.
