# Agent Hub

轻量级的 Session 级 Agent 协作中控。每台 Mac 运行一个 Connector，每个独立的 Agent Session 对应一个数字员工 Worker。

支持 Claude Code、Kimi Code、Codex 的 managed Worker，以及已有交互 Session 的 external 登记。提供任务、上下文、命令回执、事件记录、断线重放和 Web 中控页面。命令通过 WebSocket 主动推送，Worker 不轮询收件箱。

## 组成

- **Hub**：统一保存 Workers、Tasks、Commands、Events，提供 Admin REST 和 Dashboard。
- **Connector**：每台 Mac 一个，主动出站连接 Hub，通过本地 API 接收 Worker 注册。
- **Worker**：独立数字员工。managed 可接收主动执行；external 用于人工协作，状态为 `waiting_manual`。
- **Agent Skill**：让 Claude、Kimi、Codex 知道怎样注册、自描述和回报状态。

详细设计与验证记录见 [`docs/design.md`](docs/design.md)。

## 前置条件

- Worker Mac：macOS、Node.js **22.5+**、pnpm。
- Hub：已在 Amazon Linux 2023 上验证；开发时也可在 macOS 运行。
- 使用 managed Worker 时，相应的 Claude、Kimi 或 Codex CLI 已安装并完成自己的模型鉴权。

本工具不会替代各 Runtime 的登录。公网接入不要求 Tailscale/Headscale，也不会自动修改已有网络配置。

## 其他 Mac：接入已有中控

正式 Hub 地址为 `https://hub.findu.work`。管理员使用其他部署时，以管理员提供的 HTTPS 地址为准。

### 1. 验证 Hub

```bash
curl --fail --silent --show-error --max-time 10 "https://hub.findu.work/healthz"
```

健康检查成功后再继续。Connector 只向 Hub 发起出站连接，Worker Mac 不需要开放入站端口，也不需要安装 Tailscale。

### 2. 克隆并安装依赖

```bash
git clone https://github.com/xemaya/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
```

### 3. 启动这台 Mac 的 Connector

Enrollment Token 由中控首次启动生成，保存在中控的 `.runtime/hub/credentials.json`。请通过安全方式取得，不要提交到 Git、发到公开群聊或写入公开文档。

在 Connector 终端中：

```bash
read -s -p "Enrollment Token: " AGENT_HUB_ENROLLMENT_TOKEN; echo
export AGENT_HUB_ENROLLMENT_TOKEN

node bin/agent-hub.js connector \
  --hub-url "https://hub.findu.work" \
  --name "<这台Mac的名称>" \
  --data-dir "$HOME/.agent-hub/connector"
```

首次注册后，Connector Token 会保存在本机权限为 `0600` 的状态文件中；以后重启不需要 Enrollment Token。保持该终端运行，另开终端继续。需要清理临时环境变量时，在对应 shell 中执行 `unset AGENT_HUB_ENROLLMENT_TOKEN`。

Connector 的本地 API 默认只监听 `127.0.0.1:8788`，其他机器不需要开放入站 Connector 端口。

#### 改为常驻服务（推荐）

首次注册成功后，先 `Ctrl+C` 停掉上面的前台 Connector，再安装为 launchd 服务：

```bash
node bin/agent-hub.js service install \
  --hub-url "https://hub.findu.work" \
  --name "<这台Mac的名称>" \
  --data-dir "$HOME/.agent-hub/connector"
agent-hub service status
```

服务开机自启、异常退出自动拉起，日志写入 `~/.agent-hub/connector.log`；plist 只记录地址、数据目录和非密钥运行配置，不含任何 Token。安装时会记下当前 shell 的 `PATH`，保证 managed Worker 能找到 `claude`、`kimi`、`codex`；已设置的 `AGENT_HUB_KIMI_MODEL`、`AGENT_HUB_CODEX_MODEL` 和 `AGENT_HUB_AUTO_UPDATE` 也会保留。自定义本地端口时在安装命令中传入同一个 `--local-port`。这些配置变化后重新执行一次 `service install`。卸载用 `agent-hub service uninstall`。

Connector 会自己维持连接：握手 20 秒内未完成、或已连接时 heartbeat 10 秒无应答，都会主动断开重连，不再依赖系统上报断线。

#### 版本握手与自动更新

Hub 与 Connector 在握手时交换各自的 git commit（`/healthz` 和 Admin `GET /api/v1/connectors` 也能看到）。发现与 Hub 不一致时，Connector 会 `git fetch` 并把自己的检出快进到上游；`package.json` 或 `pnpm-lock.yaml` 有变化时执行 `pnpm install --frozen-lockfile`。作为服务运行时，等正在执行的 managed 命令结束后自动重启加载新代码；前台运行时只提示手动重启。

只做 fast-forward：本地有未提交修改、领先或分叉于上游时不动代码，只在日志中说明原因。如果 Hub 运行的是尚未推送到 GitHub 的 commit，日志会提示先更新 Hub 机器。Hub 只触发更新检查，实际代码来自 Connector 本机配置的 Git upstream；该 upstream 属于信任边界，因为更新后会运行其中的新代码。开发检出或不允许自动变更的机器应通过启动参数 `--no-auto-update` 或环境变量 `AGENT_HUB_AUTO_UPDATE=0` 关闭自动更新。任何机器都可以手动执行 `agent-hub update`，Hub 更新后需重启 Hub 进程。

### 4. 安装 Skill 和全局 CLI

在 Connector 正常运行时，从克隆的项目目录执行：

```bash
node scripts/install-local.js --connector-data-dir "$HOME/.agent-hub/connector"
```

安装器会：

- 将 `agent-hub` CLI 链接到 `~/.local/bin/agent-hub`。
- 将同一份 Skill 链接到 `~/.agents/skills/agent-hub` 和 `~/.claude/skills/agent-hub`。
- 保留已经位于 `~/.agent-hub/connector` 的真实数据目录；如果 Connector 数据在别处，则创建指向它的链接。
- 重复执行保持幂等；遇到冲突文件时停止，不覆盖。

确保 `~/.local/bin` 在 `PATH` 中。若找不到 `agent-hub`，当前 shell 可先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 5. 注册 Worker

#### 方式 A：先开当前 Session，再注册本人

如果希望“先开一个 Kimi/Claude/Codex Session，告诉它职责，再让它注册”，使用启动器打开客户端：

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
# Claude Code 使用：
agent-hub session start --runtime claude --cwd /path/to/project
# Codex 使用：
agent-hub session start --runtime codex --cwd /path/to/project
```

启动器不提前注册或创建任务。Kimi 使用 `kimi --session <id>`，Claude 使用 `claude --session-id <uuid>`；Codex 直接打开新客户端，不选择最近会话，真实 ID 由 Codex 注入其工具进程的 `CODEX_SESSION_ID` 提供，注册时读取。Runtime 原生参数可以放在 `--` 后。

在打开的窗口里说明职责，然后调用 Skill：

```text
/skill:agent-hub 把当前 Session 注册到 Agent Hub，职责是……
```

Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。Agent 会执行 `worker register-current`，从启动器环境或 Codex 原生工具环境取得真实 ID，你不需要再提供 `--session-id`。重复注册同一个原生 ID 会复用 Worker。

当前交互窗口默认登记为 **external**，不会虚报主动推送。只有明确要求主动执行，并确认交互实例已退出或 Runtime 支持共享时，才使用 `--mode managed`。Claude/Codex 可以在交互进程退出后按同一 ID 恢复，但不要同时手动发送另一条 Prompt。普通 Kimi TUI 与 Web Server 不能实时共享输入；需要 Kimi 交互推送时，使用下面的 ACP `--push` 启动器。

#### 方式 A+：让中控直接把任务推进 Claude/Kimi 交互窗口

Claude Code 可以加 `--push` 打开，中控派来的任务和 @ 提问会直接出现在这个交互窗口里，Claude 做完后把结果交回中控：

```bash
agent-hub session start --runtime claude --push --cwd /path/to/project
# 带着已有上下文重新打开某个 Claude Session：
agent-hub session start --runtime claude --push --resume <session-id> --cwd /path/to/project
```

1. 启动时 Claude Code 会显示开发版 channel 的警告，选择 **I am using this for local development**。横幅里的 `no MCP server configured with that name` 可以忽略，消息照常送达。
2. 在窗口里按方式 A 注册为 external（`/agent-hub 把当前 Session 注册到 Agent Hub，职责是……`）；已注册过的 Session 再次打开会自动接通。
3. 窗口接通期间，该员工在中控显示为「交互会话 · 已接通」，可以 @ 和直接派活；关掉窗口后自动退回人工协作，新命令重新变成 `waiting_manual`。

送达的消息在终端显示为 `← agent-hub: …`，Claude 用 `agent_hub_ack` 和 `agent_hub_report` 两个工具回执（启动器已放行这两个工具，不会弹确认）。你在终端里可以随时插话或改方向。限制：

- 这是 Claude Code 的研究预览功能，需要 claude.ai 或 Console 登录；Team/Enterprise 组织要由管理员开启 Channels。每次启动都会弹一次开发版警告。
- 任务执行中关闭窗口，命令记为 `failed` 且 `outcome_unknown=true`，不会自动重跑。
- 工具权限确认仍只在终端里出现，暂未转到中控；中央大脑的自动拆解只派给 managed 员工，不会自动往你的交互窗口塞步骤。

Kimi 使用同一启动方式，已在 Kimi Code **2.3.3** 验证：

```bash
agent-hub session start --runtime kimi --push --cwd /path/to/project
agent-hub session start --runtime kimi --push --resume <session-id> --cwd /path/to/project
```

启动器打开的是轻量 **ACP 交互窗口**，不是 Kimi 原生全屏 TUI。用户输入与 Hub 命令共用一条 ACP 连接和同一个原生 Session，命令串行执行；正常回复由桥接自动回传，不需要模型调用回执工具。权限询问也在这个窗口处理。输入 `/exit` 退出，退出后自动退回 `waiting_manual`。该路径不关闭 Session 锁、不调用 `:takeover`，也不需要常驻 Web Server；Kimi `--push` 不接受 `--` 后的 Runtime 参数。

Codex 交互推送仍需要 app-server 适配。

未通过启动器打开的 Claude/Kimi 旧窗口仍需真实原生 Session ID 才能 external；现有 Codex 窗口则使用 Codex 注入工具进程的 `CODEX_SESSION_ID`。都不能猜测 ID、选择最近会话或手工伪造环境变量。

#### 方式 B：另建独立 managed Worker

如果只是需要一个独立、可调度的数字员工，而不是当前窗口本人，可以直接新建 managed Worker：**不需要提供原生 Session ID，不要传 `--session-id`**。Kimi 会在注册时由 Connector 创建新的原生 Session；Claude/Codex 在首条命令到达时创建或恢复 Session。

在目标项目目录执行，或把 `--cwd` 改成实际工作目录。名称、能力和自描述应反映真实情况。

Claude：

```bash
agent-hub worker register \
  --data-dir "$HOME/.agent-hub/connector" \
  --runtime claude --mode managed \
  --name "claude-mac02-01" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"本机 Claude Worker，承担编码、审查和分析。"}'
```

Kimi：

```bash
agent-hub worker register \
  --data-dir "$HOME/.agent-hub/connector" \
  --runtime kimi --mode managed \
  --name "kimi-mac02-01" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"本机 Kimi Worker，承担编码、审查和分析。","kimi_model":"kimi-code/kimi-for-coding"}'
```

`kimi_model` 应替换为本机已验证可用的模型，也可通过 Connector 的 `AGENT_HUB_KIMI_MODEL` 设置默认值。

Codex：

```bash
agent-hub worker register \
  --data-dir "$HOME/.agent-hub/connector" \
  --runtime codex --mode managed \
  --name "codex-mac02-01" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"本机 Codex Worker，默认只读沙箱。","codex_sandbox":"read-only"}'
```

Codex 未指定模型时沿用本机配置。只有明确允许工作区写入时，才将 `codex_sandbox` 改为 `workspace-write`；不要启用危险绕过选项。

查看这台机器的 Worker：

```bash
agent-hub worker list --data-dir "$HOME/.agent-hub/connector"
```

### 撤下 Worker 与恢复

当前 Agent 明确要求撤下自己时，使用与注册相同的原生身份：

```bash
agent-hub worker unregister-current \
  --data-dir "$HOME/.agent-hub/connector"
```

Claude/Kimi 使用启动器身份，Codex 使用原生 `CODEX_SESSION_ID`，不需要手工传 `--session-id`。普通 Agent 只使用 Local Token，不能撤下其他 Connector 的 Worker。

管理员可以按 Worker ID 撤下：

```bash
agent-hub worker unregister WORKER_ID \
  --hub-url "https://hub.findu.work" \
  --hub-data-dir .runtime/hub
```

撤下是**可恢复的软注销**：默认员工列表、`@`、调度候选和新命令都移除该 Worker，但 Task、Command、Event 和原生 Session 历史保留。活动命令、进行中任务、未结束编排分配或当前协调者身份会返回 409，不会强制取消工作。重复撤下幂等；之后显式重新注册同一 `runtime + runtime_session_id`，会恢复原 Worker ID 并清除撤下标记，Connector 重连或心跳不会自动恢复。管理员可用 `GET /api/v1/workers?include_retired=true` 查看撤下记录。旧版 Connector 需要更新仓库后才有自注销和本地撤下状态同步。

### 6. 使用 Skill 和中控页面

- Kimi：新 Session 中使用 `/skill:agent-hub`。
- Claude：使用 `/agent-hub`。
- Codex：使用 `$agent-hub`。

已有会话如果未发现新 Skill，重新打开 Session。Skill 是按需加载的说明，不是常驻进程；启动即自动注册需要另配启动指令或 hook。

#### 让 Agent 添加任务，不用填写网页表单

直接对 Agent 说自然语言即可，例如：

```text
/agent-hub 添加任务：审查 Connector 的断线恢复，整理目标和验收标准，先不要执行。
```

Kimi 使用 `/skill:agent-hub`，Codex 使用 `$agent-hub`，后面同样接自然语言。

只说“添加”时，Agent 会整理标题、目标、上下文和验收标准，根据本机 Worker 的能力与状态选择负责人，然后创建任务，不自动执行。明确要求“添加并执行”时，Agent 才会继续派发并等待结果：

```text
/agent-hub 添加并执行：让 Claude 返回 AGENT_HUB_TASK_OK。不要读文件或调用工具；结果符合后关闭任务。
```

Agent 使用本机 Connector 的 Local Token，不读取 Admin Token。等待结果由命令完成事件唤醒，不轮询；默认最长等待 10 分钟，超时只标记 `wait_timed_out`，不会取消执行或伪装失败。即使命令成功，Agent 也必须核对验收标准后才能将任务更新为 `done`。

也可以直接使用 CLI（Skill 会替你完成这些调用）：

```bash
agent-hub task create --local \
  --data-dir "$HOME/.agent-hub/connector" \
  --title "任务标题" --goal "目标" --context "已核实的上下文" \
  --acceptance "第一条验收\n第二条验收" --worker-id WORKER_ID

agent-hub send --local --wait \
  --data-dir "$HOME/.agent-hub/connector" \
  --task-id TASK_ID --worker-id WORKER_ID --prompt "明确指令"

agent-hub task update --local TASK_ID --status done \
  --data-dir "$HOME/.agent-hub/connector"
```

打开 `https://hub.findu.work/`，输入中控的 Admin Token。工作台有两个视图：

- **操作台**：中央对话与数字员工。员工默认只显示状态、名称、一句简介和 `@`，点击条目展开能力、当前工作和真实输出；栏目标题在列表滚动时保持固定。
- **任务看板**：每个任务显示稳定的 `#0001` 编号，默认展示全部总任务，可按状态或编号查找。卡片区分等待开始、正在验收、验收未通过和已完成，点击“查看结果 / 计划 / 进展”打开详情。

完成任务的详情优先展示完整交付正文和整体验收结论，支持 Markdown 阅读、单步复制和复制全部结果；执行过程默认收起。结果由 Agent 以不可信文本返回，页面不会渲染其中的原始 HTML 或危险链接。对话只保留简明进展和下一步，不用截断的执行日志代替交付。

已生成计划但尚未执行的任务提供“开始执行”按钮，仍通过中央对话启动同一份计划，不重新规划。详情中的“在对话中继续这个任务”会切回操作台并带入任务引用；后续 Worker 直接获得依赖步骤及引用任务的真实结果，内容有预算上限，截断或输出缺口会明确标记，证据不足不能通过终审。

Enter 发送消息，Cmd/Ctrl+Enter 或 Shift+Enter 换行。消息可以逐条复制；“清空对话”只隐藏当前对话批次，不取消任务或删除执行记录，后续新进展仍会显示。中央大脑忙碌时，新消息显示排队状态。

在输入框键入 `@` 后，用鼠标或方向键、Enter 选择员工或任务。单独 `@员工` 提问或讨论时，原问题会转给这位员工，回复显示员工本人的名字，不创建任务；明确要求做事时，Hub 将规划和执行限制在这位员工，不能改派他人，并继续经过任务终审。`@任务` 只引用真实上下文，不会自动启动、重试或修改任务；明确要求继续或修订时可以创建新工作，原任务保持不变。不点名员工时，中央大脑仍按能力和状态自动匹配。只有在线 managed Worker 可以被点名回复或主动执行，external 仍通过本机 Skill 人工协作。

网页不提供任务编辑或调度表单，业务输入统一从中央大脑的对话框进入。命令回执和事件仍保留在底层用于审计与恢复，但不在主界面展示。Local Token 只允许操作当前 Connector 的 Worker 和分配给他的任务，不能跨 Connector 任意派发或改状态，也不能读取管理员对话。

可以直接对中央大脑说：

- “现在大家在做什么？”——根据真实任务和 Worker 状态回答，不创建工作。
- “先只规划……，不要执行。”——生成计划并保持 `ready`，不会派发执行步骤；确认后直接说“开始执行”，按原计划启动，不重新规划。
- “安排合适的员工完成……，并核对结果。”——规划后自动执行，终审通过才标记完成。

对话和启动动作仅属于 Admin 网页会话。模型只能选择受控的问答、规划、编排或启动动作，由 Hub 校验和执行；它不能读取 Admin Token 或任意改库。`@` 使用服务端核验的结构化 ID，不是让模型猜测员工。Agent 原有的 Local Token、Skill 和 CLI 工作流程不变。

**登记当前交互 Session 是另一种操作：** 使用 `--mode external` 和真实原生 `--session-id`。external 不会被伪装成可推送 Worker；无法确认 Session ID 时不要随机生成，也不要使用 Codex `--last`。新建 managed Worker 不代表发起注册的当前窗口。

## 中央大脑

中央大脑由管理员明确指定一个 managed Worker 担任。它负责根据总目标和全局 Worker 自描述生成计划、选择负责人、拆解步骤，并在执行结束后审查证据。Hub 负责校验、依赖调度和状态变更，模型不能直接操作 Admin API 或数据库。

### 启用协调者

先注册一个独立 managed Worker（这里以 Kimi 为例）：

```bash
agent-hub worker register \
  --data-dir "$HOME/.agent-hub/connector" \
  --runtime kimi --mode managed \
  --name "kimi-coordinator-01" --cwd "$PWD/.runtime/coordinator" \
  --capabilities "orchestration,planning,review" \
  --metadata '{"description":"中央协调者：规划、拆解步骤并审查证据。","kimi_model":"kimi-code/kimi-for-coding"}'
```

然后由管理员启用，并限制每个计划最多 4 步：

```bash
agent-hub coordinator enable \
  --worker-id WORKER_ID --max-steps 4 \
  --hub-data-dir .runtime/hub

agent-hub coordinator status --hub-data-dir .runtime/hub
# 停用：agent-hub coordinator disable --hub-data-dir .runtime/hub
```

`--hub-data-dir` 让 CLI 在本地读取必要凭证，不打印 Token，也不需要你复制到聊天中。远程管理员可用 `AGENT_HUB_URL` 和 `AGENT_HUB_ADMIN_TOKEN` 代替。

### 交给中央大脑

直接对装好 Skill 的 Agent 说：

```text
/agent-hub 交给中央大脑：拆解并完成……；父任务验收是……
```

也可以直接使用 CLI，不要指定 `--worker-id`：

```bash
agent-hub task create --local --orchestrate \
  --data-dir "$HOME/.agent-hub/connector" \
  --title "总目标" \
  --goal "需要协调多个 Worker 完成的结果" \
  --context "已核实的背景与约束" \
  --acceptance "整体第一条验收\n整体第二条验收"

agent-hub orchestration list --local \
  --data-dir "$HOME/.agent-hub/connector"
```

`--orchestrate` 会立即规划并执行；如果只想先出计划，请使用管理员网页对话。规划与终审都通过特殊的持久化 Command 执行，支持去重、断线重放和恢复；执行 Worker 仍按原 Connector 权限接收命令。

- 一步能完成就不硬拆，最多 4 步，依赖不能成环。
- 命令成功后步骤先进入 `review`，终审明确通过才进入 `done`。
- 执行失败会进入 `blocked`；计划无效或证据不足会进入 `blocked` 或 `review`，不会自动完成。
- 每个编排只有一次初始规划，不自动扩写计划。终审明确不通过且能定位失败步骤时，中央大脑最多自动修正两轮：重做失败步骤及依赖其结果的后续步骤，保留上轮证据后再终审；仍不通过会明确停止并提示下一步。执行失败或无法定位修正目标时不盲目重试。
- 中控在同一个页面显示管理员对话、可 @ 的数字员工和按总目标归组的任务。任务详情在弹层中展示；对话、引用、关联任务和计划保存在 Hub，刷新后仍可查看。

### 清理历史，保留团队接入

只在管理员明确要求时执行：

```bash
agent-hub history clear --yes \
  --hub-url "https://hub.findu.work" \
  --hub-data-dir .runtime/hub
```

清理前会在 Hub 数据目录的 `backups/` 创建 SQLite 快照，命令返回备份位置与删除计数。它只清除历史任务、对话、命令和事件，保留 Connector、Worker、协调者与所有接入凭证；存在活动工作时会拒绝。它不是注销员工或重置 Hub，也不需要重新发 Enrollment Token。普通 Agent 不应主动执行清理。

### 协议兼容性

Kimi Driver 会在每次执行前通过官方 `:reload` 恢复持久化 Session 的活动状态，回复应用层 `ping` 的相同 `nonce` `pong`，解包 `session_event`，并处理 `turn.ended` 与 `prompt.completed`。订阅 ACK 返回 `not_found` 时会立即失败，而不是无限等待。`AGENT_HUB_KIMI_DEBUG=1` 可输出事件类型和 ACK 诊断（不含 Token），默认关闭。

## 部署中控

整个团队只运行一个 Hub，不要在每台 Worker Mac 上重复启动。

### 正式公网部署

当前 Hub 在 AWS `findu-staging-router`（Amazon Linux 2023）运行，中央大脑仍是本机 Mac 上的 managed Kimi Worker；服务器不需要模型账号或 Runtime 凭证。

- 代码与隔离的 Node 24 LTS：`/opt/agent-hub/app`、`/opt/agent-hub/node`。
- systemd：`agent-hub-hub.service`，以无登录权限的 `agent-hub` 账户运行，开机自启。
- 持久化：`/var/lib/agent-hub/hub`，数据库与凭证均为 `0600`。
- Hub 仅监听 `127.0.0.1:8787`，不对公网开放该端口。
- Caddy 将 `https://hub.findu.work` 反向代理到回环地址，并自动维护 TLS 证书；Connector 使用同一域名的 WSS。公网只需开放 80/443。

Caddy 站点配置为：

```caddy
hub.findu.work {
  reverse_proxy 127.0.0.1:8787
}
```

服务器管理通过 AWS SSM，不依赖开放 SSH。修改 Caddy 前备份 `/opt/caddy/Caddyfile`，先执行 `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`，通过后再 reload。Headscale 只保留为管理通道和可选私网，不是 Worker 接入 Hub 的前置条件。

```bash
systemctl status agent-hub-hub.service
curl --fail --silent http://127.0.0.1:8787/healthz
curl --fail --silent https://hub.findu.work/healthz
```

迁移或清理前确认没有活动工作，通过 `HubStore.backup()` 创建 SQLite 一致性快照，不能只复制仍在写入的 db/WAL 文件。数据库与 `credentials.json` 必须一起迁移，才能保留 Worker/Connector 身份和网页登录 Token。凭证不得出现在 SSM 参数、命令日志、聊天、Git 或公网对象存储中。切换期间保持单写者，旧 Hub 不得同时接任务。

### 本机或私网部署

开发时绑定回环地址：

```bash
node bin/agent-hub.js hub --host 127.0.0.1 --port 8787 --data-dir .runtime/hub
```

首次启动会生成 Admin Token 和 Enrollment Token，保护好数据目录。其他机器无法通过回环地址接入。使用既有 Headscale 私网时，可显式绑定本机 Tailscale IPv4，并让 Connector 使用该私网地址；不启用 Funnel，不修改现有网络账号或策略。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check
```

已验证真实 Claude、Kimi、Codex 的注册、任务推送、结果回传和会话续接。正式公网部署已完成三台 Mac 接入、Hub 重启自动重连、中央大脑派发与终审、直接 @Worker 问答和 Dashboard WebSocket 验收。

## 当前边界

- 不接管任意已打开的原生 TUI；managed Driver 在命令到达时创建或恢复独立 Runtime Session。Claude 交互推送使用原生 Channel，Kimi 交互推送使用启动器提供的 ACP 窗口。
- 未接通的 external Worker 只提供人工协作登记，命令为 `waiting_manual`；只有 `--push` 窗口在线时才可主动推送。
- 当前交互 Session 默认 external；主动执行不是向 TUI 模拟输入。普通 Kimi TUI 仍需通过 `--push` 改为 ACP 交互窗口，不能用第二个 Web Server 接管。
- 中央大脑需管理员显式启用，规划和终审都有边界；不包含无限重试、自由群聊或 Worker 自主跨机互派。普通任务仍可由调用 Skill 的 Agent 选择本机 Worker。
- 公网传输使用 HTTPS/WSS 和应用层 Admin/Connector/Local Token；TLS 不替代权限校验。不得把 8787 直接暴露公网，Headscale 可继续用于管理和私网备用通道。
- 不默认放开模型工具权限，不把 Runtime 数据目录或凭证作为网页静态资源公开。
