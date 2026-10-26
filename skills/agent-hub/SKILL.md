---
name: agent-hub
description: 注册和管理 Agent Hub 数字员工，并通过自然语言添加任务、选择本机 Worker、派发命令、等待回执和更新任务状态。当用户要求登记 Claude、Kimi、Codex Session、创建 managed Worker、添加或执行任务、查看 Worker 时使用；与 Agent Hub 无关的普通编码不要使用，不要未经要求自动注册或执行。
---

# Agent Hub 数字员工协作

通过本机 Connector 注册 Worker、创建和跟进任务、查询登记信息和回报状态。一个 Worker 对应一个明确的 Agent Session，不代表整台机器，也不代表某个 Agent 产品下的全部会话。

## 先检查本机连接

```bash
curl --fail --silent http://127.0.0.1:8788/local/v1/health
```

如果失败，说明本机 Connector 不可达。报告这个问题，不要擅自启动第二个 Connector、修改网络配置或读取凭证文件。

后续命令统一使用以下数据目录；CLI 会自行读取 Local Token：

```bash
--data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

不要打印、复制或提交 Local Token、Admin Token、Enrollment Token。Worker 操作不需要 Admin Token。

## 默认选择：普通接入新建 managed

当用户说“接入 Agent Hub”“注册本机 Agent”“创建一个 Worker”，而没有明确要求登记“当前这个已有会话/窗口”时，一律创建 managed Worker，不走 external，不要求用户提供原生 Session ID，也不传 `--session-id`。Kimi 由 Connector 在注册时创建新的原生 Session；Claude/Codex 在首条命令到达时创建或恢复 Session。此时用户要的是新 Worker，不得以“不能冒充当前会话”为由拒绝或改用 external。

只有用户明确要求“登记当前这个已有会话/窗口”时，才使用 external 并要求真实原生 Session ID。

## 先区分两种身份

### 登记当前交互 Session：external

适用于用户明确要求“把当前会话注册上来”。必须使用当前会话的真实原生 Session ID：

```bash
agent-hub worker register \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --runtime claude \
  --mode external \
  --name "<有意义的-worker-名称>" \
  --session-id "$REAL_SESSION_ID" \
  --cwd "$PWD" \
  --capabilities "coding,review" \
  --metadata '{"description":"<当前会话的真实能力与工作范围>"}'
```

将 `claude` 换成实际的 `kimi` 或 `codex`。`$REAL_SESSION_ID` 只是占位符，必须由用户或可信的 Runtime 启动器提供。

如果无法确认真实 Session ID，停下来说明。不要生成随机 ID 冒充当前 Session，不要猜测 ID，不要使用 Codex `--last` 或“最近会话”。

external Worker 的 `push_capable=false`，命令为 `waiting_manual`。不要声称它能收到主动推送。登记当前 Session 不等于接管它。

### 创建独立可调度 Worker：managed

适用于用户要求“注册一个可由中控派发的 Worker”。不指定 `--session-id`，由 Driver 准备新的独立 Worker：Kimi 在注册时由 Connector 创建新的原生 Session；Claude/Codex 在第一条命令到达时创建或恢复 Session。无需用户提供当前原生 Session ID：

```bash
agent-hub worker register \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --runtime codex \
  --mode managed \
  --name "<有意义的-worker-名称>" \
  --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<该 Worker 的真实能力与工作范围>"}'
```

可将 Runtime 换成 `claude` 或 `kimi`。managed Worker 可以接收 Hub 主动推送，但它不是发起注册的当前交互窗口；用户要求登记当前 Session 时，不得用这种新 Worker 代替。

Kimi 需要明确模型时，在 metadata 中设置已确认的 `kimi_model`。Codex 默认使用 `read-only` 沙箱；只有用户明确允许工作区写入时才设置 `codex_sandbox:"workspace-write"`。不要虚构模型、工具或权限，不要启用危险绕过选项。

## 自描述要求

注册前确认并如实填写：

- `name`：体现角色或工作范围，不使用无法区分的默认名。
- `runtime`：实际的 `claude`、`kimi` 或 `codex`。
- `cwd`：该 Worker 的真实工作目录。
- `capabilities`：逗号分隔的真实能力标签，例如 `coding,review,analysis`。
- `metadata.description`：简洁说明适合的工作、已知模型或限制；不确定的信息不写。

同一个真实 `runtime + runtime_session_id` 的重复注册是幂等的。不要把同一个原生 Session ID 分给多个数字员工。

## 保存身份与状态回报

注册成功后保存返回的 `worker_id`，只向用户展示必要的 Worker 信息，不展示任何凭证。

查看本机 Worker：

```bash
agent-hub worker list \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

external Worker 接受任务后、状态真实变化时回报：

```bash
agent-hub worker status WORKER_ID working --task-id TASK_ID \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"

agent-hub worker status WORKER_ID idle \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

也可以使用 `waiting` 或 `blocked`，但必须反映真实状态。未核对验收标准时，不得把 Task 标记为 `done`。managed Worker 的运行状态主要由 Connector 回报。

## 添加任务：用户不需要填写网页表单

当用户通过此 Skill 要求“添加任务”“创建任务”或“添加并执行”时，由你整理字段并调用 CLI，不要求用户补填网页表单。

### 1. 查看本机 Worker 并选择负责人

```bash
agent-hub worker list \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

根据真实的 `capabilities`、`metadata.description`、Runtime、`presence` 和 `work_state` 选择适合当前任务的本机 Worker。需要主动执行时选择 managed；external 只能人工处理。不要编造 Worker ID，不要选择其他 Connector 的 Worker。当前没有合适 Worker 时，说明情况，不要假装已经派发。

### 2. 从用户原话整理任务

- `title`：简短、可区分，最多 300 字符。
- `goal`：要完成的结果，不添加用户没有要求的范围。
- `context`：只写用户提供的或已核实的事实、路径、约束；不要编造 commit、结论或凭证。
- `acceptance`：可检查、能判断通过与否的标准，每条一行。
- `assignee_worker_id`：上一步选择的 Worker；用户只要求记录且没有合适负责人时可以不分配。

创建任务：

```bash
agent-hub task create --local \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --title "<任务标题>" \
  --goal "<要达成的结果>" \
  --context "<已核实的上下文>" \
  --acceptance "<第一条验收>\n<第二条验收>" \
  --worker-id WORKER_ID
```

如果用户只说“添加”或“创建”，到此为止：返回 `task_id`、负责人和任务摘要，不自动执行。

### 3. 用户明确要求执行时才派发并等待

```bash
agent-hub send --local --wait \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --task-id TASK_ID \
  --worker-id WORKER_ID \
  --prompt "<结合任务目标、上下文和验收标准形成的明确指令>"
```

`--wait` 通过一次性完成事件等待，不需要也不允许循环查询。默认最长等待 10 分钟：

- `succeeded`：读取实际 `result`，逐条核对验收标准；进程成功本身不等于业务验收通过。
- `failed`：报告真实错误，不标记 `done`。
- `waiting_manual`：external 需要人工处理，不声称已主动执行。
- `wait_timed_out: true`：命令仍在执行，报告当前状态；不要把它当成成功或失败，不要重复派发同一任务。

### 4. 根据实际结果更新任务

只有结果满足验收标准时才关闭任务：

```bash
agent-hub task update --local TASK_ID --status done \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

未满足时保持真实状态并说明缺口；只有确实存在阻塞时才使用 `blocked`。本机任务更新只允许修改分配给当前 Connector 的任务状态，不能操作其他机器的任务。

最终向用户简要返回：`task_id`、`command_id`、负责人、命令状态、实际结果和验收结论。任务看板与命令回执会自动更新，不要求用户在网页上补录。

只在需要时查询，不要启动循环轮询。Skill 不是常驻进程，也不负责启动即自动注册；如需自动启动注册，应另行配置明确的启动指令或 hook，不得覆盖已有 hooks。

Agent 可以按上述规则为当前任务选择本机 Worker，但这不等于 Hub 内置智能调度模型，也不支持 Worker 自主跨机互派。不要通过读取 Admin Token 绕过权限边界；需要这些能力时应明确说明并实现相应 Hub 功能。
