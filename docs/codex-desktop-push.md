# Codex desktop push: plan and acceptance

## Observed boundary

The installed desktop app uses a private stdio app-server. Its App Tools pipe
rejects an ordinary Node client with `missing-code-signing-identity` (observed
2026-10-28). Do not bypass that peer authorization or resume the thread in a
second runtime. The existing local daemon reports this desktop thread as
`notLoaded`, so it is not an attachment target.

The installed desktop source supports `CODEX_APP_SERVER_WS_URL` when selecting
its local app-server transport. Use that client setting to put the desktop and
the Hub bridge on one explicit loopback app-server. This requires a desktop
restart; never quit the user's running app automatically.

## Implemented flow

1. Provide a loopback app-server launcher and a reviewable desktop launch command.
   The user continues working in the desktop UI, without an interactive console.
2. From a desktop chat, attach its trusted native `CODEX_SESSION_ID` to that same
   shared server. Refuse missing identities and threads not already loaded there.
3. Reuse Hub/Connector SSE push. Queue commands behind current desktop work,
   correlate each command with its own native queued submission/turn, and return
   only that turn's final answer.
4. Leave model, permissions and approvals with the desktop. The bridge must not
   auto-approve, interrupt unrelated user work, or create/resume another runtime.
5. Disconnect/restart must revoke push capability. Never replay a command whose
   native outcome is unknown.

## Acceptance

- Tests cover native identity, wrong/unloaded thread refusal, loopback endpoints,
  command/turn attribution, user work interleaving, failure and connection loss.
- Existing tests remain green.
- Real shared app-server smoke proves queuing, final result and disconnect.
- Real desktop UI test proves a message is visible in the intended desktop chat
  and its result is returned to Hub. A console-only smoke does not count.
- The originating desktop chat remains external without push until it has
  actually connected to the shared runtime; show any remaining migration step.

## Desktop entry point

After updating the CLI/Skill, generate a new desktop launcher (refuses to overwrite
an existing app):

```bash
agent-hub desktop install-launcher \
  --data-dir "$HOME/.agent-hub/connector" \
  --output "$HOME/Applications/Codex Hub.app"
```

Double-click **Codex Hub** to open the actual installed desktop App on its shared
backend. No interactive terminal UI is opened. If the ordinary desktop is
already running, the launcher refuses to change or quit it. Finish current work
and fully quit it before the first switch. Use this launcher after future quits
as well; the normal Dock launch does not persist the WebSocket environment.
The actual desktop can remain in the Dock and be used normally while running.

The lower-level `desktop start-server` prints a reviewable one-shot `open`
command but does not launch or restart the desktop. It binds only an explicit
loopback address. The background backend persists independently; it is not
installed as a launchd service by this change.

Inside the target desktop chat, execute:

```bash
agent-hub desktop attach --push \
  --data-dir "$HOME/.agent-hub/connector" \
  --name "Codex desktop developer" --cwd "$PWD" \
  --capabilities coding,review,analysis
```

This reads the native `CODEX_SESSION_ID`, verifies the exact thread is already
loaded in the shared backend, registers external, and starts a detached bridge.
Its local token is loaded internally and is not passed as a command argument.
The bridge tracks the actual desktop process PID; App exit or transport loss
revokes push. With multiple desktop instances, it requires an explicitly verified
`--desktop-pid`; it does not select a recent session or an arbitrary instance.
Closing one window is not the same as quitting the App.

The bridge does not answer native interactive requests. If the runtime routes an
approval to it instead of the desktop, it disconnects and leaves an unknown
outcome. Approval routing still needs desktop UI acceptance; read-only shell
execution has passed. It also disconnects when a user steers a Hub turn, so a
mixed response is not misattributed to the Hub command. No unknown command is
replayed.

## Validation record (2026-10-28)

- `npm run check`: passed. Full suite: 111 passed, 0 failed, 0 skipped.
- Real shared Codex 0.164.0: queued text completed on the expected native thread
  with `HUB_DESKTOP_SHARED_OK`.
- Isolated Hub/Connector → detached desktop bridge → real shared Codex returned
  `HUB_DESKTOP_BACKGROUND_OK`, accepted receipt, native session ID and
  `delivery: channel`. Stopping the bridge made the next command `waiting_manual`.
- A separate real command executed exactly `printf HUB_DESKTOP_TOOL_OK`; the
  native custom tool call and its output were observed, followed by the correct
  final receipt. This is stronger than a text-only marker echo.
- An isolated actual desktop App instance connected to the shared backend using
  WebSocket; its own logs show a successful local initialize handshake. It used
  separate profile directories. Both that instance and the temporary backend
  were stopped after testing; the primary desktop was preserved.
- The generated `.app` has a valid plist and executable shell entry point.
  Tests cover refusal to overwrite it or restart an unrelated desktop, launch
  configuration, and push revocation when the tracked desktop PID exits.
- The real desktop window's message rendering was **not** visually verified:
  Computer Use explicitly rejected `com.openai.codex`. No alternate UI
  automation or App Tools peer-authorization bypass was used.
- The existing bootstrap's final local installer call now receives its selected
  Connector URL. Its test previously checked the real port 8788 instead of its
  isolated port, which made the result depend on production connectivity.

See [sanitized evidence](codex-desktop-push-evidence.json). Real execution samples
cover queue and receipt behavior; process-lifecycle coverage is automated.
No production task was dispatched and the originating desktop chat remains
external with push disabled.

## Remaining acceptance and migration

The originating desktop still uses its private stdio runtime. It must be safely
closed and reopened through **Codex Hub**, and the same actual desktop chat must
run `desktop attach --push`. Confirm `push_capable: true`, deliver a bounded
command, check its visibility in that chat, and verify the completed Hub receipt.
Those steps are pending; protocol tests and the isolated App handshake do not
mean this live chat has been migrated.

This change does not force-quit the desktop, alter native approval policies,
change an admin/coordinator, or modify the installed App. The desktop environment
variable is a version-dependent client interface found in the installed source;
keep this feature experimental until target-machine acceptance is complete.
