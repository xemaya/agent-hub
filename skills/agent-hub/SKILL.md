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

只有用户明确要求**从零安装并接入一台新 Mac** 时，才按仓库 README 的“其他 Mac：接入已有中控”执行首次接入：

- `tailscale` 命令不存在时，先安装官方 Standalone App，或使用 `brew install --cask tailscale-app`；系统扩展和 VPN 授权由用户在 macOS 图形界面完成。
- 新机器使用管理员提供的地址执行 `tailscale up --login-server="https://<Headscale地址>"`，按浏览器流程登录。需要节点批准时，把注册信息交给管理员在 Headscale 服务端处理，不能假装已加入。
- 已有其他账号或控制服务器时，先报告 `ControlURL` 和账号列表，不要擅自切换、退出、重置或覆盖原网络。
- 必须通过 `tailscale status` 和 Hub 的 `/healthz` 验证，再安装 Connector、CLI 和 Skill。只克隆仓库或安装依赖不等于接入完成。

后续命令统一使用以下数据目录；CLI 会自行读取 Local Token：

```bash
--data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

不要打印、复制或提交 Local Token、Admin Token、Enrollment Token。Worker 操作不需要 Admin Token。

## 当前交互 Session：通过启动器注册（推荐）

当用户想“先开一个 Kimi/Claude/Codex Session，告诉它职责，再让它注册到 Agent Hub”时，使用启动器打开当前窗口：

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
# Claude Code 使用：
agent-hub session start --runtime claude --cwd /path/to/project
# Codex 使用：
agent-hub session start --runtime codex --cwd /path/to/project
```

启动器不注册 Worker、不创建任务。Kimi 使用 `kimi --session <id>`，Claude 使用 `claude --session-id <uuid>`；Codex 直接打开新客户端，不选择最近会话，真实 ID 由 Codex 注入其工具进程的 `CODEX_SESSION_ID` 提供，注册时读取。需要传递 Runtime 原生参数时放在 `--` 后。

在当前窗口中，用户说明职责后，使用可信启动器身份注册当前 Session：

```bash
agent-hub worker register-current \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --name "<体现职责的-worker-名称>" \
  --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<用户刚定义的职责与工作范围>"}'
```

Claude/Kimi 的 `register-current` 从 `AGENT_HUB_RUNTIME` 和 `AGENT_HUB_SESSION_ID` 读取启动器提供的身份；Codex 读取 Codex 注入工具进程的 `CODEX_SESSION_ID`，已有 Codex 窗口也可以登记。不需要用户填写 `--session-id`。当前交互窗口默认登记为 external，不伪装成可主动推送。不要手动编造或设置这些变量，不要另建 Worker 冒充当前窗口。

Claude 窗口若用 `agent-hub session start --runtime claude --push` 打开，注册为 external 后会自动接通中控：窗口开着时 `push_capable=true`，中控的任务以 `<channel source="agent-hub" command_id="...">` 送进本窗口。收到后先调用 `agent_hub_ack`，按普通请求完成工作，再用 `agent_hub_report` 交回完整结果，每个 command_id 只报一次；只写在终端里的内容中控看不到。窗口关闭后自动退回 `waiting_manual`。没有用 `--push` 打开的窗口不会收到推送，不要声称能收到。

只有用户明确要求主动执行，并确认当前交互实例已退出或 Runtime 明确支持共享时，才使用 `--mode managed`。Kimi CLI 与 Kimi Web Server 对同一 Session 有排他占用：当前 CLI 窗口打开时不要注册为 managed，也不要启动第二个 Web Server 接管它。Kimi 当前交互 Session 的主动推送需要共享 Web/ACP 桥接，不能用简单的 `--session` 代替。Claude/Codex 使用同一 ID 恢复时，也不要同时手动向该 Session 发另一条 Prompt。

如果 Claude/Kimi 当前窗口不是通过启动器打开的，或者缺少上述可信环境变量，不要假装它是启动器 Session；按下面的 external 边界处理，或建议用户下次通过启动器打开。Codex 缺少原生 `CODEX_SESSION_ID` 时同样不能注册，不要退回随机 ID 或最近会话。

## 默认选择：普通接入新建 managed

当用户说“接入 Agent Hub”“注册本机 Agent”“创建一个 Worker”，而没有明确要求登记“当前这个已有会话/窗口”时，一律创建 managed Worker，不走 external，不要求用户提供原生 Session ID，也不传 `--session-id`。Kimi 由 Connector 在注册时创建新的原生 Session；Claude/Codex 在首条命令到达时创建或恢复 Session。此时用户要的是新 Worker，不得以“不能冒充当前会话”为由拒绝或改用 external。

如果没有使用启动器，而用户明确要求登记“当前这个已有会话/窗口”，才使用 external 并要求真实原生 Session ID。

## 先区分两种身份

### 未通过启动器的当前交互 Session：external

适用于用户明确要求“把当前会话注册上来”，但当前窗口没有启动器提供的可信身份。必须使用当前会话的真实原生 Session ID：

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

external Worker 默认 `push_capable=false`，命令为 `waiting_manual`；只有通过 `--push` 启动器打开且窗口在线时才变为可推送。以 `worker list` 的实际 `push_capable` 为准，不要凭模式推断。登记当前 Session 不等于接管它。

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

## 撤下当前 Worker

只有用户明确要求“撤下自己”“注销当前 Worker”时，才执行：

```bash
agent-hub worker unregister-current \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

身份解析与 `register-current` 相同：Claude/Kimi 使用启动器身份，Codex 使用原生 `CODEX_SESSION_ID`。不要手工传 Session ID，不要用其他 Worker 代替，也不需要 Admin Token。

撤下是软注销，不删除任务、命令、事件或原生 Session。默认列表、`@` 和新命令都不再包含该 Worker；重复撤下幂等，显式重新注册同一身份可恢复。存在活动命令、进行中任务、未结束编排分配或当前协调者身份时会拒绝，不能强制撤下或擅自取消工作。管理员按 Worker ID 撤下使用 `agent-hub worker unregister WORKER_ID`，需要管理员授权，普通 Agent 不要读取 Admin Token。

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

最终向用户简要返回：`task_id`、`command_id`、负责人、命令状态、实际结果和验收结论。同页任务区与数字员工状态会自动更新，不要求用户在网页上补录。

## 交给中央大脑：全局规划与编排

当用户明确要求“交给中央大脑”“自动拆任务”“协调多个 Worker/机器”时，不要自己拆步骤或指定 Worker。改为整理总目标、上下文和父任务验收标准，使用 `--orchestrate`，不传 `--worker-id`：

```bash
agent-hub task create --local --orchestrate \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --title "<总目标>" \
  --goal "<整体结果>" \
  --context "<已核实的上下文>" \
  --acceptance "<整体第一条验收>\n<整体第二条验收>"
```

`--orchestrate` 会立即规划并执行，因此只在用户明确要求中央协调执行时使用；仅记录任务仍用普通创建。中央协调者负责选择 Worker、拆步骤和最终评审，不要再用 `send` 给父任务派发普通命令，不要手工关闭父任务。

管理员也可以在操作台与中央大脑对话：“先只规划，不要执行”会保存 `ready` 计划而不派发步骤，“开始执行”按钮或对话只启动已有的 `ready` 计划。输入 `@` 可点名 managed 员工或引用任务；单独 `@员工` 提问会转给该员工本人回答，不创建任务，回复显示员工名字；明确要求做事时才安排执行并继续终审。点击员工旁的 `@` 只带入输入框，不会立即发送。任务看板默认显示全部任务，完成详情优先展示完整交付和验收结论。网页对话需要 Admin Token；你持有的 Local Token 不能读取、发送或清空管理员对话，不要尝试绕过。Agent 的 Skill、CLI 和 Local Token 流程不变，不要代替用户在网页中输入。

需要向用户汇报进度时，按需执行一次：

```bash
agent-hub orchestration list --local \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

返回总任务、编排状态、步骤负责人、依赖和评审原因。不要循环查询。`blocked`、`review` 都不是完成；只有父任务和全部步骤符合终审结果时才报告 `done`。作为编排 Worker 收到步骤时，输入已经携带直接依赖及 `@任务` 引用的真实结果，优先直接使用，不需要自行查询上游；如果标记 `result_truncated` 或 `result_incomplete`，不能声称已完整阅读，证据不足要如实报告。

如果返回 `coordinator_disabled`，说明中央大脑尚未由管理员启用，不要退回到普通派发冒充中央编排，也不要自行获取 Admin Token。只有用户明确要求配置中央大脑时，才先注册一个独立的 managed 协调者 Worker，再由管理员通过 `agent-hub coordinator enable --worker-id ...` 启用；本地 Hub 可显式使用 `--hub-data-dir`，由 CLI 内部读取凭证，不能打印或转交 Token。

只在需要时查询，不要启动循环轮询。Skill 不是常驻进程，也不负责启动即自动注册；如需自动启动注册，应另行配置明确的启动指令或 hook，不得覆盖已有 hooks。

普通任务由 Agent 按上述规则选择本机 Worker；中央编排由管理员指定的协调者生成计划、Hub 校验并跨 Connector 调度。Worker 仍不能自主跨机互派，不要通过读取 Admin Token 绕过权限边界。
