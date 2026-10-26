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

### 5. 注册 managed Worker

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

打开 `http://<中控TailscaleIPv4>:8787/`，输入中控的 Admin Token。可以创建任务、分配 Worker、发送命令并查看实时回执和事件。

**登记当前交互 Session 是另一种操作：** 使用 `--mode external` 和真实原生 `--session-id`。external 不会被伪装成可推送 Worker；无法确认 Session ID 时不要随机生成，也不要使用 Codex `--last`。新建 managed Worker 不代表发起注册的当前窗口。

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
- 不包含自动匹配 Worker、自动拆任务、自由群聊或 Worker 自主互派。
- Hub 的 HTTP 传输位于 Tailscale 加密私网内，但仍必须使用 Admin/Connector/Local Token，并建议通过 Headscale Grants 限制可访问节点和端口。
- 不启用 Funnel，不默认放开模型工具权限，不把 Runtime 数据目录或凭证作为网页静态资源公开。
