---
name: agent-hub
description: 注册和管理 Agent Hub 数字员工。当用户要求把当前 Claude、Kimi、Codex Session 登记到中控、创建可调度的 managed Worker、查看 Worker 或回报工作状态时使用；不要用于普通编码或未经要求的自动注册。
---

# Agent Hub 数字员工协作

通过本机 Connector 注册 Worker、查询登记信息和回报状态。一个 Worker 对应一个明确的 Agent Session，不代表整台机器，也不代表某个 Agent 产品下的全部会话。

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

适用于用户要求“注册一个可由中控派发的 Worker”。不指定 `--session-id`，由 Driver 准备新的独立 Worker；第一条命令到达时才创建真实 Runtime Session：

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

也可以使用 `waiting` 或 `blocked`，但必须反映真实状态。不要为了看起来完成而伪造状态，不要自动把 Task 标记为 `done`。managed Worker 的运行状态主要由 Connector 回报。

只在需要时查询，不要启动循环轮询。Skill 不是常驻进程，也不负责启动即自动注册；如需自动启动注册，应另行配置明确的启动指令或 hook，不得覆盖已有 hooks。

当前版本不包含自动匹配 Worker 或 Worker 自主互派。不要通过读取 Admin Token 绕过权限边界；需要这些能力时应明确说明并实现相应 Hub 功能。
