# Codex interactive push

## Problem and scope

At base commit `f8a1e9b`, `session start --runtime codex --push` fails with
`unsupported_session_option`. The managed `codex exec` driver cannot receive input
inside an interactive session. Add a persistent app-server client, using one
native thread for console input and Hub commands, with automatic receipts.

The existing Connector and Hub already support runtime-neutral SSE channels;
neither needs a deployment or restart for this client-side adapter.

## Acceptance

- A real `thread/start` response supplies the identity; never invent a thread ID.
- `--push` starts one app-server and serializes console and Hub turns in it.
- A successful Hub receipt contains the completed turn's final answer and native
  thread ID, rather than commentary or output from another thread/turn.
- Failed/interrupted turns and process/transport failures cannot report success.
- Closing the client detaches the SSE channel and restores `waiting_manual`.
- Sandbox defaults to read-only; workspace writes require an explicit option.
  Permission requests require a local choice and are never auto-approved.
- Initialization, execution, serialization, approval and failure tests pass, along
  with the existing suite. A real CLI smoke test verifies two turns on one thread.

## Current desktop chat boundary

The current desktop chat has a trusted native `CODEX_SESSION_ID`, so it can be
registered as external. That alone does not enable push. A second app-server
resuming a live desktop thread does not share its running process and must not
be used to impersonate this chat or run simultaneous writers. The new launcher
is a separate, explicitly identified push window. Resume it only after any other
client using that thread has exited.

## Validation record (2026-10-28)

- `npm run check`: passed.
- `npm test`: 98 passed, 0 failed, 0 skipped on macOS / Node 25.8.1.
- Codex CLI 0.164.0: real `thread/start` and two serial text-only turns passed;
  both replies were `HUB_CODEX_PUSH_OK` on the same native thread.
- Isolated real Hub + Connector + Codex CLI: SSE push, accepted receipt,
  `HUB_CODEX_E2E_OK` final result, native session ID, and `delivery: channel`
  all passed. Client exit revoked push and a later command was `waiting_manual`.
  See [sanitized evidence](codex-push-evidence.json).
- Real `thread/resume` plus model generation passed on the completed end-to-end
  test thread: the same native ID returned `HUB_CODEX_E2E_OK` in 23.8 seconds.
  Two earlier attempts on the initial smoke thread timed out after 80 seconds
  (one asked for a read-only tool, the other a text-only response). They were
  interrupted and were not counted as success; the cause of those timeouts is
  unknown. Tool-executing real turns have not been accepted by this smoke test.
- The existing macOS bootstrap test now creates its own main branch and reuses
  the suite's installed ws package. This removes an assumption about the working
  branch and external package-registry availability from the lifecycle test.

No production command was dispatched and no other Worker was changed. The
existing enrolled Connector was used only to register the actual originating
Codex desktop thread as external, accurately reporting `push_capable: false`.
Production enrollment tokens and Admin Tokens were not read.

## Merge and launch

The Hub and Connector protocol is unchanged. Merge this client/Skill change,
update the CLI and installed Skill on the target Mac, then open:

```bash
agent-hub session start --runtime codex --push --cwd /path/to/project
```

Inside that window, describe its role and request `worker register-current`.
Confirm the returned native thread ID matches the window and `worker list`
reports `push_capable: true`; then dispatch a bounded command and verify its
completed receipt. The code does not automatically register new windows.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
