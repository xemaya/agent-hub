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

- macOS（当前验证环境），Node.js **22.5+**，pnpm。
- 多机接入时，各机器已安装并连接同一个 Tailscale/Headscale 网络。
- 使用 managed Worker 时，相应的 Claude、Kimi 或 Codex CLI 已安装并完成自己的模型鉴权。
- 中控机器的 Headscale 策略允许其他节点访问其 TCP `8787` 端口。

本工具不会替代各 Runtime 的登录，也不会自动配置 Tailscale 或 Headscale。

## 其他 Mac：接入已有中控

以下假设中控地址为 `http://<中控TailscaleIPv4>:8787`。在中控机器上执行 `tailscale ip -4` 可查看地址；用实际地址替换占位符，不要照抄尖括号。

### 1. 检查私网连通

```bash
tailscale status
curl --fail --silent "http://<中控TailscaleIPv4>:8787/healthz"
```

如果尚未加入自建 Headscale，请按自己的认证流程接入，例如：

```bash
tailscale up --login-server="https://<你的Headscale地址>"
```

已有非默认 Tailscale 设置时，按 CLI 提示显式保留，不要随意使用 `--reset`。不要使用 Funnel 暴露 Agent Hub。

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
  --hub-url "http://<中控TailscaleIPv4>:8787" \
  --name "<这台Mac的名称>" \
  --data-dir "$HOME/.agent-hub/connector"
```

首次注册后，Connector Token 会保存在本机权限为 `0600` 的状态文件中；以后重启不需要 Enrollment Token。保持该终端运行，另开终端继续。需要清理临时环境变量时，在对应 shell 中执行 `unset AGENT_HUB_ENROLLMENT_TOKEN`。

Connector 的本地 API 默认只监听 `127.0.0.1:8788`，其他机器不需要开放入站 Connector 端口。

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

如果希望“先开一个 Kimi/Claude Session，告诉它职责，再让它注册”，使用启动器打开客户端：

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
# Claude Code 使用：
agent-hub session start --runtime claude --cwd /path/to/project
```

启动器只绑定真实原生 Session ID，不提前注册或创建任务。Kimi 使用 `kimi --session <id>`，Claude 使用 `claude --session-id <uuid>`；Runtime 原生参数可以放在 `--` 后。

在打开的窗口里说明职责，然后调用 Skill：

```text
/skill:agent-hub 把当前 Session 注册到 Agent Hub，职责是……
```

Claude 使用 `/agent-hub`。Agent 会执行 `worker register-current`，从启动器环境取得真实 ID，你不需要再提供 `--session-id`。重复注册同一个原生 ID 会复用 Worker。

当前交互窗口默认登记为 **external**，不会虚报主动推送。只有明确要求主动执行，并确认交互实例已退出或 Runtime 支持共享时，才使用 `--mode managed`：Claude 可以在交互进程退出后按同一 ID 恢复，但不要同时手动发送另一条 Prompt；Kimi CLI 与 Web Server 对同一 Session 有排他占用，不能用第二个 Web Server 接管当前 CLI 窗口，当前交互主动推送需要后续的共享 Web/ACP 桥接。

未通过启动器打开的旧窗口仍需真实原生 Session ID 才能 external，不能猜测或选择最近会话。

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

打开 `http://<中控TailscaleIPv4>:8787/`，输入中控的 Admin Token。默认进入中央大脑，可以在三个视图之间切换：

- **中央大脑**：用对话询问情况、安排工作，右侧解释当前计划、负责人和实际进展。
- **任务**：按总目标查看中文进展、步骤、负责人和验收结论，不需要理解命令流水。
- **数字员工**：查看每个 Session 的职责、在线状态、当前工作和真实返回。

网页不再提供任务编辑或调度表单，业务输入统一从中央大脑的对话框进入。命令回执和事件仍保留在底层用于审计与恢复，但不在主界面展示。Local Token 只允许操作当前 Connector 的 Worker 和分配给他的任务，不能跨 Connector 任意派发或改状态，也不能读取管理员对话。

可以直接对中央大脑说：

- “现在大家在做什么？”——根据真实任务和 Worker 状态回答，不创建工作。
- “先只规划……，不要执行。”——生成计划并保持 `ready`，不会派发执行步骤；确认后直接说“开始执行”，按原计划启动，不重新规划。
- “安排合适的员工完成……，并核对结果。”——规划后自动执行，终审通过才标记完成。

对话和启动动作仅属于 Admin 网页会话。模型只能选择受控的问答、规划、编排或启动动作，由 Hub 校验和执行；它不能读取 Admin Token 或任意改库。Agent 原有的 Local Token、Skill 和 CLI 工作流程不变。

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
- 每个编排只有一次规划和一次终审，不自动重试或扩写计划。终审只根据返回证据判断，不虚构独立测试。
- 中控默认显示管理员对话和当前计划；任务视图按总目标归组，数字员工视图展示当前任务、阶段和真实输出。对话、关联任务和计划保存在 Hub，刷新后仍可查看。

### 协议兼容性

Kimi Driver 会在每次执行前通过官方 `:reload` 恢复持久化 Session 的活动状态，回复应用层 `ping` 的相同 `nonce` `pong`，解包 `session_event`，并处理 `turn.ended` 与 `prompt.completed`。订阅 ACK 返回 `not_found` 时会立即失败，而不是无限等待。`AGENT_HUB_KIMI_DEBUG=1` 可输出事件类型和 ACK 诊断（不含 Token），默认关闭。

## 部署新的中控

通常只需一台中控机器。不要在每台 Worker Mac 上重复启动 Hub。

在中控机器完成克隆和依赖安装后：

```bash
tailscale ip -4
node bin/agent-hub.js hub \
  --host <本机TailscaleIPv4> \
  --port 8787 \
  --data-dir .runtime/hub
```

首次启动会生成 Admin Token 和 Enrollment Token，并写入 `.runtime/hub/credentials.json`。保护好这个文件，不要提交或公开。

另开终端，按上面的 Connector 步骤启动本机 Connector，将 `--name` 改为本机名称，`--hub-url` 指向同一 Tailscale 地址。随后运行安装器：

```bash
node scripts/install-local.js --connector-data-dir "$HOME/.agent-hub/connector"
```

本机开发不使用 Tailscale 时，也可让 Hub 绑定 `127.0.0.1`，其他机器则不能通过该地址接入。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check
```

已验证真实 Claude、Kimi、Codex 的本机注册、任务推送、结果回传和会话续接。其他 Mac 的实际接入仍需按上述流程在对应机器上验证。

## 当前边界

- 不接管任意已打开的 TUI；managed Driver 在命令到达时创建或恢复独立 Runtime Session。
- external Worker 只提供人工协作登记，命令为 `waiting_manual`。
- 当前交互 Session 默认 external；主动执行不是向 TUI 模拟输入。Kimi CLI 与 Web Server 对同一 Session 有排他占用，当前 Kimi 交互主动推送需要共享 Web/ACP 桥接，尚未实现。
- 中央大脑需管理员显式启用，规划和终审都有边界；不包含无限重试、自由群聊或 Worker 自主跨机互派。普通任务仍可由调用 Skill 的 Agent 选择本机 Worker。
- Hub 的 HTTP 传输位于 Tailscale 加密私网内，但仍必须使用 Admin/Connector/Local Token，并建议通过 Headscale Grants 限制可访问节点和端口。
- 不启用 Funnel，不默认放开模型工具权限，不把 Runtime 数据目录或凭证作为网页静态资源公开。
