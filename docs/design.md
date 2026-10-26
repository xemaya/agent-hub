# Agent Hub 设计文档

状态：MVP 设计基线
适用阶段：本机中控、本机 Worker，后续接入其他 Mac

## 1. 背景与目标

多台 Mac 上同时运行 Claude Code、Kimi Code、Codex 等 Agent。一个 Claude 可以打开多个 Session，每个 Session 做不同工作，因此协作身份必须是 Session 对应的 Worker，而不是某台机器或某个 Agent 产品。

Agent Hub 解决四个问题：

1. Worker 自己注册，中控能看到其能力、状态和当前任务。
2. 任务、上下文、产物和交接记录有统一位置。
3. 其他 Worker 或人可以向可触达 Worker 主动发送命令，不依赖 Agent 定时轮询。
4. 命令、状态变化和执行结果可追踪，断线后能够恢复。

Agent Hub 不是新的 Agent Runtime，也不替代 Git、终端或各 Agent 客户端。

## 2. MVP 范围

### 2.1 包含

- 本机运行一个 Hub。
- 每台 Mac 运行一个 Connector；本次只启动本机 Connector。
- Worker 通过所在机器的 Connector 自注册。
- Workers、Connectors、Tasks、Commands、Events 的持久化和展示。
- Connector 与 Hub 之间使用出站 WebSocket 推送命令。
- 命令持久化、ACK、重连重放、重复命令去重、每 Worker 串行执行。
- Claude、Kimi、Codex 托管 Worker 的实际触发适配器。
- 外部 Session 的登记和人工协作模式。
- 一个无构建步骤的 Web 中控页面和通用 CLI。
- 默认回环地址运行；后续可绑定本机 Tailscale IP，让其他 Mac 注册。

### 2.2 暂不包含

- Agent 自由群聊、自动拆任务和智能调度。
- 多 Hub、多主写入、分布式锁和消息队列集群。
- 双向文件同步、自动解决 Git 冲突、向量数据库。
- 直接控制任意已经打开的交互式 TUI。
- Claude Channel、MCP 工具服务和 Codex 桌面端自动化的首版适配。
- Tailscale/Headscale 的安装、启动或配置变更。
- 公网开放、Tailscale Funnel、多租户和细粒度用户权限。

## 3. 核心概念

| 概念 | 含义 | 身份边界 |
| --- | --- | --- |
| Host | 一台 Mac 或服务器 | 物理/虚拟机器 |
| Connector | 每台机器上的唯一本地连接器 | 一个机器节点一个实例 |
| Worker | 一个独立的数字员工 | 一个 Agent Session |
| Runtime | Claude、Kimi、Codex 等客户端类型 | Worker 的实现方式，不是身份 |
| Task | 有目标、上下文和完成标准的工作 | 跨 Worker 的协作主线 |
| Command | 发给 Worker 的一次具体触发 | 有唯一 ID 的执行请求 |
| Event | 注册、状态变化、ACK、交接等事实 | 追加式审计记录 |

一个 Host 可以有多个 Worker；一个 Worker 同一时间最多有一个主任务；一个任务同一时间只有一个主负责人。

### 3.1 Worker 模式

Worker 必须明确区分交付能力。

**managed**

- Connector 能主动触发 Runtime。
- `push_capable=true`。
- Claude 通过创建/恢复 Session 的非交互进程执行。
- Kimi 通过本机 Kimi Server API 创建 Session、提交 Prompt。
- Codex 通过 `codex exec` 创建/恢复线程的非交互进程执行。
- 命令通过 WebSocket 推送，Worker 不轮询 Hub。

**external**

- 已经存在的 Session 或人工操作的客户端登记到 Hub。
- 首版 `push_capable=false`。
- 可以分配任务、记录上下文和状态，但命令显示为 `waiting_manual`，不能伪装成已主动送达。
- 已有交互式客户端后续可通过专用桥接升级为可推送模式。

### 3.2 状态维度

Worker 的连接状态和工作状态分开：

```text
presence:   online | offline
work_state: idle | working | waiting | blocked
```

- `presence` 主要由 Connector 的 WebSocket 连接推导。
- `work_state` 由 Worker/Connector 的状态事件更新。
- Connector 离线时，其 Worker 全部显示离线，但不删除 Worker，也不自动把任务标记完成。
- 最后活跃时间用于展示，不作为唯一的任务锁依据。

## 4. 总体架构

```text
                           Admin Token
                    ┌─────────────────────┐
                    │                     │
              Web Dashboard          Admin CLI
                    │                     │
                    └──────────┬──────────┘
                               │ REST + Dashboard WebSocket
┌──────────────────────────────▼───────────────────────────────┐
│ Agent Hub（本机）                                            │
│ HTTP API · WebSocket · SQLite · Durable Command Outbox      │
└──────────────────────────────▲───────────────────────────────┘
                               │ 出站 Connector WebSocket
                               │ 命令下行 / 状态上行
                    ┌──────────┴──────────┐
                    │                     │
              本机 Connector          其他 Mac Connector
                    │                     │ 后续接入
        ┌───────────┼───────────┐         │
        │           │           │         │
   Claude Driver  Kimi Driver  Manual     │
        │           │           │         │
   Claude CLI    kimi web     外部 Session │
                     │                     │
                Kimi Sessions              │
```

网络原则：

- Connector 主动连接 Hub，Worker Mac 不开放入站端口。
- Hub 默认监听 `127.0.0.1:8787`。
- Connector 本地 API 默认只监听 `127.0.0.1:8788`。
- Kimi API 只监听回环地址，令牌不写入日志。
- 后续 Hub 绑定 Tailscale IP 后，其他 Connector 仍只需出站连接 Hub。

## 5. 自注册与身份

### 5.1 Connector 注册

首次启动 Connector 时提供 Hub URL、机器名称和 Enrollment Token：

1. Connector 调用 `POST /api/v1/connectors/enroll`。
2. Hub 返回 `connector_id` 和独立 Connector Token。
3. Connector 将凭证保存到本地数据目录，权限为 0600。
4. Connector 使用 Token 建立 WebSocket；后续启动无需 Enrollment Token。
5. Hub 只保存 Connector Token 的哈希。

Connector Token 可单独吊销，不等于 Admin Token。

### 5.2 Worker 自注册

Session、启动器或用户通过本地 CLI 调用 Connector，而不是直接在 Hub 手工建档：

```text
Local CLI/Session
  → Connector Local API
  → Connector WebSocket worker.register
  → Hub 返回 worker_id
  → Connector 持久化 worker_id 与 runtime_session_id 的映射
```

注册参数：

```json
{
  "name": "backend-claude-01",
  "runtime": "claude",
  "mode": "managed",
  "runtime_session_id": "可选；managed Claude 缺省时生成",
  "capabilities": ["backend", "testing"],
  "cwd": "/path/to/project",
  "metadata": {}
}
```

约束：

- 同一个 Connector 内，`runtime + runtime_session_id` 的注册必须幂等。
- 新 Session 默认注册新 Worker；恢复同一个 Session 时复用 Worker。
- Worker ID 由 Hub 生成，不复用、不随显示名变化。
- Connector 保存映射，Hub 不读取各 Runtime 的私有 Session 文件。
- 本地 API 要求 Local Token；CLI 从 Connector 数据目录读取，避免把令牌放进命令行。

## 6. 任务与命令模型

### 6.1 Task

```json
{
  "task_id": "task_...",
  "title": "增加收藏刷新",
  "goal": "为什么做、要做到什么",
  "context": "已确认结论、相关 commit、注意事项",
  "acceptance": ["测试通过", "失败状态可见"],
  "assignee_worker_id": "worker_...",
  "status": "ready",
  "created_by": "admin",
  "created_at": "...",
  "updated_at": "..."
}
```

任务状态：

```text
ready → in_progress → review → done
   │          │
   │          └→ blocked
   └→ cancelled
```

允许人工修正状态。交接是“修改负责人 + 给新负责人发送 handoff Command”，不是另建一套聊天。

### 6.2 Command

```json
{
  "command_id": "cmd_...",
  "task_id": "task_...",
  "worker_id": "worker_...",
  "kind": "prompt",
  "input": "请读取 TASK 上下文并完成下一步",
  "status": "queued",
  "created_at": "...",
  "accepted_at": null,
  "started_at": null,
  "finished_at": null,
  "result": null,
  "error": null
}
```

首版 `kind`：

- `prompt`：普通任务指令。
- `handoff`：携带交接上下文的任务指令。
- `review_request`：请求 review。
- `status_request`：要求 Worker 汇报当前状态。

Command 状态：

```text
queued → accepted → running → succeeded
                         └────→ failed

external Worker: queued → waiting_manual
```

- `accepted`：Connector 已把命令持久化到本地队列，不只是收到网络包。
- `running`：Runtime 已开始执行。
- `succeeded`：Runtime 正常结束并返回结果，不等于业务验收自动通过。
- `failed`：执行失败或结果未知，保留错误。
- `waiting_manual`：首版没有主动交付通道，需要人工处理。

### 6.3 输出与结果

- 状态变化写入 Event。
- 增量输出写入 Command 的输出字段并实时广播，不为每个 token 写一条 Event。
- 输出总量设置上限；达到上限后保留尾部并标记 truncated。
- 最终结果与错误单独保存，避免只能翻完整终端日志。

## 7. WebSocket 协议

消息统一为 JSON：

```json
{
  "type": "command.dispatch",
  "id": "消息ID",
  "ts": "ISO-8601",
  "payload": {}
}
```

### 7.1 Connector 通道

地址：`/ws/connector`

首条消息必须认证：

```text
connector.hello { token }
→ connector.ready { connector_id }
```

认证前不接受其他消息，认证失败立即关闭。令牌不放在 URL 查询参数中。

主要消息：

```text
Connector → Hub:
  worker.register
  worker.status
  task.create
  task.update
  command.create
  command.ack
  command.started
  command.output
  command.finished
  command.sync

Hub → Connector:
  worker.registered
  task.created
  task.updated
  command.created
  command.dispatch
  error
```

Connector 的 `task.create` / `command.create` 只能使用属于该 Connector 的 Worker；`task.update` 只能修改分配给该 Connector 的任务状态，且只接受状态字段。Hub 在服务端再次校验归属，不能仅靠本地 API 限制防止越权。

### 7.2 Dashboard 通道

地址：`/ws/dashboard`

首条消息使用 Admin Token 认证。Hub 只向 Dashboard 广播展示事件，不授予 Connector 执行权限。

Dashboard 的新增、修改操作仍使用带 `Authorization: Bearer` 的 REST API。

### 7.3 推送而不是轮询

- 新命令产生时，如果目标 Connector 在线，Hub 立即发送 `command.dispatch`。
- 如果离线，命令保留在 SQLite outbox。
- Connector 重连认证成功后，Hub 主动重放未确认命令。
- Connector 断线重连使用定时退避，这只是连接恢复，不是定时查询收件箱。
- WebSocket ping/pong 仅用于连接健康，不承担业务查询。

## 8. 可靠性与一致性

### 8.1 投递语义

采用 **at-least-once 网络投递 + command_id 去重**，不宣称端到端 exactly-once。

- Hub 在未收到 `accepted` 前可以重复发送同一 Command。
- Connector 在本地持久化 `command_id` 后才回复 `accepted`。
- Connector 收到重复 dispatch 时返回已有状态，不重复执行。
- `finished` 丢失时，Connector 重连后通过 `command.sync` 重发最终状态。
- 每个 Worker 的命令严格串行，避免同一 Session 并发 Prompt。

### 8.2 崩溃处理

- 已 accepted 但尚未 running 的命令，Connector 重启后可继续排队。
- 崩溃前已经 running 的命令标记为 `failed`，并注明 `outcome_unknown=true`，不自动重跑可能已有副作用的工作。
- Hub 或 Connector 离线不删除 Task/Worker。
- 所有时间使用 UTC ISO-8601；数据库关联使用稳定 ID。

## 9. 持久化设计

Hub 使用 SQLite，JSON 字段以 TEXT 保存。

### connectors

```text
connector_id PK, name, hostname, token_hash, online,
connected_at, last_seen_at, created_at, revoked_at
```

### workers

```text
worker_id PK, connector_id FK, name, runtime, mode,
runtime_session_id, capabilities_json, cwd, metadata_json,
push_capable, work_state, current_task_id,
created_at, updated_at, last_seen_at,
UNIQUE(connector_id, runtime, runtime_session_id)
```

### tasks

```text
task_id PK, title, goal, context, acceptance_json,
assignee_worker_id, status, created_by, created_at, updated_at
```

### commands

```text
command_id PK, task_id, worker_id, kind, input,
status, output_text, output_truncated, result_json, error_json,
outcome_unknown, created_at, accepted_at, started_at, finished_at
```

### events

```text
event_id PK, event_type, actor_type, actor_id,
connector_id, worker_id, task_id, command_id,
payload_json, created_at
```

Connector 使用本地 JSON 状态文件和原子重命名保存：

- Connector ID/Token、Local Token。
- Worker 映射和 Driver 状态。
- 已接受 Command 及执行状态。

MVP 数据量较小，不做 ORM、迁移框架或外部数据库。

## 10. Runtime 适配器

### 10.1 Claude managed

- 注册时生成稳定 UUID 作为 `runtime_session_id`，记录是否已执行过首轮。
- 首轮在命令事件到达时启动 `claude -p`，使用 `--session-id <uuid>`。
- 后续使用 `claude -p --resume <uuid>` 恢复同一 Session。
- 使用 `--output-format stream-json --verbose` 解析状态、Session ID 和结果。
- 使用 `--permission-prompts none`，避免无人值守时永久等待权限问题。
- 不使用 `--dangerously-skip-permissions`，不默认放开额外工具权限。
- 同一 Worker 的进程串行运行；进程退出后保存最终状态。

这属于“事件到达后创建/恢复 Session”，不是向任意已打开 TUI 注入消息。

### 10.2 Kimi managed

- Connector 首次需要 Kimi Driver 时启动专用 `kimi web --no-open --host 127.0.0.1`。
- 从启动输出取得实际监听地址和令牌；端口被占用时允许 Kimi 顺延端口。
- 通过 REST 创建 Session，保存返回的 `runtime_session_id`。
- 通过本机 WebSocket 订阅 Session 事件并等待订阅 ACK，再提交 Prompt。
- 将 `turn.started`、工具事件、`turn.ended` 等映射为 Command 状态与输出。
- Worker `metadata.kimi_model` 可为 Prompt 显式指定模型；也可用 Connector 的 `AGENT_HUB_KIMI_MODEL` 作为默认值。Kimi 配置没有默认模型时必须设置其中一种，否则会返回 `Model not set`。
- Worker `metadata.kimi_permission_mode` 可显式选择 `manual` / `yolo` / `auto`，`metadata.kimi_disabled_tools` 可限制工具；默认沿用本机 Kimi 配置，不擅自放开权限。
- Connector 退出时关闭自己启动的 Kimi Server。
- Kimi REST/WebSocket API 当前为实验性，以运行版本的 `/openapi.json`、`/asyncapi.json` 为准。
- 令牌仅保存在内存，不写日志、不发送给其他机器。

### 10.3 Codex managed

- 注册时生成稳定 UUID 作为 Worker 的 `runtime_session_id` 注册标识。Codex 不支持预先指定原生线程 ID，首次执行后从 `thread.started` 读取 `thread_id`，保存到 Connector 的 `driver_state.session_id`。Worker 注册 ID 不随原生线程 ID 改写，显式登记已有线程时两者相同。
- 首轮在命令事件到达时启动 `codex exec --json`；后续使用 `codex exec resume <driver_state.session_id> --json` 恢复同一线程，绝不使用 `--last` 选择最近会话。
- 解析 `agent_message`、错误事件和进程退出状态，将最终文本与原生线程 ID 保存到 Command 结果。
- 默认使用 `read-only` 沙箱；Worker `metadata.codex_sandbox` 可显式选择 `workspace-write`，不支持 `danger-full-access` 或绕过审批与沙箱的选项。
- Worker `metadata.codex_model` 可显式指定模型；也可用 Connector 的 `AGENT_HUB_CODEX_MODEL` 设置默认值。缺省时沿用本机 Codex 配置。
- 同一 Worker 的进程串行运行；Connector 退出时关闭自己创建的 Codex 子进程。

这属于“事件到达后创建/恢复 Codex 线程”，不是控制 Codex 桌面端或向已打开的 TUI 注入消息。

### 10.4 Test Driver

- 仅在显式测试开关下启用。
- 用于可控地验证推送、串行、断线和重放，不代表真实 Agent 验证。

## 11. HTTP API

### 公共

```text
GET /healthz
```

### Enrollment

```text
POST /api/v1/connectors/enroll
Authorization: Bearer <enrollment-token>
```

### Admin REST

```text
GET    /api/v1/connectors
GET    /api/v1/workers
GET    /api/v1/workers/:id
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id
GET    /api/v1/commands
POST   /api/v1/commands
GET    /api/v1/commands/:id
GET    /api/v1/events
```

`POST /api/v1/commands` 至少包含 `worker_id` 和 `input`，可关联 `task_id`、`kind`。创建 Task 时可以同时指定负责人。

### Connector Local REST

```text
GET   /local/v1/health
GET   /local/v1/workers
POST  /local/v1/workers/register
POST  /local/v1/workers/:id/status
POST  /local/v1/tasks
PATCH /local/v1/tasks/:id
POST  /local/v1/commands
Authorization: Bearer <local-token>
```

Local REST 只绑定回环地址，并校验 Host/Origin，不开放给 Tailscale 或局域网。Local Token 只允许创建任务、向当前 Connector 的 Worker 派发命令、更新分配给当前 Connector 的任务状态；Hub 在 WebSocket 请求中再次校验归属。

`POST /local/v1/commands` 接受 `wait: true`。Connector 注册一次性等待器，由命令完成事件直接返回最终 Command，不轮询；external 的 `waiting_manual` 立即返回。默认最长等待 10 分钟，超时返回当前 Command 和 `wait_timed_out: true`，不取消执行，也不把超时伪装成成功或失败。Connector 关闭时清理所有等待器。

## 12. CLI 与页面

### CLI

```bash
agent-hub hub --host 127.0.0.1 --port 8787 --data-dir .runtime/hub

agent-hub connector \
  --hub-url http://127.0.0.1:8787 \
  --name mac-local \
  --data-dir .runtime/connector \
  --enroll-token <token>

agent-hub worker register \
  --runtime claude --mode managed \
  --name backend-01 --cwd /path/to/project

agent-hub worker register \
  --runtime kimi --mode managed \
  --name kimi-01 --cwd /path/to/project \
  --metadata '{"kimi_model":"kimi-code/kimi-for-coding"}'

agent-hub worker register \
  --runtime codex --mode managed \
  --name codex-01 --cwd /path/to/project

agent-hub task create \
  --title "完成接口 review" \
  --goal "确认实现满足任务标准" \
  --worker-id worker_...

agent-hub send \
  --worker-id worker_... \
  --task-id task_... \
  --prompt "请开始 review 并汇报结果"

# Agent 通过本机 Connector 创建任务，不需要 Admin Token
agent-hub task create --local \
  --title "完成接口 review" \
  --goal "确认实现满足任务标准" \
  --acceptance "测试通过\n结果可见" \
  --worker-id worker_...

agent-hub send --local --wait \
  --worker-id worker_... \
  --task-id task_... \
  --prompt "请开始 review 并汇报结果"

agent-hub task update --local task_... --status done

agent-hub list workers
agent-hub list tasks
agent-hub list commands
```

Admin CLI 从 `AGENT_HUB_URL` 和 `AGENT_HUB_ADMIN_TOKEN` 获取 Hub 地址与凭证；Worker CLI 和 `--local` 任务/命令操作从本地 Connector 数据目录获取 Local Token。`--wait` 只能与 `--local` 一起使用，由完成事件唤醒，默认最长等待 10 分钟；`waiting_manual` 和 `wait_timed_out` 都不是成功。`task update --local` 只允许修改状态，且任务必须分配给当前 Connector。Kimi 的默认模型也可在启动 Connector 前通过 `AGENT_HUB_KIMI_MODEL` 设置，Worker 的 `metadata.kimi_model` 优先于该全局默认值。

### Agent Skill（本机配套）

`skills/agent-hub/SKILL.md` 为 Agent 提供按需加载的注册、自描述、状态回报和任务处理流程。Kimi 与 Codex 共享 `~/.agents/skills`，Claude 使用 `~/.claude/skills`。本机安装器只创建链接，不复制凭证，也不覆盖已有文件：

```bash
node scripts/install-local.js --connector-data-dir .runtime/connector
```

安装器将 `agent-hub` CLI 链接到 `~/.local/bin`，并把当前 Connector 数据目录链接到 `~/.agent-hub/connector`。Agent 通过 CLI 使用 Local Token，不直接读取或打印凭证。安装前会检查本机 Connector 已连接到 Hub，已有冲突路径会停止安装。

显式调用方式：Kimi 在新 Session 中使用 `/skill:agent-hub`，Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。Claude 和 Codex 支持运行中发现 Skill 变更；未出现时重新打开 Session。Skill 不是常驻进程，启动即自动注册需要另配启动指令或 hook，不能覆盖已有 Orca hooks。

Skill 明确区分两种注册：普通“接入 Agent Hub”“注册本机 Agent”默认新建 managed Worker，不要求原生 Session ID，不走 external；Kimi 在注册时由 Connector 创建新 Session，Claude/Codex 在首条命令到达时创建或恢复 Session。只有用户明确要求登记“当前这个已有会话/窗口”时才使用 external，并要求真实原生 Session ID，命令为 `waiting_manual`；无法确认 ID 时不得随机生成或选择最近会话。managed Worker 可接收推送，但不代表发起注册的当前交互窗口。Worker 的能力标签与 `metadata.description` 必须如实填写。

用户可以直接说“添加任务”或“添加并执行”。Agent 从自然语言整理任务字段，按本机 Worker 的自描述与状态选择负责人；只说添加时默认不执行，明确要求执行后才使用 `send --local --wait`。Agent 根据真实回执逐条核对验收，满足后才能更新为 `done`；失败、人工等待和等待超时都不能冒充成功。网页表单只是可选的手动后备。这里的 Worker 选择由调用 Skill 的 Agent 完成，不等于 Hub 已有独立智能调度模型，也不允许跨 Connector 任意操作。

### Dashboard

首版页面包含：

- Workers：名称、Runtime、机器、模式、在线状态、工作状态、当前任务、最后活跃。
- Connectors：名称、地址、连接时间和最后心跳。
- Tasks：目标、负责人、状态、上下文和完成标准。
- Commands/Events：命令状态、输出、错误和审计时间线。
- 创建任务、分配 Worker、发送命令的基本表单。

Admin Token 仅保存在浏览器 `sessionStorage`，WebSocket 首条消息认证，不进入 URL。

## 13. 安全边界

- 首次启动生成随机 Admin Token 和 Enrollment Token，写入 0600 凭证文件；也允许通过环境变量显式提供。
- Connector Token 和 Local Token 都是独立随机凭证。
- Hub 数据目录、Connector 数据目录和凭证文件不作为静态资源暴露。
- 默认只监听回环地址；绑定 Tailscale IP 是有意的部署操作。
- Tailscale 提供加密私网传输，但不替代应用层认证。
- Headscale 无策略时默认允许节点间通信，后续应使用 Grants 仅开放 Hub 端口。
- 不启用 Funnel，不关闭 Kimi API 认证，不默认绕过 Claude/Kimi 权限。
- 所有执行结果记录来源 Connector 和 Worker，便于审计。

## 14. Tailscale/Headscale 多机接入

本机开发可使用回环地址，不要求 Tailscale 正在运行。多机部署时，Hub 只绑定本机 Tailscale IPv4，不绑定 `0.0.0.0`，不启用 Funnel。

在中控机器确认 Tailscale 已连接目标 Headscale，并取得地址：

```bash
tailscale status
tailscale ip -4
agent-hub hub --host <本机-tailscale-ip> --port 8787 --data-dir .runtime/hub
```

尚未配置 Headscale 时，可按自己的认证流程使用 `tailscale up --login-server="https://<headscale-address>"`。已有非默认 Tailscale 设置时按 CLI 提示显式保留，不使用 `--reset` 覆盖配置。Headscale 策略需允许其他节点访问中控 TCP `8787`，本工具不修改服务端策略。

其他 Mac 加入同一 Headscale 网络后，通过环境变量临时提供 Enrollment Token，避免把 Token 写进命令历史：

```bash
read -s -p "Enrollment Token: " AGENT_HUB_ENROLLMENT_TOKEN; echo
export AGENT_HUB_ENROLLMENT_TOKEN

agent-hub connector \
  --hub-url http://<本机-tailscale-ip>:8787 \
  --name <机器名> \
  --data-dir ~/.agent-hub/connector
```

首次 Enrollment 后，Connector Token 保存在本机，后续启动不需要 Enrollment Token。新增机器不需要入站 Connector 端口。安装器支持真实的 `~/.agent-hub/connector` 目录，也支持从该位置链接到其他 Connector 数据目录，不创建自指向软链接。

统一地址优先使用 Tailscale IPv4；MagicDNS 名称只有在实际解析验证后才使用。其他 Mac 的完整克隆、安装、Skill 和 Worker 注册步骤见项目 `README.md`。

## 15. 验证标准

MVP 完成必须满足：

1. `pnpm test` 通过。
2. 使用真实 HTTP/WebSocket 跑通：
   `Connector enroll → Worker 自注册 → 创建 Task → 推送 Command → 返回结果 → Dashboard 收到事件`。
3. 覆盖离线期间命令持久化、重连重放和重复 `command_id` 不重复执行。
4. 覆盖同一 Worker 多命令串行。
5. Claude/Kimi/Codex 适配器分别做本机 smoke test；若真实模型调用无法验证，必须明确记录，不以 Test Driver 代替结论。
6. 文档中的 API、命令和最终实现一致。
7. 真实模型 smoke 不启动 Tailscale、不访问其他机器、不接管或修改已有 Agent Session 作为副作用，只使用全新的隔离 Session。Tailscale 部署验证单独进行，不以本机绑定代替跨机验收。

## 16. 当前实现验证记录

- `pnpm test`：21 项测试全部通过，覆盖凭证、自注册、任务派发、Dashboard 事件、离线重放、命令去重、串行执行、崩溃恢复、Claude/Kimi/Codex 协议适配、本机 Skill 安装器、Local 任务全流程、等待超时、跨 Connector 权限和 CLI 布尔参数。
- `pnpm check`：通过。
- 真实 CLI 进程：使用独立测试凭证和 Test Driver 完成 `Hub → Connector → Worker 注册 → Task → Command → succeeded`，Dashboard 静态资源可访问。
- 真实 Chrome：使用临时浏览器 Profile 完成登录、创建任务、派发命令，确认实时连接、渲染结果和命令成功，无浏览器异常。
- Kimi 真实 smoke：在全新的隔离 Session 中，显式设置 `kimi-code/kimi-for-coding` 后返回 `AGENT_HUB_OK`。未显式设置模型时，本机新 Session 曾返回 `Model not set`，因此保留 Worker/环境两级模型配置。
- Claude 协议测试：验证首轮 `--session-id`、后续 `--resume`、`stream-json` 输出和结果解析通过。
- Claude 真实 smoke：原 Anthropic 账户不可用，已改用百炼 Token Plan；`ANTHROPIC_BASE_URL` 为 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`，主模型及 Sonnet/Opus/Haiku/Subagent 映射均为 `deepseek-v4.1-flash`。通过 `bl config agent` 使用本机 `BAILIAN_TOKEN_PLAN_KEY` 完成鉴权，未读取或输出密钥内容。2026-10-26 使用真实 `ClaudeDriver` 和全新隔离 Session 验证：首轮返回 `AGENT_HUB_OK`，同一 Worker 第二次通过 `--resume` 返回 `AGENT_HUB_RESUME_OK`，两次 Session ID 一致。此前 `bl text chat` 也已验证该模型可返回 `AGENT_HUB_BAILIAN_OK`；未以模拟进程结果替代真实调用。
- 本机三 Runtime 真实闭环：2026-10-26 使用独立 Hub/Connector 数据目录和随机回环端口，通过真实 Local REST、Admin REST、Connector WebSocket 与 Dashboard WebSocket 注册并触发 Claude、Kimi、Codex 三个 managed Worker。三者分别返回 `AGENT_HUB_CLAUDE_OK`、`AGENT_HUB_KIMI_OK`、`AGENT_HUB_CODEX_OK`；同 Worker 第二次命令分别返回对应的 `_RESUME_OK` 标记，原生 Session ID 均保持不变。六个 Command 全部 `succeeded`，三个 Task 均标记为 `done`，Dashboard 收到全部六个成功事件；重新打开 Hub 数据库后任务和命令结果仍可读取。Codex 使用本机已登录的 `codex-cli 0.164.0`、全新线程和只读沙箱，其稳定注册 ID 与原生线程 ID 按第 10.3 节分别保存。报告位于 `.runtime/local-triad-smoke/result.json`，不含访问令牌；测试后隔离服务已关闭。
- Agent Skill 与首批注册：2026-10-26 新增 `skills/agent-hub/SKILL.md` 和安全本机安装器，安装器测试覆盖软链接、真实目录、幂等和冲突不覆盖。实际安装到 Kimi/Codex 共享的 `~/.agents/skills` 与 Claude 的 `~/.claude/skills`，当前 Kimi 会话已识别并加载 Skill；`agent-hub` CLI 可从项目外目录使用。通过真实 CLI 在常驻 Connector 注册 `claude-agent-hub-01`、`kimi-agent-hub-01`、`codex-agent-hub-01` 三个新 managed Worker，均在线、空闲且 `push_capable=true`，能力标签和自描述已保存；本次仅注册，未额外调用模型。网页与 Connector 健康检查通过，未修改现有 hooks 或接管交互 Session。
- Agent 自然语言任务流：新增 Local Token 任务创建、命令派发与事件等待、验收后状态更新；Hub 对 Worker 和 Task 的 Connector 归属做服务端校验。自动化测试覆盖完整任务、超时后继续执行、external 立即返回人工状态、跨 Connector 拒绝、完成时间戳和 CLI 布尔参数。2026-10-26 通过当前 Kimi 按新版 Skill 流程选择 `claude-agent-hub-01`，不使用 Admin Token 或网页表单创建并执行任务，真实回执为 `AGENT_HUB_TASK_OK`，验收后任务更新为 `done`，Worker 恢复空闲。已打开的 Skill 调用如果缓存旧版，需要刷新或重新打开 Session。
- Tailscale/Headscale：2026-10-26 按用户明确要求启动现有 Tailscale，使用已保存的 Headscale 配置并保留非默认设置。Hub 已绑定本机 Tailscale IPv4 的 `8787` 端口，本机通过该私网地址完成健康检查和 Dashboard HTTP 200 验证；Connector 已重连，三个 managed Worker 均在线、空闲且可推送。未启用 Funnel，未修改 Headscale 服务端或 ACL，未访问其他机器；跨机注册仍需实际第二台 Mac 验收。公开文档不记录真实私网地址或凭证。
