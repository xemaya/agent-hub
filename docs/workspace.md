# 工作区（Workspace）

状态：第一版（2026-11-26）。需求见业主的《agent 编队需求》。本文讲怎么用、怎么接每台机器、内部怎么运转。

## 1. 是什么

在任意一台机器的任意一个 agent 里说「开工，做 X，要 2 个 cc、1 个反重力、1 个 codex」：

1. 这个 agent 就是**队长**，用 `agent-hub ws start` 开一个工作区，列出要的座位。
2. Hub 请对应机器的**门房**把会话拉起来。
3. 新会话的第一句话里有一张一次性**报到单**，它跑 `agent-hub ws join <报到单>` 进工作区，拿到目标、简报、队友和规矩。
4. 大家在工作区里群聊、私信、交棒，共用简报、记事本和文件区。
5. 队长收工，队员留着不关。

业主只在队长那里看和说话；Hub 网站的 `/workspaces` 页面单独显示每个工作区的团队状态、群聊、简报、记事本和文件，业主也能在那里插话或收工。

工作区和原有的 Worker / Task / Command / 邮箱 / 飞书桥是**两套东西**：成员不是 Worker，不会被中央大脑或岗位派活；原有功能一行没改。数据都在 Hub 的 SQLite 里（`ws_*` 表）。

## 2. 四台机器怎么接

给 agent 读的分步说明在 Hub 网站的 `/door`（人看）和 `/door.md`（纯文本，给 agent），源文件是 `public/door.md`。业主把「读 <Hub>/door.md，按里面的步骤给这台机器开门房」发给那台机器上的 agent 即可。

前提：每台机器已装 Agent Hub Connector（`~/.agent-hub/connector`），并且 Connector 跟 Hub 是同一个版本（Connector 会自动快进到 Hub 的提交）。然后每台机器各做一次：

```bash
agent-hub ws install-skill          # 把工作区用法装给 Claude、Codex、反重力
```

| 机器 | 门房 | 怎么开 |
|---|---|---|
| A Mac mini（Claude） | Connector 自带，`claude --bg` 起后台会话 | 在 claude 确认过信任的目录里：`agent-hub ws door enable claude` |
| B MacBook（Claude） | 同上 | 同上 |
| C MacBook（Codex + 反重力） | Codex：常驻的 Codex 桌面对话；反重力：Sidecar | Codex 对话里：`agent-hub ws door start --runtime codex`；反重力：Sidecar 跑 `agent-hub ws door start --runtime antigravity --foreground` |
| D Mac mini（Codex） | 常驻的 Codex 桌面对话 | `agent-hub ws door start --runtime codex` |

要改代码的项目，在每台机器的项目目录里登记一次：`agent-hub ws project set youxian --remote https://github.com/keman-ai/youxian.git --branch master`（反重力对话里跑会顺带记下反重力的项目编号）。

查看：`agent-hub ws doors`（所有机器）、`agent-hub ws door status`（本机）。

## 3. 用法速查

```bash
# 队长
agent-hub ws start search-v2 --title "搜索第二版" --goal "…" --project youxian \
  --seat cc-1=claude@MacBook:写代码 --seat codex-1=codex@mac-mini:测试 --seat ag-1=antigravity/pro:review
agent-hub ws brief --file brief.md
agent-hub ws status
agent-hub ws handoff --to cc-1 "先改入口，改完交给 codex-1 测"
agent-hub ws relaunch codex-1
agent-hub ws close --summary "…"

# 所有人
agent-hub ws join <报到单>
agent-hub ws say "…" [--to 座位]          # 话里 @座位 会优先叫醒对方
agent-hub ws inbox | history | notes
agent-hub ws note --kind decision "…"
agent-hub ws file put a.png --note "…" | file list | file get <编号>
agent-hub ws wait                         # Claude：用 Bash run_in_background 运行
```

座位写法：`座位=类型[/模型][@机器][:分工]`。类型是 `claude`、`codex`、`antigravity`；机器写 Connector 名的开头（`agent-hub ws doors` 里看），不写就挑当前座位最少的那台。

## 4. 收信：攒一批，只在有事时叫醒

模型从不轮询。Hub 保存每条消息，每个成员有「已读到哪」「已通知到哪」两个位置：

- 新消息到了，如果是**交棒给你、@你、私下给你、业主说的、拉起失败**，马上响门铃；
- 普通群聊先攒 `gather_ms`（默认 3 分钟，`--gather-minutes` 可改），到点一次响一下，门铃里是这段时间的消息摘要；
- 门铃响过、你还没读，再来的新消息只累加，下一次门铃带上；响过 15 分钟仍没读，再提醒一次，最多两次；
- 门铃没送到（机器离线、没人在等信），不算响过，每分钟重试，等信的会话一挂上就补送。

门铃怎么送进会话，看类型：

| 类型 | 正常路径 | 后备 |
|---|---|---|
| Claude | 会话用 Bash `run_in_background` 运行 `agent-hub ws wait`；来信时它退出并打印消息，Claude 被叫醒；处理完再后台运行一次 | 门房拉起的后台会话没在等信时：闲着就 `claude stop` 再 `claude --bg --resume <编号> "<消息>"`；已退出就直接 resume。resume 会换会话编号，所以门铃里附一张新的报到单，第一句话先让它 `ws join` 重新接上 |
| Codex | 报到时自动起一个收信桥（后台进程，在 Codex 桌面进程里起），用 `codex queue --thread <对话> --message` 送进对话 | 桥没在跑就标「叫不醒」，再 `ws join` 一次会重起 |
| 反重力 | 门房（Sidecar）用 `agentapi send-message <对话编号> <消息>` 送进对话 | 门房不在就标「叫不醒」 |

`ws wait` 带上所属 Claude 进程的 PID（`CLAUDE_PID`），Connector 送信前确认它还活着，免得会话退出后留下的孤儿进程吞掉门铃；`ws wait` 自己发现会话没了也会退出。

## 5. 门房怎么拉人

- **Claude**：Connector 跑 `claude --bg --name <工作区>-<座位> --dangerously-skip-permissions [--model …] "<第一句话>"`。目录用项目登记的目录，没有就用开门房时的目录。实测要点（2.1.332）：
  - `--bg` 只能在 claude 确认过信任的目录里起，上级目录信任过也不行，否则直接报「Workspace not trusted」。门房把这个原因告诉队长，业主到那台机器上进目录跑一次 claude 点信任，再 `ws relaunch`。
  - `--bg` 不认 `--session-id`，会话编号由报到时的 `CLAUDE_CODE_SESSION_ID` 确定。
  - 子进程的环境去掉了 `CLAUDECODE`、`CLAUDE_CODE_*`、`CODEX_*`、`ANTIGRAVITY_*`，并把 PATH 指到和 Connector 同一版本的 `agent-hub`，`AGENT_HUB_CONNECTOR_URL` 指到这台 Connector。
- **Codex**：门房对话收到一条「请新开一个独立的 Codex 对话，把下面原文作为第一句话发出」的请求（经 `codex queue`），由模型开新对话。新对话报到时用 `CODEX_SESSION_ID`。
- **反重力**：Sidecar 里的门房直接调反重力本机接口 `ConversationService/CreateConversation`（带 `projectId`、`model`），开出顶层对话（进侧栏），失败再试 `agentapi new-conversation`。这个接口要反重力注入的 `ANTIGRAVITY_LS_ADDRESS` 和 CSRF 令牌，所以门房必须在反重力托管的进程里跑。

拉起 10 分钟还没报到（或门房一直不在线），座位标「失败」并马上告诉队长。

## 6. 代码怎么汇合

每个工作区一条临时分支 `ws/<名字>`（业主 2026-11-26 同意的例外）。各人在项目目录旁开自己的 worktree（游离 HEAD）；写代码的人推 `git push origin HEAD:refs/heads/ws/<名字>`，被拒就 fetch + rebase 再推；测试、review 的人拉同一个提交。收工时队长合进个人分支，再删掉临时分支。Hub 不碰 git，这些写在报到说明里。

## 7. 内部

- 表：`ws_workspaces`、`ws_members`（座位、类型、机器、会话编号、状态、已读/已通知位置、门铃状态）、`ws_messages`（`recipients` 非空 = 私信；`mentions` = 点名或交棒对象）、`ws_notes`、`ws_files`（文件本体在 `<hub 数据目录>/workspaces/files/`，单个最大 100 MB）、`ws_projects`（每台机器的目录）、`ws_doors`。`CREATE TABLE IF NOT EXISTS` 建表，不动 Hub 的版本化 schema。
- Hub ↔ Connector：WebSocket 上的 `workspace.*` 消息（rpc、doors、listener、launch / launch.result、wake / wake.result、file.begin/chunk/end/read）。Connector 声明 `workspace_v1` 才会收到。
- Connector 本机接口：`/local/v1/workspaces/rpc`、`/listen`（等信 / 收信桥）、`/door`（门房桥）、`/result`、`/doors`、`/files`。
- 管理接口（Admin Token）：`GET /api/v1/workspaces`、`GET /api/v1/workspaces/:id`、`POST …/:id/messages`（业主插话）、`POST …/:id/close`、`GET …/:id/files/:file`、`GET /api/v1/workspace-doors`、`GET /api/v1/workspace-projects`。
- 门房配置在 Connector 数据目录的 `workspace-doors.json`；门房和收信桥的锁与日志在 `workspace-bridges/`。

## 8. 已知限制 / 待实测

- Codex：门房对话开新对话靠模型照做；新对话能不能自己跑 `ws join`、每条本地命令是否要业主点一次提权，要在 C、D 上实测。
- 反重力：Sidecar 的配置写法以反重力文档为准；`CreateConversation` 的字段是按反重力自测报告写的；正在跑的对话收到 `send-message` 是排队还是插入，没压测过。
- 业主在网页上插话默认叫醒队长；队长要自己把业主的话转给队员。
- 一个会话同时只在一个工作区；收工后才能开下一个。
