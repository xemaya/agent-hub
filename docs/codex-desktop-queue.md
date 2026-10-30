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
agent-hub worker register-current --push \
  --data-dir "$HOME/.agent-hub/connector" \
  --name "Codex desktop developer" --cwd "$PWD" \
  --capabilities coding,review,analysis
```

`agent-hub desktop attach --push` is an alias. The CLI uses the native
`CODEX_SESSION_ID`, checks the actual desktop process in its ancestry, registers
the same external Worker, and starts a background SSE bridge to the already
enrolled Connector. It never picks a recent session or creates another model
session. Repeated attachment reuses a live bridge. Desktop process exit closes
the channel and revokes push capability.

The Skill provides the procedure but cannot bypass desktop permissions. Use
Codex's native elevated-permission mechanism directly for each registration,
list, or receipt command instead of deliberately triggering a sandbox error
first. Do not use sudo, change the global sandbox, or fall back to a terminal or
background Worker. `spawn EPERM` and `fetch failed` do not by themselves prove
that an earlier registration or receipt failed.

Save the registration response's `worker_id` and verify its online,
push-capable, ready-bridge state before running `worker list` with the same
Connector data directory. If that separate list command fails, report its exact
error without claiming that registration failed or registering again. When a
receipt outcome is uncertain, check the Hub's command state rather than
reporting or delivering the work twice.

Each Hub command is durably recorded before one native queue invocation. The
queued text contains the instruction, native ID, command ID, and exact callback
arguments. `codex queue` acceptance is acknowledged but is not task success.
The desktop can finish its current work before processing the queued message.

When the instruction is complete, the native session invokes:

```bash
agent-hub desktop report --command-id COMMAND_ID --status succeeded \
  --data-dir "$HOME/.agent-hub/connector" < complete-result.txt
```

The result is read from stdin. Local authentication is loaded by the CLI and is
never put into the queued prompt. A receipt must match the current native
session's delivery record. A separate exclusive receipt marker prevents double
reporting, including uncertain HTTP outcomes. Failed work uses `--status failed`.

No native queue error, timeout, connector disconnect or duplicate record causes
automatic redelivery. Unknown outcomes remain unknown. Explicit reattachment
after a disconnect does not replay old delivery records.

### Connector restart and registration refresh (2026-10-29)

The queue bridge now reconnects its SSE transport after a Connector restart,
clean stream end, or transient connection failure. It keeps the same native
session and command delivery records. An accepted native queue invocation is
not repeated if only its acknowledgement connection failed. A queue invocation
whose acceptance is unknown still stops the bridge rather than retrying work;
authentication rejection and an explicitly rejected Worker are also terminal.
Desktop exit cancels an outstanding reconnect delay.

Re-registering or renaming a live Worker now preserves its confirmed Hub channel
flag. New or restored retired Workers still start without a push flag until
their real channel attaches. This avoids clearing capability during a metadata
update without inventing a connection.

Validation: `npm run check` and all 102 tests passed. Restart tests check both
the local Connector view and actual isolated Hub state, keep the interrupted
command failed with an unknown outcome, verify no second native queue call, and
successfully complete a new command after reconnect. Separate tests cover
renaming, retired-worker restoration, acknowledgement connection failure, and
authentication rejection.

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
- The single live probe `cmd_47fddba7be534e89a0d4f55af2279bfc` arrived as a
  user message in the existing desktop chat. Before reporting, the receiving
  process verified its native `CODEX_SESSION_ID`. Its one in-session CLI report
  returned `{ "ok": true }`.
- The original local command waiter then returned `status: succeeded`,
  `result.text: HUB_CODEX_NATIVE_QUEUE_OK`, the same native session ID, and
  `delivery: channel`; `outcome_unknown` was false. This verifies receipt and
  completion in the actual existing desktop session, beyond queue acceptance.
- No App restart, new App, second model session or second probe was used for
  this live acceptance. See [sanitized evidence](codex-desktop-queue-evidence.json).

The existing Feishu listener was not enabled, and no Feishu message was sent.
The existing macOS bootstrap test fixture now works on a feature branch and
does not depend on an external package download; its installer also checks the
selected local Connector URL instead of accidentally consulting port 8788.
