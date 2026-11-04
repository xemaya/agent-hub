# Agent Hub 设计文档

状态：当前实现与部署基线
适用阶段：AWS 单实例公网 Hub，多台 Mac 通过 Connector 接入

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

- AWS 上运行一个公网 Hub；本机开发也可在 macOS 启动。
- 每台 Mac 运行一个 Connector，通过 HTTPS/WSS 出站接入。
- Worker 通过所在机器的 Connector 自注册。
- Workers、Connectors、Tasks、Commands、Events 的持久化和展示。
- Connector 与 Hub 之间使用出站 WebSocket 推送命令。
- 命令持久化、ACK、重连重放、重复命令去重、每 Worker 串行执行。
- Claude、Kimi、Codex 可见交互 Session 的实际触发适配器。
- 外部 Session 的登记和人工协作模式。
- Worker 脱敏通信录和经过 Hub、无需中央模型的单条直连消息。
- 一个无构建步骤的 Web 中控页面和通用 CLI。
- 管理员启用的中央协调器：全局规划、Worker 匹配、依赖编排与最终证据评审。
- systemd 常驻、Caddy TLS 和 SQLite 一致性备份；Headscale 作为可选管理或私网通道。

### 2.2 暂不包含

- Agent 自由群聊、无限自动重试、跨 Hub 多主调度。
- 多 Hub、多主写入、分布式锁和消息队列集群。
- 双向文件同步、自动解决 Git 冲突、向量数据库。
- 未经启动器或原生 Channel 接管的任意旧窗口自动控制。
- 自动安装或修改 Tailscale/Headscale。
- Tailscale Funnel、多租户和细粒度用户权限。

## 3. 核心概念

| 概念 | 含义 | 身份边界 |
| --- | --- | --- |
| Host | 一台 Mac 或服务器 | 物理/虚拟机器 |
| Connector | 每台机器上的唯一本地连接器 | 一个机器节点一个实例 |
| Worker | 一个独立的数字员工 | 一个 Agent Session |
| Role（岗位） | 一类长期工作的负责方，比如 QA | 由管理员或登记命名；Session 是它的座位，可以换 |
| Runtime | Claude、Kimi、Codex 等客户端类型 | Worker 的实现方式，不是身份 |
| Task | 有目标、上下文和完成标准的工作 | 跨 Worker 的协作主线 |
| Command | 发给 Worker 的一次具体触发 | 有唯一 ID 的执行请求 |
| Event | 注册、状态变化、ACK、交接等事实 | 追加式审计记录 |

一个 Host 可以有多个 Worker；一个 Worker 同一时间最多有一个主任务；一个任务同一时间只有一个主负责人。

### 3.1 Worker 交付能力

所有 Worker 都是 `external`，对应一个用户可见的交互 Session。`mode` 仅保留为数据与协议兼容字段，不再提供后台执行模式。

- 注册必须携带已核实的 `runtime_session_id`，Connector 不创建后台 Runtime。
- `push_capable` 只由真实交互 Channel 的接通状态决定，不能由注册参数直接声明。
- 在线且 Channel 已接通的 Worker 可接收直接命令、担任中央协调者或参与自动编排。
- 未接通时可以分配任务、记录上下文和状态，但命令显示为 `waiting_manual`，不能伪装成已主动送达。
- 实际模型执行、工具审批和用户干预都发生在对应交互窗口中。

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
│ Agent Hub（AWS 单实例）                                      │
│ HTTP API · WebSocket · SQLite · Durable Command Outbox      │
└──────────────────────────────▲───────────────────────────────┘
                               │ 出站 Connector WSS
                               │ 命令下行 / 状态上行
                    ┌──────────┴──────────┐
                    │                     │
              本机 Connector          其他 Mac Connector
                    │                     │
        ┌───────────┼───────────┐         │
        │           │           │         │
  Claude Channel Kimi Channel Codex queue │
        │           │           │         │
        └───────────┴───────────┘         │
                     │                     │
              用户可见的交互 Sessions       │
```

网络原则：

- Connector 主动连接 Hub，Worker Mac 不开放入站端口。
- 正式 Hub 只监听 `127.0.0.1:8787`，由 Caddy 在 443 提供 HTTPS/WSS。
- Connector 本地 API 默认只监听 `127.0.0.1:8788`。
- Kimi 临时 Session 准备 API 只监听回环地址，令牌不写入日志。
- Headscale 仅作为管理或可选私网通道，不是公网接入的依赖。

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
  "mode": "external",
  "runtime_session_id": "必填；来自已核实的交互 Session",
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

### 5.3 Worker 撤下与恢复

- `workers.retired_at` 记录可恢复的软注销，数据库迁移到 `user_version=6`。默认 `listWorkers`、Connector 本地列表、Dashboard、@选择器和调度 Registry 都排除已撤下员工；`getWorker`、历史 Task/Command/Event 与 `GET /api/v1/workers?include_retired=true` 仍可读取。
- 当前 Agent 通过 `POST /local/v1/workers/unregister-current` 提交 runtime 和原生 Session ID，Connector 以 `worker.unregister` 请求 Hub 校验归属并撤下；管理员通过 `DELETE /api/v1/workers/:id` 撤下指定员工。`worker unregister-current` 复用注册时的可信身份，不需要 Admin Token；管理员命令为 `worker unregister WORKER_ID`。Dashboard 的员工详情提供同样的管理员注销操作，须确认后执行并显示失败原因；注销中央大脑时先通过 `PUT /api/v1/coordinator {enabled:false}` 停用，再调用删除接口。
- 撤下在事务中检查 queued/accepted/running/waiting_manual 命令、进行中任务、ready/planning/in_progress/待终审编排分配及当前协调者身份，存在活动工作时返回 409，不自动取消。已结束或失败的历史计划不阻止撤下。
- `createCommand`、@解析、直接问答、协调者配置和已有计划启动都拒绝已撤下员工。重复撤下幂等；显式重新注册同一 `runtime + runtime_session_id` 恢复原 Worker ID 并清除 `retired_at`，心跳和 Connector 重连不会自动恢复。
- Hub 发出 `worker.unregistered` 事件并同步新版 Connector 的 `retired_at`，Dashboard 立即移除员工及未发送的 @引用；旧版 Connector 忽略未知消息，需更新后才支持自注销和本地状态同步。历史消息中的 speaker 姓名保留。

### 5.4 Task 看板删除

- `tasks.deleted_at` 记录软删除，数据库迁移到 `user_version=8`。`DELETE /api/v1/tasks/:id` 只接受独立任务或编排父任务，同一事务标记父任务和已有子任务，清理 Worker 的当前指派，保留 Task、Command、Event、Chat 和任务编号。重复删除幂等。
- 存在 queued/accepted/running/waiting_manual 命令、进行中任务或活动编排时返回 409，不自动取消。`createCommand`、`updateTask` 与 @任务解析拒绝已删除任务。默认 Task/Orchestration 列表排除墓碑，`getTask`、`getOrchestration` 和管理员 `GET /api/v1/tasks?include_deleted=true` 保留审计读取。
- Dashboard 任务详情提供确认后的“删除任务”，发出 `task.deleted` 后移除整份计划、任务卡和未发送的 @任务引用；历史对话保留但不提供失效任务入口。

## 6. 任务与命令模型

### 6.1 Task

```json
{
  "task_id": "task_...",
  "task_number": 1,
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

`task_number` 是独立序列分配的持久化编号，页面显示为 `#0001`；旧任务按插入顺序回填，清空历史不复用编号。所有外键、API 引用和 Worker 关联仍使用完整 `task_id`。

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
- `waiting_manual`：交互 Channel 未接通，需要等待接通或人工处理，不能伪装成已主动送达。

### 6.3 输出与结果

- 状态变化写入 Event。
- 增量输出写入 Command 的输出字段并实时广播，不为每个 token 写一条 Event。
- 输出总量设置上限；达到上限后保留尾部并标记 truncated。
- 最终结果与错误单独保存，避免只能翻完整终端日志。

### 6.4 Worker 邮箱（schema 12）

通信使用独立 `worker_mail` 表，不创建 Command，也不占用任务队列或调用中央大脑。单个持久化行同时是发件人的 outbox 和接收人的 inbox；发送回执表示已入箱，即使接收方离线也成功。已读、原生通知和业务回复是独立事实。

协议：`mail.send` / `mail.list` / `mail.get` / `mail.read`，发送方由 Connector 与当前原生 Session 核验；邮箱仅参与者可见。`message_id` 用于邮件身份，`conversation_id` 和 `in_reply_to` 组织回复；`command_id` 可空，只引用上下文。关联任务取消或历史清理不会取消邮件或阻塞后续回复。

发送方提供 `client_message_id` 作为幂等键；相同内容重试返回同一回执，不同内容冲突。分页使用自增 sequence 游标，列表只返回正文摘要。read 操作仅能标记接收人的读状态；管理员检查不会替员工标读。

Connector 和原生桥接均声明 `mailbox_v1` 后可推送通知。通知状态为 pending / offered / accepted / unknown / unsupported / coalesced / checked，accepted 仅表示原生桥接接受通知，不表示代理已读。通知前持久化本地去重记录；未知投递结果不重放模型回合，邮件始终可以从 inbox 主动读取。旧桥接升级后仅恢复明确未支持的通知，不重试 unknown 通知。

通知是门铃，不是信。原生回合里只有未读数和最新一封的元数据（发件人、主题、message_id），没有正文；代理用 `message inbox --unread` 自己决定拉多少封、是否合并处理。一个收件箱同一时间只挂一个门铃：门铃已响（offered / accepted）且接收人还没查看收件箱时，后续来信只记为 coalesced，不再排新的原生回合；接收人一调 `mail.list`（inbox）、`mail.get` 或 `mail.read`，这些通知记为 checked，门铃复位，下一封来信再响。门铃挂起超过 `mailRingIntervalMs`（默认 15 分钟）仍未查看，下一封来信会再响一次，保证代理不会被永久静音。这样消息堆积只增加未读数，不增加模型回合，也不会让代理按过时的先后顺序逐封执行。

旧 `worker_message` Command 及其 wait 接口保留作为显式兼容路径；普通 message send 默认使用邮箱。任务执行继续使用原有 Command 的 check/report，不将普通来信包装成任务，也不为每封来信要求业务回复。

### 6.5 命令取消与 Agent 失稳保护

- 管理员通过 `POST /api/v1/commands/:id/cancel` 或 `agent-hub command cancel` 终止活动 Command。Hub 将其持久化为 `failed`、`outcome_unknown=true`，保留 Command、Task、Event 历史；不存在的 ID 返回 404，已结束命令返回 409。
- 取消复用正常失败的收尾规则：独立任务或相关编排阻塞，不自动重试；worker_message 唤醒原发送方，中央模型不参与直连消息。接收方 Connector 收到 `command.cancel` 后取消本地排队或拒绝并移除等待中的 delivery，晚到 report 返回 404。旧 Connector 忽略取消通知时，Hub 的终态仍拒绝晚到成功结果。
- 取消只终止 Hub 追踪、调度和结果接收，不宣称已杀死任意 Runtime 或桌面模型进程。模型进程的停止由用户或对应 Runtime 负责。
- `commands.last_activity_at` 从 `user_version=11` 开始持久化，旧记录按 started/accepted/created 回填。create、accept、start 和真实 output 更新时间；Connector/机器心跳不作为 Agent 工作进展。
- 看门狗只处理 running Command。协调者默认 15 分钟、其他命令默认 60 分钟无活动后以 `inactivity_timeout` 和结果未知收尾，不自动重试；queued、accepted、waiting_manual 不按执行超时处理。超时使用 `cancelCommand` 的统一收尾，服务重启后继续依据数据库时间判断。
- 可通过 `AGENT_HUB_COORDINATOR_INACTIVITY_TIMEOUT_MS`、`AGENT_HUB_COMMAND_INACTIVITY_TIMEOUT_MS` 调整，0 表示禁用对应看门狗。Agent 不稳定时允许结果未知，不能把超时或取消伪报为成功。

### 6.6 进展上报与语义看门狗（schema 13）

6.5 的无活动超时只看时间。交互 Channel 在 ack 和 report 之间不回传任何输出，长任务因此要么被 60 分钟一刀切，要么空转也看不出来。参考 DeepSeek Super-agent 的 Watchdog 设计（见 [`research/deepseek-superagent.md`](research/deepseek-superagent.md)），补两件事：

- **进展上报**：Claude Channel 新增 `agent_hub_progress(command_id, note)`，Connector 本地接口 `POST /local/v1/channel/commands/:id/progress`。一行（≤500 字符）写入命令输出，前缀为 `[progress] `，并刷新 `last_activity_at`，所以健康的长任务不会被无活动超时误杀。这个调用可选，不是结果，也不替代 report。
- **语义看门狗**：管理员用 `PUT /api/v1/watchdog` 指定一个在线、Channel 已接通、且不是中央协调者的 Worker。Hub 定时器每 `interval_ms`（默认 10 分钟，按上一条巡检命令的创建时间计算，重启不会连发）检查一次：如果有运行超过 `min_running_ms`（默认 10 分钟）的命令，就生成一条 `watchdog_check` 命令。快照包含任务目标与验收、指令头部、运行和空闲分钟数、最近 10 条进展行、输出尾部，以及上次巡检的结论与 `activity_since`。看门狗不评判它自己的 Session，每次最多评判 8 条命令。
- 看门狗只输出 `{"verdicts":[{command_id,state,action,evidence,message}]}`：`state` 取 progressing / looping / drifted / stuck / unclear，`action` 取 none / nudge / escalate。Hub 按 Schema 校验，要求覆盖快照中每条命令。progressing 和 unclear 一律强制为 none。
- Hub 只执行低风险动作：`nudge` 由看门狗 Worker 给目标 Worker 发一封邮箱提醒，关联原 command_id，同一命令在 `nudge_cooldown_ms`（默认 30 分钟）内最多一封；`escalate` 写 `watchdog.alert` 事件，并在中央对话追加一条 activity 消息等人处理。**不取消、不重试、不改任务状态**；取消仍只由 6.5 的无活动超时和管理员执行。目标命令在巡检期间已经结束的，只记录 verdict（`stale=true`）。
- 每条结论都写成 `watchdog.verdict` 事件（含 `applied`，即实际执行的动作），用于审计和后续调参。输出无效或巡检失败时写 `watchdog.check.failed`，不采取任何动作。`watchdog_check` 属于内部命令：输出不在员工工作动态中展示，使用协调者的 15 分钟无活动超时。手动触发一次巡检：`POST /api/v1/watchdog/check`（忽略间隔和最短运行时长）。

### 6.7 快路径、批处理、证据摘要、结构化回报与外部话题（schema 14）

参考 DeepSeek Super-agent 的 Router/Worker 设计（[`research/deepseek-superagent.md`](research/deepseek-superagent.md) §6）：

- **确定性快路径**：中央对话里只 @ 了一位员工、没有 @ 任务的消息，以及只 @ 了一个任务、该任务状态是 ready / in_progress / review / blocked、负责人在线可推送、且不是编排父任务的消息，由 Hub 直接作为 `worker_chat` 发给对应员工，不调用中央大脑（事件 `coordinator.chat.fast_path`）。员工判断这其实是需要立项的新工作时，只回复 `HANDBACK: <原因>`：Hub 把同一条回复改交中央大脑（`coordinator.chat.handback`，记录 `handback_reason`），提示词里写明交回原因，并禁止再转回同一员工；每条消息只交回一次。其余消息照旧走中央大脑。
- **协调者批处理**：中央大脑的 Session 有活动中的 Hub 命令（queued / accepted / running）时，新消息先排队（`queued=1`，`coordinator.chat.queued`）。任一命令结束后，Hub 合并处理排队消息：只有一条时走原来的单条格式；多条时生成**一条** `coordinator_chat`（`coordinator.chat.batched`），要求输出 `{"replies":[{message_id,reply,action}]}`，各条独立校验、独立执行，缺失或无效的那条单独失败，不影响其他条。批次回复用 `batch_command_id` 关联；重启后由 `resumeChat` 继续处理。
- **证据摘要加读取指针（Inline & Spill）**：步骤 prompt、修正上下文和 @任务 引用中，每条上游结果最多内联 1,500 字。依赖结果总预算 6,000 字，引用任务 3,000 字。被截断的条目带 `full_result: "agent-hub command result <command_id>"`。`command.result`（本地 `GET /local/v1/commands/:id/result`）只允许命令执行者本人，或自己某条命令输入里含有该 command_id 的员工读取，即「指针就是在 prompt 里拿到的凭据」。中央大脑终审仍内联每条结果最多 12,000 字，因为它不能调用工具，不完整的证据不得判通过。
- **结构化回报与「等你处理」**：成功回报可带 `outcome`（done / needs_input / blocked / dropped）和一个 `question`；needs_input / blocked 必须带 question。Claude 用 `agent_hub_report`，Codex 用 `desktop report --outcome --question`，Connector 会校验。Hub 为 needs_input / blocked 生成 Attention（`attentions` 表，每条命令一个）：独立任务改为 blocked；编排步骤改为 blocked，编排以 `coordinator_step_needs_input` 停住，不当作失败去重试。Dashboard 员工栏顶部的「等你处理」只列开放的 Attention，没有就不显示。回答（`POST /api/v1/attentions/:id/answer` 或 `agent-hub attention answer`）时：编排步骤把问答追加到 `step.answers`，同一步重新执行，编排恢复 in_progress；其他情况给原员工发一条新指令，带上问题、回答和上次回报的读取指针。`dismiss` 只关闭，不发指令。不会从自由文本里推断「在等人」。
- **外部话题（trigger）**：`agent-hub trigger` / `POST /local/v1/triggers` / WS `trigger.receive`。`trigger_key` 用于幂等（`triggers` 表，重复送达返回 `duplicate=true`）；`thread_key` 就是订阅。话题上有未结束（非 done / cancelled）的任务时：任务有开放 Attention，这条消息就作为回答（routed `answered`）；否则直接给负责人发一条跟进指令（`followup`），不经过中央大脑。没有任务时，不带 `followup_only` 的消息新建任务，负责人必须是本 Connector 上的员工，并标记 `thread_key`（`created`）；带 `followup_only` 的消息返回 `ignored`。任务结束后订阅自然失效。消息只是上下文：权限仍由负责人自己的 Session 和任务范围决定。
### 6.8 岗位与交接：Session 是座位，不是身份（schema 15）

参考 DeepSeek Super-agent 的 Ticket / Assignment 分离（[`research/deepseek-superagent.md`](research/deepseek-superagent.md)）。之前一个 Session 就是一个岗位，这个 Session 断了，岗位上的活也就没人做了。我们控制不了 Session 是否在线，所以不能只靠一个 Session：

- **岗位**（`roles` 表：`role_key`、名称、`takeover_after_ms`，默认 3 分钟）。Session 登记时带 `--role qa` 加入岗位（`worker register-current --role qa`；再次登记不带 `--role` 时保持原岗位，`--role none` 退出），也可以由管理员调整（`PUT /api/v1/workers/:id/role`）。加入不存在的岗位时会自动创建。一个岗位可以有多个座位，可以分布在不同的机器上。
- **岗位的工作目录**（schema 16：`roles.workdir`，`role set qa --workdir youxian-qa`，`none` 清除）。权限通常跟目录走，开错目录的 Session 接了活也干不了，所以目录不符的座位不算可用：不选它，也不把新工作交给它，任务按没有座位处理。绝对路径要完全相等；相对路径按路径结尾的完整段匹配，这样同一岗位可以坐在不同的 Mac 上。判断依据是 Channel 进程上报的真实目录（`workers.session_cwd`，随 `worker.channel` 上报）；旧 Channel 或旧 Connector 报不了时，退回登记时声明的 `cwd`。`worker register-current` 在目录不符或 `--cwd` 与真实目录不一致时，在响应的 `warnings` 里说明；Dashboard 的员工卡片和 `role list` 的座位也显示原因。
- **任务属于岗位**（`tasks.role_key`）。`assignee_worker_id` 只表示当前坐在这个任务上的那个 Session。按岗位寻址的入口有：trigger 的 `role`（替代 `worker_id`）、`task create --role`，以及不带 `worker_id`、只带 `task_id` 的 prompt 命令（Admin 和 `send --local` 都支持）。
- **交接记录**（`handoffs` 表，每个任务最多一条 open）：表示这个任务有工作在等座位。如果工作到达时还有一条交接没送出，新工作会合并进这条交接（`handoff.merged`）。选座规则：
  - 只考虑 Channel 已接通、所在机器在线、未撤下的 Session。
  - 原来那个 Session 只要回来，就优先交给它，换来的是【恢复】提示，不带交接包。
  - 过了 `not_before` 之后才交给其他 Session：一个座位同时只做一件事，只选没有活动命令的，有多个时选最近活跃的。
  - 座位全忙时工作留在交接里排队，不压到某个忙的座位上，否则别的座位先空出来也接不走；任何命令结束时按先来后到重新分配。trigger 响应用 `seats_busy` 区分「全忙」和「没人」。同一任务的后续消息仍直接给当前座位，它有这个任务的上下文。
  - 送出时任务改派给接手的 Session（事件 `task.handoff`），交接记录改为 dispatched。
  - 任务结束或被删除时，open 的交接记录被取消。
- **什么时候发生交接**：
  - **任务有人负责、但那个 Session 不可达**：新工作（话题跟进、Attention 回答、管理员指令）不再停在 `waiting_manual`，而是进入交接。`not_before` = 它不可达的起点（Channel 断开记 `workers.detached_at`，机器离线按 `last_seen_at`）+ `takeover_after_ms`。
  - **执行中途 Session 丢了**：命令以 `outcome_unknown` 失败，比如 `channel_closed`，或者看门狗判定的 `inactivity_timeout`。Hub 把同一份工作再交接一次（reason `session_lost`），`not_before` = 现在 + `takeover_after_ms`，给原 Session 留出重启恢复的时间。管理员取消（`admin_cancelled`）不算 Session 丢失。同一个任务最多交接 3 次（`MAX_SESSION_LOST_HANDOFFS`），之后写 `handoff.exhausted` 事件，任务停在原地，防止一个会把 Session 搞崩的任务把所有座位挨个搞崩。
  - **已排队但没开始的工作**：负责的 Session 不可达超过 `takeover_after_ms`，而且岗位上有其他在线座位时，Hub 定时检查（与命令超时检查共用间隔）会把还没开始的命令（queued / accepted / waiting_manual，并且 `started_at` 为空）以 `seat_reassigned` 收回，交给其他座位（reason `seat_down`）。正在执行的命令从不搬走：它可能还在跑，只能等 Session 自己回报，或者等无活动超时。
- **交接包**：给新座位的指令由任务自身的记录生成，不依赖前任的记忆。内容包括：
  - 任务、岗位、前任是谁、为什么交接；
  - 目标和验收标准、关联话题；
  - 前任的工作目录和机器，接手的 Session 在另一台机器上时会注明「本地改动看不到」；
  - 最近 8 条 `[progress]` 进展；
  - 上一次回报，最多内联 1,500 字，并附读取指针；
  - 还没回答的问题；
  - 被中断那次执行的读取指针；
  - 恢复提示：先核对现场（git status / log、已经发出的消息或草稿、外部系统），不重复已经发生的对外动作，拿不准就用 needs_input 回报；
  - 最后是 `本次要处理：` 加上工作本身。
  再次交接时只传递 `本次要处理：` 之后的部分，交接包不会层层嵌套。读取指针按 6.7 的规则成为接手者的凭据。
- **不做的事**：不维护无状态的 agent loop（Runtime 不归我们管），不自动重跑非岗位任务，不在 Session 之间迁移对话记忆。没有加入岗位的 Worker 和任务，行为与之前完全一样。
- **登记与列表**：重新登记只更新写明的内容：没传 `--capabilities` 时保留原能力，`--metadata` 按字段合并，岗位不变。`worker list` 里 `presence` 是 Connector 的状态，`session_online` 才是这个 Session 的 Channel 是否接通。`session start --resume` 没传 `--cwd` 时，回到这个 Session 上次运行的目录。本机命令不写 `--data-dir` 时，依次找环境变量、当前目录下的 `.runtime/connector`、`~/.agent-hub/connector`。
- Dashboard：员工卡片显示所属岗位；「等你处理」顶部列出等座位的交接，并说明是在等原 Session 恢复，还是岗位上没有在线的 Session。

### 6.9 渠道桥与审批型 Attention（schema 17）

参考 [`harness.md`](harness.md) §9：把「飞书 Source」「对外动作审批」「通知出口」从具体 agent（youxian-qa）抽到 Hub 这一层，第二个渠道或第二个 agent 接入时只写配置。

- **Source 入口**：`POST /api/v1/triggers`（Admin Token）与 Connector 的 `trigger.receive` 等价，事件 actor 记为 `source:<source>`；`worker_id` 寻址时不再要求属于某个 Connector。渠道桥用它投递，不需要在 Hub 机器上跑 Connector。
- **事件游标**：`GET /api/v1/events?after=<event_id>[&types=a,b][&limit=N]` 按 rowid 升序返回之后的事件和新的 `cursor`；`after=` 为空时返回空列表和当前位置，所以新起的消费者从现在开始、不回放历史。未知游标返回 404。
- **审批型 Attention**：回报 `outcome: needs_approval` 并带 `action = { channel, kind, target, text, key?, note? }`（Connector 校验：channel/kind 为小写标识，text ≤ 20,000 字；`question` 可省略，默认用 note）。Hub 生成 Attention（`attentions.action_json`），任务改为 blocked。它和 needs_input 的区别：**话题里的消息不会被当成它的回答**（`ANSWERABLE_OUTCOMES` 只含 needs_input / blocked），只有审批人能决定。
  - `POST /api/v1/attentions/:id/approve {by?}`：open → approved，写 `attention.approved` 事件（payload 带 action）。Hub 自己不发任何东西。
  - `POST /api/v1/attentions/:id/execution {status: executed|failed, result?|error?, by?}`：由拥有 `action.channel` 的渠道桥在执行后调用，approved → executed / failed（`attentions.execution_json`），并给提出的 Worker 一条新指令：已发出（带消息 id，「不要再发一遍，没别的事就回报 done 并把任务改 done」）或发送失败（「什么都没发出去」）。Worker 不在了就走岗位交接。
  - `answer` 对审批型 Attention 表示不批准：文字作为修改意见发回 Worker（「改好后重新用 needs_approval 提交；什么都没有发出去」）。`dismiss` 照旧只关闭。
  - 交接包里列出前任「已提交待审批的对外内容（等审批 / 已批准渠道正在发出）」，并写明不要再提交一遍。
  - `GET /api/v1/attentions/:id` 读单条；Dashboard 的「等你处理」把审批卡片单独呈现：原文、「批准发出」「发回修改」「不用发了」。CLI `agent-hub attention approve ID`。
  - Claude 的 `agent_hub_report` 工具 schema 和 Channel 提示词新增 `action` 与 needs_approval 的说明；Kimi Channel 透传 `action`。
- **飞书渠道桥**（`agent-hub bridge feishu --config FILE [--once] [--observe] [--status]`，`src/bridge-feishu.js` + `src/feishu-api.js`）：Hub 机器上的一个 systemd 服务（`ops/agent-hub-bridge-feishu.service`，配置样例 `ops/feishu-bridge.example.json`），直接调飞书 Open API，凭证只在这台机器的 0600 文件里；Worker 完全不持有飞书凭证。桥用**自己的飞书应用**（企业自建，开机器人能力；权限：`im:chat:readonly`、`im:message`、`im:message.group_msg`、`im:message:send_as_bot`、`im:message.p2p_msg:readonly`），不复用任何人 Mac 上 lark-cli 的应用。配置只需 `app_id`、密钥文件、审批人的 `owner.union_id`（open_id 是按应用分配的，换应用就变；union_id 在同一开发者的所有应用下相同）和岗位：机器人自己的 open_id 从 `/bot/v3/info` 取，审批人的私信会话 id 从第一条「桥已上线」私信的返回里学到，审批人在本应用下的 open_id 从他在那个私信里的第一条消息学到，都存进状态文件；配置里显式写了则以配置为准。每轮：
  1. 拉 Hub 事件（游标）：`attention.created` 的 needs_approval → 私信审批人草稿原文（记 DM 消息 id → attention）；needs_input / blocked → 私信问题（同样记录）；发给审批人本人的 `feishu send` 默认自动批准（`auto_approve_to_owner`）；回到 `auto` 策略群的 `reply`（或发到该群的 `send`）也自动批准、发出后私信审批人回执——群级 `reply: confirm` 可以单独要求审批；桥定位不到所属群的动作一律问审批人；发出的正文里 `@<people 里的名字>` 换成飞书 at；`attention.approved` 且 channel 为 feishu → 执行 reply / send（uuid = `bridge-action-<key>`，重放不重复发），再回 `execution`，并私信回执；`handoff.exhausted` → 私信。
  2. 现查机器人所在的群：新群从现在开始（`floor`，之前的历史不处理），退出的群忘掉；每个群按群策略处理 @：`auto` 在 @ 消息上回一个表情（`ack_reaction`，默认 OK；`ack` 可配一句话，默认不说）并投 trigger（trigger 文本带话题最近 ≤1,500 字原文、「先判断是做事、回答还是只是通知」和「用 needs_approval 提交回复」的说明）；`confirm`（外部群默认）不在群里出声，先私信审批人，引用回「查」才处理；`ignore` 不管。已在跟的话题里的消息不论有没有 @ 都是跟进（`followup_only` 直达任务，也回表情），Hub 回 `ignored` 就不再盯。普通群的 @ 起初没有话题，席位的回复发出时桥查它开出的话题并以任务的 thread_key（`feishu:<@ 消息 id>`）跟起来，单独轮询（最多 `loose_ttl_days`）。普通群（FindU 实测也是）的群消息列表只有话题根消息、没有话题内的回复，别人开的话题里 @ 机器人本来看不见：桥每 `thread_scan_interval_s` 重新列各群最近 `thread_scan_hours` 的根消息、记下它们的话题（每群最多 `thread_max_per_chat` 个最近活跃的），和自己开的话题一起每分钟轮询。别的机器人发的消息默认不算工作（防两个机器人互相「收到」打乒乓）；`bots`（app_id → 名字）里列出的机器人的 @ 和话题消息才处理，指令里标明来自机器人，并有回环保护：每个机器人每小时最多 `bot_per_hour`（默认 6）条、每个话题每小时最多 `bot_thread_per_hour`（默认 3）条机器人消息，超出的丢弃并记日志；本机器人自己的消息永远不处理。要在回复里 @ 它，把它的 open_id 写进 `people`。飞书消息 uuid 超过 50 字符会被拒，桥统一截短加哈希；一条 Hub 事件连续 6 次处理失败就跳过并记日志，不让它堵住后面的审批和回执。
  3. 审批人的私信：引用草稿回「发」→ approve，回别的 → answer（修改意见）；引用问题 → answer；引用外部群确认 → 「查」就处理；不引用时只有恰好一条待决定才生效，多条要求引用；其余文字 = 岗位上的一个新任务（`feishu-dm:<消息 id>`），回复发给审批人本人无需再批。
  4. 一个群出错不影响其他群，游标不动下轮重查；连续 10 分钟没有完整跑通一轮私信审批人一次。`--observe` 只记录「本来会做什么」，用于和旧 watcher 并跑对账。
  幂等：Hub `trigger_key`、飞书消息 `uuid`、桥的 `handled` / `executed` 记录，三层保证重启、重跑都不会重复回复或重复发送。

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
connector.hello { token, build: { version, commit, dirty }, features: ["worker_message_v1"] }
→ connector.ready { connector, hub: { version, commit, dirty } }
```

认证前不接受其他消息，认证失败立即关闭。令牌不放在 URL 查询参数中。`build` 和 `features` 是可选字段，旧 Connector 不带也能认证；缺少直连能力声明时只影响 Worker 直连消息，不影响原有任务通道。

主要消息：

```text
Connector → Hub:
  connector.heartbeat
  worker.register
  worker.channel
  worker.status
  worker.directory
  worker_message.create
  worker_message.wait
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
  worker.directory
  worker_message.created
  worker_message.result
  task.created
  task.updated
  command.created
  command.dispatch
  command.cancel
  error
```

Connector 的 `task.create` / `command.create` 只能使用属于该 Connector 的 Worker；`task.update` 只能修改分配给该 Connector 的任务状态，且只接受状态字段。Hub 在服务端再次校验归属，不能仅靠本地 API 限制防止越权。直连消息额外校验发送方原生身份及消息归属，接收方 Connector 只能回报自己收到的 Command。

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
- Node 内置 WebSocket 没有握手超时，也察觉不到被静默丢弃的连接（实测：TCP 已接受但不回升级响应时一直停在 `CONNECTING`；中间链路不再转发时一直停在 `OPEN`，两者都不触发 error/close）。因此 Connector 自带看门狗：握手超过 `connectTimeoutMs`（默认 20 秒）未完成即断开重连；已就绪时每 15 秒发应用层 `connector.heartbeat`，10 秒无应答即断开重连。旧 Hub 对未知消息返回 `error`，同样视为链路存活。

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
- 崩溃前已经 running 的命令标记为 `failed`，并注明 `outcome_unknown=true`，不自动重跑可能已有副作用的工作。属于岗位的任务例外（6.8）：同一份工作会带着交接包和「先核对现场、不重复对外动作」的恢复提示，交给原 Session（如果它回来）或同岗位的其他 Session，最多 3 次。
- Hub 或 Connector 离线不删除 Task/Worker。
- 所有时间使用 UTC ISO-8601；数据库关联使用稳定 ID。

### 8.3 版本一致与自更新

这些机制属于连接恢复与代码发布层，不改变 Worker 身份、中央协调者权限、任务编排或 Command 投递语义。

- 版本标识是检出目录的 git commit（另带 `package.json` 版本和是否有未提交修改），Hub 与 Connector 在握手时交换，并通过 `/healthz`、`GET /api/v1/connectors` 暴露。
- Connector 每遇到一个新的 Hub commit 只处理一次：`git fetch` 后仅在工作区干净、本地是上游祖先时 fast-forward，依赖文件变化时执行 `pnpm install --frozen-lockfile`。脏、领先或分叉的检出一律跳过并记录原因；Hub commit 不在上游时提示更新 Hub。
- Hub 只触发更新检查，实际代码来自 Connector 本机配置的 Git upstream。该 upstream 属于代码执行信任边界；开发检出或不允许自动变更的机器用 `--no-auto-update` 或 `AGENT_HUB_AUTO_UPDATE=0` 关闭。
- 以 launchd 服务运行（`AGENT_HUB_SUPERVISED=1`）时，更新后等所有正在执行的交互命令结束再退出，由 launchd 拉起新代码；前台运行只提示手动重启，避免中断执行中的命令被标记为 `outcome_unknown`。
- 服务安装保留 `PATH`、`HOME` 和已设置的 `AGENT_HUB_AUTO_UPDATE`，并透传显式 `--local-port`；任何 Token 都不写入 plist。
- Hub 不自更新，只记录与 Connector 的版本差异；Hub 机器手动 `agent-hub update` 后重启。

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
task_id PK, task_number UNIQUE, title, goal, context, acceptance_json,
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
- Worker 映射和真实 push 能力。
- 已接受 Command 及执行状态。

MVP 数据量较小，不做 ORM、迁移框架或外部数据库。

## 10. Runtime 适配器

### 10.1 当前执行边界

- Connector 不创建 Claude print 进程、Codex exec 进程，也不通过 Kimi Web Server 提交后台 Prompt。
- 所有实际模型执行都在用户可见的交互 Session 中发生，工具权限由该 Session 的原生界面处理。
- Connector 只维护命令队列和交互 Channel；没有已接通 Channel 时没有执行 fallback。
- Claude 使用原生 Channel，Kimi 使用 ACP 或原生 TUI Channel，Codex 桌面使用原生 queue 加当前会话回执。

### 10.2 Kimi Session 准备

`KimiSessionManager` 只服务于启动器：通过临时 `kimi web --no-open --host 127.0.0.1` 创建或核对真实原生 Session ID，然后关闭临时 Server，再打开 ACP 或原生 TUI。它不包含 Prompt 执行、事件订阅或模型配置路径，令牌只保留在内存且不会写入日志。

### 10.3 历史后台适配器

旧版 Claude、Kimi、Codex 后台 Driver 已从产品代码移除。历史验证记录仅用于审计，不能作为当前接入方式。旧 Worker 升级后统一为 `external` 且 `push_capable=false`，必须重新接通可见交互 Channel。

### 10.4 当前交互 Session 启动器

- `agent-hub session start --runtime claude|kimi|codex` 只建立当前原生身份并打开客户端，不注册 Worker、不创建任务。
- Claude 生成 UUID；Kimi 通过 `KimiSessionManager` 创建或核对真实 ID；Codex 由自身向工具进程注入 `CODEX_SESSION_ID`。启动器不选择最近会话，不伪造身份。
- 当前交互 Session 统一登记为 `external`，保存 `interactive: true` 与 `session_origin`。`worker register-current` 校验 Runtime 和真实 ID 的一致性。
- 非 Kimi `--push` 时，`--` 后的参数原样传给 Runtime。Kimi ACP 不接受 Runtime 参数；支持 `tui_channel` 的构建可用 `--native-tui` 并转发原生参数。

### 10.7 Claude 交互窗口实时推送（Channel）

- 启动器写入当前 Session 的 MCP 配置，以原生开发 Channel、`agent_hub_ack` 和 `agent_hub_report` 打开交互式 Claude Code。
- Channel 使用 Local Token 打开 Connector 的 SSE 流，Connector 重启后自动重连。Connector 按 `runtime + session_id` 找到 Worker，未注册时保持 `waiting_registration`，注册后接通。
- 接通与断开通过 `worker.channel { worker_id, attached }` 报给 Hub。Hub 只根据这个真实状态切换 `push_capable` 并在接通时重放已接受队列；每次重连后 Connector 重报所有 Worker 的 Channel 状态。
- 命令按 Worker 串行。`agent_hub_report { command_id, status, result }` 结束命令，结果为 `{ text, session_id, delivery: "channel" }`，直接问答与编排读取方式不变。重复回执被拒绝，`output_gap=true` 表示证据不完整。
- 接通前已为 `waiting_manual` 的命令不自动转推。窗口在执行中关闭时命令记为 `failed` 且 `outcome_unknown=true`。
- @员工、中央协调者与自动编排步骤都只对在线且 Channel 已接通的 Worker 开放。权限确认仍留在交互窗口。

### 10.8 Kimi ACP 与原生 TUI 实时推送

- ACP 启动器通过临时 Web Server 取得真实 ID 后立即关闭它，再以 `kimi acp` 建立单条连接。用户和 Hub 共用原生 Session，输入与命令串行，权限在同一窗口处理。
- 支持 `tui_channel` 的构建可用 `--native-tui`，通过本机 Unix Socket 进入原生发送队列和审批面板，不启动 ACP 或第二个 Runtime。
- `KimiChannel` 复用 Connector 的 SSE 接通、注册和重连：prompt 开始时 `/ack`，结束时 `/report`，结果为 `{ text, session_id, delivery: "channel" }` 并传递 `output_gap`。
- 不关闭 Session 锁、不调用 `:takeover`、不保留共享 Web Server、不模拟键盘或修改 wire.jsonl。退出后 Worker 自动退回 `waiting_manual`。
- 已接通的 Kimi 可担任中央协调者或参与自动编排，未接通时不能转为后台执行。

### 10.5 测试交互 Driver

测试 Driver 只存在于测试代码，通过真实 SSE Channel 驱动可控交互结果，用于验证推送、串行、断线和重放，不代表真实 Agent 验证，也不作为 Connector 的生产 fallback。

### 10.6 中央协调器

- 管理员通过 `PUT /api/v1/coordinator` 指定一个在线且 Channel 已接通的 Worker 作为中央协调者，并设置 `enabled` 与 `max_steps`。Dashboard 候选使用同一条件；Worker 自声明协调者身份不会获得权限。
- 协调者生成受限对话动作、规划与评审 JSON，不能访问 Admin API、不能直接改库或任意选择命令目标。规划输入是总 Task 和脱敏 Registry：Worker ID、名称、机器、Runtime、能力、description、cwd、在线和工作状态；不包含会话私有状态、任意 metadata 或 Token。
- `coordinator_config` 保存协调者配置；`coordinator_orchestrations` 保存父任务、协调者、状态、摘要、`steps_json`、错误、`auto_start`、来源消息、终审理由、`recovery_count`、`review_command_id` 和时间。步骤持久化 key、选定 Worker、依赖、task/command ID、状态、结果、错误与评审理由；修正前的结果和评审归档在 `previous_attempts`。`coordinator_chat_messages` 保存用户、协调者和任务活动消息，通过 request/source 去重键及 Command/Task 关联支持恢复。
- 对话使用 `coordinator_chat` Command，规划使用 `coordinator_plan` Command，终审使用 `coordinator_review` Command，复用现有持久化、ACK、去重、断线重放和串行执行。终审 Command ID 与编排关联，迟到的上一轮回执不能再次触发评审或修正。规划与评审在 Command 回执中也可审计；内部 JSON 不作为员工工作动态展示。
- 单独 `@员工` 的 `action=chat` 是转交问答，不采用中央代答。Hub 从回复的来源键找回原用户消息，向目标 Worker 发出 `worker_chat` Command，附带必要的 @任务上下文，`task_id=null`，不创建 Orchestration。创建 Command 与更新回复关联在同一事务提交，最终回复和 Hub 重启恢复按 Command 幂等完成，不重复转交。Worker 的纯文本结果才是最终回复；失败、空结果和未知结果明确失败，不伪造验收。
- 一步能完成就不硬拆，默认最多 4 步。Hub 校验 JSON Schema、字段、Worker 可用性、重复 key、未知依赖与环。子 Task 初始不指定负责人，轮到执行时才分配，避免提前占用多个 `current_task_id`；派发前还会检查 Worker 是否忙碌及其当前 Task 是否活跃。
- 自动编排状态为 `planning → in_progress → review → done`，可进入 `blocked` 或停留在 `review`。只规划对话在计划生成后进入 `ready`，确认后只启动这个已有计划，不重新规划，也不通过 `start` 重跑失败、评审或完成任务。子步骤为 `ready / running / review / done / blocked`。命令成功后步骤先进入 `review`，终审通过才进入 `done`。依赖只在前序命令成功后继续，终审仍可拒绝父任务。
- 步骤 Prompt 直接携带已完成直接依赖的真实结果（总预算 64,000 字符）和来源消息中 `@任务` 的历史结果（总预算 24,000 字符，再按各任务步骤分配），不再要求 Worker 自行查询上游。超出预算标记 `result_truncated`，Runtime 的 `output_gap` 映射为 `result_incomplete`；不完整证据不能被描述为已经完整阅读。终审每个结果最多使用 12,000 字符，并附带同样的不完整标记，无法确认的验收必须拒绝。
- 每个编排只有一次初始规划，不自动扩写计划。合法终审明确拒绝且能定位失败步骤时，中央大脑最多自动修正两轮：失败步骤及其传递依赖的后续步骤重新执行，独立且已通过的步骤不重跑。修正 Prompt 携带上轮整体意见、步骤评审和其他步骤真实结果，修正后重新终审；仍不通过则停留 `review` 并请求补充信息。
- 计划失败或无效、步骤执行失败进入 `blocked`；评审无法解析、父任务整体未通过但没有失败步骤时不盲目重试，不能伪造完成。终审只根据返回证据，不虚构独立测试。
- 重启时按持久化的编排和 Command 状态恢复，不重复创建子任务或命令；既有 rejected review 在未使用过修正额度时由同一恢复逻辑接管。`orchestration.list` 仅返回当前 Connector 创建的或其 Worker/协调者参与的编排。

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
DELETE /api/v1/workers/:id
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id
DELETE /api/v1/tasks/:id
GET    /api/v1/commands
POST   /api/v1/commands
GET    /api/v1/commands/:id
GET    /api/v1/events
GET    /api/v1/coordinator
PUT    /api/v1/coordinator
GET    /api/v1/coordinator/chat
POST   /api/v1/coordinator/chat
DELETE /api/v1/coordinator/chat
GET    /api/v1/roles
PUT    /api/v1/roles/:role_key            { name?, description?, takeover_after_ms?, workdir? }
PUT    /api/v1/workers/:id/role           { role: KEY | null }
GET    /api/v1/handoffs[?status=open|dispatched|cancelled|all&role=KEY]
GET    /api/v1/attentions[?status=open|answered|dismissed|approved|executed|failed|all]
GET    /api/v1/attentions/:id
POST   /api/v1/attentions/:id/answer       { answer, by? }
POST   /api/v1/attentions/:id/dismiss
POST   /api/v1/attentions/:id/approve      { by? }                      (needs_approval only)
POST   /api/v1/attentions/:id/execution    { status: executed|failed, result?, error?, by? }
POST   /api/v1/triggers                    (same body as the Connector trigger; for channel bridges)
GET    /api/v1/events?after=EVENT_ID[&types=a,b][&limit=N]
GET    /api/v1/watchdog
PUT    /api/v1/watchdog
POST   /api/v1/watchdog/check
GET    /api/v1/orchestrations
GET    /api/v1/orchestrations/:id
POST   /api/v1/history/clear
```

`POST /api/v1/commands` 至少包含 `worker_id` 和 `input`，可关联 `task_id`、`kind`。创建 Task 时可以同时指定负责人；传入 `orchestrate: true` 时不指定初始负责人，由已启用的中央协调器规划。Connector 的 `task.create` 同样支持该字段，`orchestration.list` 用于受限的编排状态读取。

### Connector Local REST

```text
GET   /local/v1/health
GET   /local/v1/workers
POST  /local/v1/workers/register
POST  /local/v1/workers/unregister-current
POST  /local/v1/workers/:id/status
GET   /local/v1/orchestrations
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

# Feishu channel bridge beside the Hub (see 6.9); --observe only logs what it would do
agent-hub bridge feishu --config /var/lib/agent-hub/bridge/feishu.json [--once] [--observe] [--status]
agent-hub attention approve ATTENTION_ID

agent-hub connector \
  --hub-url http://127.0.0.1:8787 \
  --name mac-local \
  --data-dir .runtime/connector \
  --enroll-token <token>

agent-hub worker register \
  --runtime claude --session-id <已核实的真实ID> \
  --name backend-01 --cwd /path/to/project

agent-hub session start --runtime kimi --cwd /path/to/project
agent-hub session start --runtime claude --cwd /path/to/project
agent-hub session start --runtime codex --cwd /path/to/project

agent-hub worker register-current \
  --name current-session-role --cwd /path/to/project

agent-hub worker unregister WORKER_ID
agent-hub worker unregister-current

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

agent-hub task create --local --orchestrate \
  --title "需要协调多个 Worker 的总目标" \
  --goal "整体结果" \
  --acceptance "整体第一条验收\n整体第二条验收"

agent-hub orchestration list --local
agent-hub coordinator enable --worker-id worker_... --max-steps 4
agent-hub coordinator status
agent-hub coordinator disable
agent-hub history clear --yes

agent-hub list workers
agent-hub list tasks
agent-hub list commands
```

Admin CLI 从 `AGENT_HUB_URL` 和 `AGENT_HUB_ADMIN_TOKEN` 获取 Hub 地址与凭证；Worker CLI 和 `--local` 任务/命令操作从本地 Connector 数据目录获取 Local Token。`--wait` 只能与 `--local` 一起使用，由完成事件唤醒，默认最长等待 10 分钟；`waiting_manual` 和 `wait_timed_out` 都不是成功。`task update --local` 只允许修改状态，且任务必须分配给当前 Connector。模型与工具权限在对应交互 Session 中设置，Connector 不提供后台模型默认值。

### Agent Skill（公网分发与本机配套）

正式 Hub 匿名提供固定的 `GET /skill`、`GET /skill/SKILL.md` 和 `GET /skill/agent-hub.zip`。`src/skill-package.js` 只读取 `skills/agent-hub` 白名单中的 Skill、参考文档和接入脚本，以 Node 内置模块生成 ZIP，不读取数据目录或凭证。公开下载与管理 API 的鉴权边界互不影响。

`skills/agent-hub/SKILL.md` 为 Agent 提供首次接入、注册、自描述、状态回报和任务处理流程；`scripts/bootstrap.sh` 在 macOS 上检查公网 Hub 与依赖，默认将仓库安装到 `~/.agent-hub/agent-hub`，由用户在终端安全输入 Enrollment Token 完成首次 enrollment，然后安装 launchd Connector。重复执行幂等，已有未提交修改或冲突会停止，不自动注册 Worker，不修改 Tailscale 或其他 hooks。Kimi 与 Codex 共享 `~/.agents/skills`，Claude 使用 `~/.claude/skills`。本机安装器只创建链接，不复制凭证，也不覆盖已有文件：

```bash
node scripts/install-local.js --connector-data-dir .runtime/connector
```

安装器将 `agent-hub` CLI 链接到 `~/.local/bin`，并把当前 Connector 数据目录链接到 `~/.agent-hub/connector`。Agent 通过 CLI 使用 Local Token，不直接读取或打印凭证。安装前会检查本机 Connector 已连接到 Hub，已有冲突路径会停止安装。

显式调用方式：Kimi 在新 Session 中使用 `/skill:agent-hub`，Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。Claude 和 Codex 支持运行中发现 Skill 变更；未出现时重新打开 Session。Skill 不是常驻进程，启动即自动注册需要另配启动指令或 hook，不能覆盖已有 Orca hooks。

Skill 只登记可见交互 Session：通过 `agent-hub session start --runtime kimi|claude|codex` 打开客户端后，Claude/Kimi 使用启动器提供的 `AGENT_HUB_RUNTIME` 和 `AGENT_HUB_SESSION_ID`，Codex 使用自身注入工具进程的 `CODEX_SESSION_ID`，因此已有 Codex 窗口也能通过 `worker register-current` 登记本人，不需要手工填写 ID。所有 Worker 统一为 external；需要主动推送时必须接通 Runtime 对应 Channel。普通 Kimi 启动器会在打开 CLI 前关闭临时 Web Server；Kimi `--push` 使用单连接 ACP 或支持 `tui_channel` 的原生 TUI。缺少可信原生身份时不得随机生成或选择最近会话。Worker 的能力标签与 `metadata.description` 必须如实填写。

用户可以直接说“添加任务”“添加并执行”或“交给中央大脑”。普通任务由 Agent 从自然语言整理字段并选择本机 Worker；中央编排由管理员指定的协调者生成计划、Hub 校验后跨 Connector 调度。Worker 仍不能自主跨机互派。Agent 根据真实回执逐条核对验收，满足后才能更新为 `done`；失败、人工等待和等待超时都不能冒充成功。网页不提供任务编辑或调度表单；管理员通过中央对话安排工作，Agent 原有 Local Token 和 CLI 流程不变。

### Dashboard

主界面只有“操作台”和“任务看板”两个视图：

- **操作台**：中央对话与数字员工。关联任务以紧凑进展卡进入对话时间线；员工默认只显示一个状态、名称、一句简介和 `@`，点击条目展开能力、机器/Runtime、当前工作和实际输出。员工栏标题在内部滚动时固定。
- **任务看板**：按父任务归组，每个任务以 `#0001` 形式显示持久化 `task_number`，编号可用于 `@任务` 搜索；内部关联仍使用 `task_id`。默认显示全部并支持按状态筛选，卡片区分计划待启动、正在修正、正在验收、验收未通过和已完成。步骤显示执行轮次，上一轮结果与评审折叠保留。已完成详情优先展示完整交付正文、整体验收结论与复制操作，执行过程默认收起；进行中的详情仍展示目标、步骤和已返回证据。

主界面不设置宣传/教学文案、命令回执、事件流水或调度表单。交付使用 `public/markdown.js` 渲染常用 Markdown 结构，不再截断为 6000 字；Agent 原文先转义，原始 HTML 不执行，链接仅允许安全协议。支持单步和全部结果复制，保留完整原始返回。Enter 发送，Cmd/Ctrl+Enter 或 Shift+Enter 换行；每条消息可复制，Clipboard API 不可用时使用兼容复制路径。中央忙碌时待回复消息显示排队，旧版本留下的超长步骤汇报只在显示层收敛，不改写原始记录。

输入框的 `@` 提供可键盘操作的员工和任务选择器，保存结构化引用而不是把显示名当成身份。单独 `@员工` 提问或讨论时转交该员工本人回答，不创建任务；回复通过关联的 `worker_chat` Command 计算 `speaker`，页面和 `chat.updated` 显示真实员工名，并区分回复等待与忙碌排队。`@员工` 派活仍对后续计划的可选 Registry 和计划校验施加同一约束，模型不能改派其他 Worker；`@任务` 只补充真实任务/计划快照，仍遵守启动边界。未选择员工时继续按能力自动匹配。未接通、离线和协调者本人不作为主动派单目标。

Admin Token 仅保存在浏览器 `sessionStorage`，WebSocket 首条消息认证，不进入 URL。底层 Command/Event/API 继续用于审计与恢复。

`POST /api/v1/coordinator/chat` 接收 `{message, request_id, mentions?}`，其中 `mentions` 是最多 8 个 `{type: "worker"|"task", id}` 的去重引用。Hub 验证真实 ID 与 Worker 的可调度状态，持久化到对话（数据库 `user_version=5`），返回用户消息和回复；`request_id` 用于重试去重。回复处理及任务进展通过 `chat.updated` 主动推送给已认证的 Dashboard，直接问答的说话人来自实际 Worker Command，不新增数据库字段。只有 Admin 能读取或发送对话，Local/Connector API 不暴露此能力。

`DELETE /api/v1/coordinator/chat` 清空当前对话批次，不删除任务、命令、事件或内部来源关联。每条消息保存 `conversation_epoch`；清空时递增 epoch，API 和 `chat.cleared` 返回新 epoch，页面忽略旧 epoch 的迟到更新。对话历史及新对话上下文只读取当前 epoch，内部按 ID 查询和编排 @Worker 约束仍然有效。整体历史清理会重置 epoch。

对话模型只能提议四类受控动作：`chat`、`plan`、`orchestrate`、`start`。`plan` 在计划生成后保持 `ready`；`start` 只能启动已有 `ready` 计划，不重跑失败、评审或完成任务。模型不能直接写库、选择任意 API 或取得 Admin Token。回复与活动关联真实 Task/Command，重启后可恢复，失败和结果未知不会伪装成功。

管理员明确执行 `agent-hub history clear --yes` 时，Hub 先在数据目录的 `backups/` 创建一致性 SQLite 快照，再在一个事务中删除历史对话、编排、事件、命令和任务。Connector、Worker、协调者和凭证不变，Worker 的历史任务占用被清空。存在未结束 Command、pending 对话、进行中任务或未完成规划/终审时返回 409；已结束的 blocked/done 和带错误的历史 review 可清理。清理通过 `history.cleared` 通知页面刷新，不作为普通 Agent 的日常操作。

## 13. 安全边界

- 首次启动生成随机 Admin Token 和 Enrollment Token，写入 0600 凭证文件；也允许通过环境变量显式提供。
- Connector Token 和 Local Token 都是独立随机凭证。
- 协调者配置只能由 Admin 修改，Worker 自声明不会获得中央权限。协调器接收的 Registry 不包含 Token、会话私有状态或任意 metadata；模型输出始终作为不可信输入进行 Schema、Worker 和依赖校验。
- 每个编排最多 4 步，只有一次初始规划；终审拒绝后的自动修正最多两轮，且必须有明确失败步骤，下游随依赖失效并保留历史证据。父任务只有在全部步骤和整体验收都通过后才能完成，执行失败、证据不足和评审拒绝都不能冒充成功。
- 管理员对话仅支持 `chat`、`plan`、`orchestrate`、`start` 四类受限动作；计划与启动由 Hub 校验，模型不能自行扩权。`request_id` 和来源消息提供重试去重，对话历史仅向 Admin 开放。
- `@` 引用只接受 Hub 核验的真实 ID。指定 Worker 时同时约束规划器的 Registry 与返回计划的校验，不能只靠提示词防止改派；未接通和离线 Worker 不能冒充可推送。
- 历史清理要求 Admin 和显式确认，先备份再事务删除；有活动工作则拒绝，Connector/Worker 身份与凭证不在清理范围内。
- Hub 数据目录、Connector 数据目录和凭证文件不作为静态资源暴露。
- 正式公网 Hub 只监听服务器回环地址，由 Caddy 提供 HTTPS/WSS；不得直接开放 8787。公网安全组只需 80/443。
- TLS 加密不替代应用层认证；Admin、Connector 和 Local Token 仍分别校验，凭证文件保持 0600。
- Headscale 可用于服务器管理和可选私网备用通道；使用私网时应通过 Grants 限制节点与端口，不启用 Funnel。
- 不关闭 Kimi API 认证，不默认绕过 Claude/Kimi 权限。
- 所有执行结果记录来源 Connector 和 Worker，便于审计。

## 14. 公网部署与多机接入

正式拓扑是 AWS 单实例 Hub、Caddy 公网入口和各 Mac 的出站 Connector：

```text
Admin Browser ── HTTPS/WSS ─┐
                            ▼
                  Caddy :443 → 127.0.0.1:8787
                            │  AWS 单 Hub + SQLite
Mac Connector ──────────────┘
Mac Connector ──────────────┘
```

服务器使用 Amazon Linux 2023、隔离的 Node 24 LTS 和 `agent-hub-hub.service`。服务以无登录权限的 `agent-hub` 账户运行，代码在 `/opt/agent-hub/app`，正式数据在 `/var/lib/agent-hub/hub`。Hub 不保存模型账号；中央大脑是某台 Mac 上通过 Connector 接通交互 Channel 的 Worker，Hub 内置协调器负责状态机、权限和持久化。

Caddy 站点配置：

```caddy
hub.findu.work {
  reverse_proxy 127.0.0.1:8787
}
```

新 Mac 不要求 Tailscale，只需能访问公网 Hub：

```bash
curl --fail --silent https://hub.findu.work/healthz
read -s -p "Enrollment Token: " AGENT_HUB_ENROLLMENT_TOKEN; echo
export AGENT_HUB_ENROLLMENT_TOKEN
agent-hub connector \
  --hub-url https://hub.findu.work \
  --name <机器名> \
  --data-dir ~/.agent-hub/connector
```

首次 Enrollment 后，Connector Token 保存在本机，后续启动不需要 Enrollment Token。Worker Mac 不开放入站 Connector 端口；本地 API 继续只监听 `127.0.0.1:8788`。完整安装、Skill 和 Worker 注册步骤见项目 `README.md`。

迁移必须先确认无活动工作，停止旧 Hub 后用 `HubStore.backup()` 生成 SQLite 一致性快照。数据库与 `credentials.json` 一起迁移，以保留 Connector/Worker 身份和 Admin 登录状态；接收端校验 SHA-256、SQLite 完整性、记录数量与文件权限。凭证经加密管理通道传输，不能进入 SSM 参数、日志、聊天、Git 或公网对象存储。任何时刻只有一个 Hub 接收正式工作，旧目录与 Caddy 配置备份用于回滚。

本机开发仍可绑定 `127.0.0.1`。既有 Headscale 私网也可作为备用入口，此时显式绑定本机 Tailscale IPv4，Connector 改用对应私网地址；不要求为 Agent Hub 修改已有网络账号、DNS 或策略。

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

- 当前交互-only 架构：Connector 已删除后台 Runtime 执行路径，注册统一为 `external`；旧后台身份迁移后撤销 push 能力。中央协调者与自动编排员工均要求在线且 Channel 已接通。自动化通过真实 Hub、Connector、WebSocket 与 SSE 验证 external 大脑规划、依赖执行和终审，以及旧库/本地状态迁移、未接通等待、断线未知结果保护和注销恢复后的 Connector 关闭清理。关闭时会拒绝新 Channel 并清理残余本地连接，避免交互客户端重连竞态导致永久等待。
- 以下记录包含已退役后台架构的历史实测，仅用于审计和协议参考，不能作为当前接入指引。

- `pnpm test`：97 项测试全部通过，覆盖凭证、自注册、任务派发、Dashboard 事件、离线重放、命令去重、串行执行、崩溃恢复、Claude/Kimi/Codex 协议适配、Kimi ACP 单连接交互、Channel 回执与不完整结果标记、本机 Skill 安装器、Local 任务全流程、等待超时、跨 Connector 权限、CLI 布尔参数、当前 Session 启动器、中央编排、规划校验、执行失败和终审拒绝；包括管理员对话、只规划后启动、请求去重、Hub 重启恢复、旧库迁移、Worker 实况、未知结果保护及管理员聊天隔离；覆盖结构化 @ 引用、指定 Worker 不可改派、任务引用上下文、历史清理备份、活动工作保护、对话 epoch 清空及旧计划继续执行。新增直接依赖结果交接、长结果截断标记、@任务完整历史产物交接、不重跑原任务、运行中 Command 优先于后续排队命令、任务软删除和编排家族保护，以及交付 Markdown 结构、长文不截断和 HTML/危险链接防护。
- `pnpm check`：通过。
- 原生 Kimi TUI Channel：使用独立源码构建、隔离 Hub/Connector、全新 Session 和 tmux 真实 TTY，验证 `--native-tui` 通过 Unix Socket 将 Hub 命令送入原生 TUI，不启动第二个 Runtime。连续命令均返回真实结果；人工输入与 Hub 命令按序完成；原生权限面板批准 `pwd` 后返回正确工作目录；`--resume` 恢复原身份并继续执行；执行中关闭记录 `outcome_unknown=true`，未自动重放或伪装成功。
- 公网 Skill：验证固定下载路由、ZIP 一致性、标准解压与脚本执行权限，管理 API 和凭证路径不匿名开放。使用真实下载包、临时 HOME、独立 Hub/端口和模拟 launchctl 完成首次 enrollment、CLI/Skill 安装、重复运行和本地修改保护；未替换本机正在运行的 Connector。
- 真实 CLI 进程：使用独立测试凭证和 Test Driver 完成 `Hub → Connector → Worker 注册 → Task → Command → succeeded`，Dashboard 静态资源可访问。
- 真实 Chrome：使用临时浏览器 Profile 完成登录、创建任务、派发命令，确认实时连接、渲染结果和命令成功，无浏览器异常。
- Kimi 真实 smoke：在全新的隔离 Session 中，显式设置 `kimi-code/kimi-for-coding` 后返回 `AGENT_HUB_OK`。未显式设置模型时，本机新 Session 曾返回 `Model not set`，因此保留 Worker/环境两级模型配置。
- Claude 协议测试：验证首轮 `--session-id`、后续 `--resume`、`stream-json` 输出和结果解析通过。
- Claude 真实 smoke：原 Anthropic 账户不可用，已改用百炼 Token Plan；`ANTHROPIC_BASE_URL` 为 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`，主模型及 Sonnet/Opus/Haiku/Subagent 映射均为 `deepseek-v4.1-flash`。通过 `bl config agent` 使用本机 `BAILIAN_TOKEN_PLAN_KEY` 完成鉴权，未读取或输出密钥内容。2026-10-26 使用真实 `ClaudeDriver` 和全新隔离 Session 验证：首轮返回 `AGENT_HUB_OK`，同一 Worker 第二次通过 `--resume` 返回 `AGENT_HUB_RESUME_OK`，两次 Session ID 一致。此前 `bl text chat` 也已验证该模型可返回 `AGENT_HUB_BAILIAN_OK`；未以模拟进程结果替代真实调用。
- 本机三 Runtime 真实闭环：2026-10-26 使用独立 Hub/Connector 数据目录和随机回环端口，通过真实 Local REST、Admin REST、Connector WebSocket 与 Dashboard WebSocket 注册并触发 Claude、Kimi、Codex 三个 managed Worker。三者分别返回 `AGENT_HUB_CLAUDE_OK`、`AGENT_HUB_KIMI_OK`、`AGENT_HUB_CODEX_OK`；同 Worker 第二次命令分别返回对应的 `_RESUME_OK` 标记，原生 Session ID 均保持不变。六个 Command 全部 `succeeded`，三个 Task 均标记为 `done`，Dashboard 收到全部六个成功事件；重新打开 Hub 数据库后任务和命令结果仍可读取。Codex 使用本机已登录的 `codex-cli 0.164.0`、全新线程和只读沙箱，其稳定注册 ID 与原生线程 ID 按第 10.3 节分别保存。报告位于 `.runtime/local-triad-smoke/result.json`，不含访问令牌；测试后隔离服务已关闭。
- Agent Skill 与首批注册：2026-10-26 新增 `skills/agent-hub/SKILL.md` 和安全本机安装器，安装器测试覆盖软链接、真实目录、幂等和冲突不覆盖。实际安装到 Kimi/Codex 共享的 `~/.agents/skills` 与 Claude 的 `~/.claude/skills`，当前 Kimi 会话已识别并加载 Skill；`agent-hub` CLI 可从项目外目录使用。通过真实 CLI 在常驻 Connector 注册 `claude-agent-hub-01`、`kimi-agent-hub-01`、`codex-agent-hub-01` 三个新 managed Worker，均在线、空闲且 `push_capable=true`，能力标签和自描述已保存；本次仅注册，未额外调用模型。网页与 Connector 健康检查通过，未修改现有 hooks 或接管交互 Session。
- Agent 自然语言任务流：新增 Local Token 任务创建、命令派发与事件等待、验收后状态更新；Hub 对 Worker 和 Task 的 Connector 归属做服务端校验。自动化测试覆盖完整任务、超时后继续执行、external 立即返回人工状态、跨 Connector 拒绝、完成时间戳和 CLI 布尔参数。2026-10-26 通过当前 Kimi 按新版 Skill 流程选择 `claude-agent-hub-01`，不使用 Admin Token 或网页表单创建并执行任务，真实回执为 `AGENT_HUB_TASK_OK`，验收后任务更新为 `done`，Worker 恢复空闲。已打开的 Skill 调用如果缓存旧版，需要刷新或重新打开 Session。
- 当前交互 Session 接入：新增 `session start` 与 `worker register-current`，通过可信环境绑定当前原生 ID，未修改已有 hooks 或接管旧 Session。真实 smoke 使用隔离 Hub/Connector 和全新 Session：Claude 的启动器 ID、注册 ID 与 Hub 恢复 ID 完全一致，交互进程退出后显式选择 managed，返回 `AGENT_HUB_CURRENT_CLAUDE_OK`，任务验收后为 `done`。Kimi 首次暴露出 Web/CLI 对同一 Session 的排他占用，启动器已修正为在打开 CLI 前关闭临时 Server，随后原生启动和 ID 核对通过；当时当前 Session 默认 external，真实回执为 `waiting_manual`，未宣称支持当前 TUI 主动推送。后续交互推送改由 10.8 的单连接 ACP 窗口实现。
- 中央大脑：管理员启用独立 managed `kimi-coordinator-01` 后，通过真实 `--orchestrate` 创建两步依赖任务。协调者生成合法计划并选择 Claude 与 Kimi 执行 Worker，第一步返回 `AGENT_HUB_BRAIN_FIRST_OK`，第二步在依赖完成后返回 `AGENT_HUB_BRAIN_SECOND_OK`，终审全部通过，父任务和两个步骤均为 `done`。真实浏览器中的中央大脑视图已验证协调者、依赖、状态和评审原因，截图保存在 `.runtime/central-brain-dashboard.png`。排查并修复了 Kimi 的心跳、`session_event` 解包和持久化 Session 的 `not_found` 订阅问题：每次执行前 `:reload`，ACK 拒绝立即失败；早期失败和卡住记录保留为 `blocked`/`outcome_unknown`，未改写成成功。
- 中央对话工作台：2026-10-27 使用独立 Hub/Connector、测试凭证与可控执行器，通过真实 Chrome 验证管理员登录、默认中央页、对话只规划且无执行命令、确认后启动、任务归组、员工实时输出、终审展示、刷新后对话保留及 390px 窄屏；最新完成进展在对话视口内可见，无浏览器脚本异常。截图位于 `.runtime/ui-smoke/`，此结果验证页面与 Hub 流程，不代替真实模型验收。
- 真实 Kimi 对话闭环：2026-10-27 在隔离 Hub/Connector 中注册两个新的 managed Kimi Session，通过真实 Chrome 先请求只规划，确认计划为 `ready` 且没有执行 Command，再通过对话启动同一计划。执行 Worker 实际返回 `AGENT_HUB_CHAT_UI_OK`，单步与父任务终审均为 `done`；随后验证对话终审、任务状态、员工实际返回、刷新保留及窄屏。结果与截图位于 `.runtime/real-chat-smoke/`，未读写业务文件，未混入正式任务，隔离服务已关闭。正式 Hub 随后已按原 Tailscale 地址和原数据目录重启，健康检查通过，原凭证与 Worker 注册保留；尚未进行第二台 Mac 的跨机验收。
- 单页团队工作台：2026-10-27 使用全新隔离 Hub/Connector 和可控执行器，通过真实 Chrome 验证三个 Tab 合并为单页、@员工选择、键盘名称优先匹配、指定员工派单、员工实时状态、任务详情弹层、@任务引用不新建或执行工作、刷新保留及 390px 移动布局。external 的主动派单按钮不可用，浏览器无脚本异常；结果和截图位于 `.runtime/unified-ui-smoke/`。
- 真实 @员工闭环：2026-10-27 使用两个全新的隔离 managed Kimi Session，通过真实 Chrome @指定执行员工，实际返回 `AGENT_HUB_MENTION_UI_OK`。所有执行步骤都分配给所选 Worker，父任务与终审均为 `done`，对话刷新后保留，移动端无横向溢出。报告位于 `.runtime/real-mention-smoke/browser-result.json`，未混入正式任务，隔离服务已正常关闭。
- 单页正式部署与历史清理：2026-10-27 按原 Tailscale 地址和数据目录重启正式 Hub/Connector，迁移到 `user_version=4` 后通过 Admin CLI 创建清理前 SQLite 备份（`.runtime/hub/backups/`），删除 10 个历史 Task、15 个 Command、5 个 Orchestration、4 条对话及旧事件。原 4 位 Worker 均保留并恢复在线、空闲、可推送，协调者配置不变；当前任务、命令、编排和对话均为 0。Dashboard HTTP 200、未认证对话 401、Connector 连接正常，页面已在本机 Chrome 打开，原 Admin Token 未更换。
- 精简双视图与对话操作：2026-10-27 使用全新隔离 Hub/Connector 和真实 Chrome 验证操作台/任务看板两个视图、员工栏标题固定、紧凑员工与展开详情、Enter 发送、Cmd/Ctrl+Enter 换行、Clipboard API 与兼容复制、清空后旧 epoch 回复不回流、任务保留及 390px 移动布局。浏览器无脚本异常，报告与截图位于 `.runtime/compact-ui-smoke/`，临时服务由子进程启动器正常关闭。
- 精简工作台正式更新：2026-10-27 按原 Tailscale 地址和数据目录重启，数据库迁移到 `user_version=5`。未再次清空历史，现有对话与任务保留；4 位 Worker 均在线、空闲，协调者配置不变。两个视图、版本化静态资源、固定员工标题和复制功能检查通过，未认证清空对话返回 401，Connector 正常连接，精简页面已在本机 Chrome 打开。
- 任务过程与交付优化：2026-10-27 在隔离 Hub/Connector 中通过真实 Chrome 验证只规划后按钮启动、两步执行、运行中 Command 优先展示、排队提示、完整交付、单步/全部复制、看板默认全部、@任务返回操作台、清空后旧回复不回流及移动端。详情按任务和阶段重置默认布局，同时保留当前阶段的手动展开状态。报告与截图位于 `.runtime/delivery-ui-smoke/browser-result.json`，无浏览器脚本异常。
- 万圣节实际任务复盘：核对正式 Codex 方案、Kimi 审核和中央终审，确认两步按依赖顺序完成且父任务为 `done`。将该任务的只读记录复制到隔离环境验证页面，方案全文、改进建议、表格和两份结果原文复制均一致；旧版超长步骤汇报仅在显示层收敛，正式数据未被修改。报告与截图位于 `.runtime/delivery-ui-smoke/fixture-browser-result.json`。
- 真实双 Runtime 交付闭环：2026-10-27 使用全新隔离 Codex/Kimi managed Session 和真实 Chrome，Codex 先返回《交付闭环》Markdown，Kimi 的后续 Prompt 直接包含完全一致的上游正文并完成审核，中央终审与父任务均为 `done`。验证了顺序、依赖正文逐字一致、`result_truncated=false`、结果页及完整复制；报告位于 `.runtime/real-delivery-smoke/browser-result.json`，未混入正式任务，隔离服务已关闭。
- 任务交付优化正式上线：2026-10-27 在原 Tailscale 地址和原数据目录重启正式 Hub/Connector，数据库保持 `user_version=5`。3 个 Task、1 个 Orchestration、7 个 Command、11 条对话及 4 位 Worker 均保留，员工在线空闲，协调者配置与凭证不变。Dashboard 和 Markdown 静态资源返回 200，未认证清空对话仍返回 401，Connector 连接正常；已重载现有 Chrome 中控页。未清理历史、未新增正式任务或修改 Worker 注册。
- Codex 当前 Session 原生注册：2026-10-27 使用真实 `codex-cli 0.164.0` 工具进程核对 `CODEX_SESSION_ID` / `CODEX_THREAD_ID` 与 `thread.started` 完全一致。通过 `session start --runtime codex` 启动的真实 Codex exec，以及不带启动器身份的真实 Codex exec，分别由 agent 自己执行 `worker register-current`，两条路径在隔离 Hub/Connector 均注册成功：原生 ID 逐字一致、`runtime=codex`、`mode=external`、`push_capable=false`、`interactive=true`，身份来源分别为 `agent-hub-session-launcher` 与 `codex-native-runtime`。报告位于 `.runtime/codex-current-smoke/native-launcher-result.json` 和 `native-existing-result.json`。测试使用独立临时目录并显式允许该次沙箱网络访问，未修改正式 Worker 权限、正式任务或正式注册；隔离服务和临时 Codex Session 已清理。真实交互 TUI 不通过模拟键盘结果验收，第二台 Mac 的现有交互窗口仍需在该机器上实际确认。
- @员工直接问答：2026-10-27 新增持久化 `worker_chat`，单员工提问由本人回答，不创建任务，speaker 显示真实员工，明确派活仍走编排与终审。自动化覆盖原问题和 @任务上下文、非中央代答、失败/未知结果、重复完成与 Hub 重启不重复转交。可控执行器和真实 Chrome 验证忙碌排队、员工名、真实回复、刷新保留及移动端，报告位于 `.runtime/direct-chat-smoke/browser-result.json`。真实 Kimi 协调者与 managed Codex 完成直接问答，员工本人返回 `DIRECT_QA_OK`，speaker 正确、Task 数为 0、存在真实 `worker_chat` 回执，报告位于 `.runtime/real-direct-chat-smoke/browser-result.json`；隔离服务已关闭，第二台 Mac 的页面实际复测仍由用户确认。
- @员工直接问答正式上线：2026-10-27 在确认无活动命令和 pending 对话后，按原 Tailscale 地址、数据目录和凭证重启正式 Hub/Connector。数据库保持 `user_version=5`，3 个历史 Task 和 6 位 Worker 保留，所有已登记 Connector 均在线，远程 managed QA 在线空闲且可推送，协调者配置不变。Dashboard 静态资源升级为 `v=7`，未认证对话仍返回 401；已重载现有 Chrome 标签页，未清理历史、重发 Token 或新增正式任务。
- Worker 软注销与恢复：2026-10-27 新增 `retired_at`、管理员撤下、Codex 原生自注销、活动工作保护和显式重注册恢复。自动化覆盖旧库迁移、重复撤下、协调者与活动工作保护、新命令/@拒绝、历史保留和身份恢复；真实 Chrome 验证员工立即消失、未发送 @清除、同 ID 恢复、刷新隐藏与撤下记录查询，报告位于 `.runtime/worker-retirement-smoke/browser-result.json`。第二台 Mac 的自注销与本地状态同步需更新后验证，不以管理员撤下代替跨机自注销验收。
- Worker 软注销正式部署与原 external 撤下：2026-10-27 先创建备份 `.runtime/hub/backups/pre-worker-retirement-2026-10-27T12-37-26-011Z.db`，确认无活动工作后按原地址和凭证重启，数据库迁移到 `user_version=6`。通过 `worker unregister worker_3ea75be5de22474bb16981355eb24a4c` 将原 external“有闲 QA · Codex”软注销，默认列表和 @已移除，原 Worker ID 与历史保留；managed“有闲 QA · Codex 执行”仍在线可调度。正式页面升级为 `v=8` 并重载，未删除任务或重发 Token。第二台 Mac 的自注销需更新仓库后复测。
- Tailscale/Headscale：2026-10-26 按用户明确要求启动现有 Tailscale，使用已保存的 Headscale 配置并保留非默认设置。Hub 已绑定本机 Tailscale IPv4 的 `8787` 端口，本机通过该私网地址完成健康检查和 Dashboard HTTP 200 验证；Connector 已重连，三个 managed Worker 均在线、空闲且可推送。未启用 Funnel，未修改 Headscale 服务端或 ACL，未访问其他机器；跨机注册仍需实际第二台 Mac 验收。公开文档不记录真实私网地址或凭证。
- Connector 断线自愈、版本握手与常驻服务：2026-10-27 实测 Node 内置 WebSocket 在握手无响应时永久停留 `CONNECTING`、在链路被静默丢弃时永久停留 `OPEN`，均不触发 error/close，与正式 Connector 两次「Hub 可达但不再重连」的现象一致。新增握手超时与应用层 heartbeat 看门狗、断线原因与重连日志、握手交换 git commit、只做 fast-forward 的自更新、launchd 服务安装（`service install|uninstall|status`）和 `agent-hub update`。自动化 68 项全部通过，其中可控 TCP 代理覆盖握手挂起、静默断链、旧 Hub heartbeat 兼容、版本不一致只处理一次和重启等待活动命令；去掉看门狗后两项重连用例按预期失败。自更新用临时 git 仓库覆盖快进、依赖变化安装、脏/分叉跳过和 Hub commit 未发布提示。
- 常驻服务兼容复核：2026-10-27 在保留上述设计的前提下，修复 launchd 丢失 Kimi/Codex 模型、自动更新开关和自定义 Local 端口的问题；plist 仅继承白名单非密钥配置。68 项自动化、语法/差异检查及 macOS `plutil -lint` 通过。此次仅更新本地代码与隔离验证，未重启正式 Hub、安装本机 launchd 服务或操作第二台 Mac。
- 任务编号与中央自动修正：2026-10-27 新增持久化 `task_number`（数据库 `user_version=7`）和最多两轮终审修正，失败步骤及其下游保留历史后重做，并关联每轮 review Command。72 项自动化、语法和差异检查通过；真实 Chrome 隔离验证编号搜索、两轮执行、依赖重做、历史证据和移动布局，报告位于 `.runtime/recovery-ui-smoke/browser-result.json`。正式任务 #0004 经两轮修正后，QA 使用完整转交的 28,219 字符材料完成实质审查，开发员工在临时 worktree 对 `720226893` 实跑 61 条测试（60 通过、1 跳过），父任务与两步终审均为 `done`；发现的问题和修复建议尚未落实到业务代码。正式页面升级为 `v=9` 并重载，部署前备份为 `.runtime/hub/backups/pre-task-recovery-2026-10-27T14-47-16-151Z.db` 与 `.runtime/hub/backups/pre-material-recovery-2026-10-27T14-56-50-391Z.db`，未清理历史或修改业务仓库。
- AWS 公网正式迁移：2026-10-28 将唯一正式 Hub 部署到 AWS `findu-staging-router`，systemd 以无登录账户运行，Caddy 提供 `https://hub.findu.work` 的 HTTPS/WSS，8787 仍只绑定服务器回环地址。空环境完成公网 Connector 握手与断线重连，本机和 AWS 各通过 72 项自动化及语法检查。确认无活动工作后停止旧 Hub，以 SQLite 一致性快照和原凭证迁移 3 个 Connector、8 个 Worker（含 1 个已撤下）、6 个历史任务、对话和中央协调者配置；迁移前后 ID、任务编号和凭证保持一致。三台 Mac 已改为 launchd 并通过公网重连，Mac mini 的旧 `com.xemaya.agent-hub.connector` 已禁用，避免双 Connector 抢端口。重启 AWS Hub 后三台均自动恢复在线；真实任务 #0007 由 Codex 返回 `AGENT_HUB_AWS_OK` 并经中央终审完成，直接 @Codex 返回 `AGENT_HUB_DIRECT_OK` 且未创建额外任务，Dashboard WSS 验证通过，结果位于 `.runtime/aws-migration/e2e-result.json`。迁移快照与原 Hub 数据目录保留用于回滚，未开放公网 8787、未修改 Headscale 账号或策略。
- Claude 交互窗口实时推送：2026-10-27 新增 `session start --push/--resume`、`agent-hub channel` MCP 服务、Connector SSE 接通与投递、`worker.channel` 协议和可推送 external 员工的 @/直接问答。自动化 74 项全部通过，覆盖 MCP 握手与工具、接通前 `waiting_manual` 不转推、投递与回执、重复回执拒绝、执行中关窗为 `outcome_unknown`、先开窗后注册、Connector 重启后重新接通、managed 拒绝接通和启动器参数。真实验证使用隔离 Hub/Connector（18787/18788）与 Claude Code 2.1.311 交互 TUI：启动器打开窗口、开发版 Channel 横幅出现、register-current 后 Hub 显示可推送，Admin 派发的命令以 `← agent-hub:` 送入窗口，Claude 调用 ack 与 report，命令 14 秒内 `succeeded`，结果 `CHANNEL_E2E_OK` 且 `delivery=channel`。首轮未在正文重申回执要求时，模型只在终端作答而未调用 report，因此改为每条消息附带回执提示。`--mcp-config` 提供的服务器会让横幅提示 `no MCP server configured with that name`，但不影响送达。隔离服务已清理，正式 Hub/Connector 未参与。
- Kimi ACP 交互窗口实时推送：2026-10-28 先实测共享 Web Server 虽能返回成功回执，但原生 TUI 只有手动 `/reload` 后才能看到外部结果，因此未把该路径当作交互验收通过；改为用户与 Hub 共用单条 ACP 连接，保留 Session 锁且不调用 `:takeover`。82 项自动化、语法和差异检查通过。真实 Kimi 2.3.3 ACP 窗口连续返回 `KIMI_ACP_CHANNEL_OK_1` 与 `KIMI_ACP_RESUME_OK`，三条 Hub Command 均 `succeeded`、`delivery=channel`、`outcome_unknown=false`；`--resume` 后原生 Session ID 不变，用户直接输入返回 `KIMI_ACP_MANUAL_OK` 且不产生额外 Hub Command。窗口退出后 `push_capable=false`，证据位于 `.runtime/kimi-acp-smoke/`，隔离服务已清理。
