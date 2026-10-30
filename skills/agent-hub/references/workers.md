# 数字员工身份与推送

## 当前交互 Session

在目标项目目录打开：

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
agent-hub session start --runtime claude --cwd /path/to/project
agent-hub session start --runtime codex --cwd /path/to/project
```

在打开的窗口中说明职责，再用 `worker register-current`。启动器不提前注册或创建任务。Kimi 使用原生 Session ID，Claude 使用启动器 UUID，Codex 使用原生工具环境中的 `CODEX_SESSION_ID`；已有 Codex 窗口也可直接登记。Runtime 原生参数可放在启动命令 `--` 后。

当前窗口统一登记为 external。缺少启动器变量或 Codex 原生变量时，不能使用随机 ID、最近会话或另一个 Session 冒充。只有可信 Runtime 或用户明确提供的真实 ID 才能通过以下方式登记旧窗口：

```bash
agent-hub worker register --runtime kimi --session-id "<真实ID>" \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --name "<职责名称>" --cwd "$PWD"
```

登记不等于可推送；必须接通对应的交互 Channel。

## Claude Channel

```bash
agent-hub session start --runtime claude --push --cwd /path/to/project
agent-hub session start --runtime claude --push --resume <session-id> --cwd /path/to/project
```

在窗口中执行 `register-current`。Channel 接通后，命令以 `<channel source="agent-hub" command_id="...">` 到达；先调用 `agent_hub_ack`，完成工作后调用 `agent_hub_report` 返回完整结果，每个 command_id 一次。终端文字不会自动回传。首次启动选择“本地开发”，权限确认仍在终端处理。关闭窗口会退回 `waiting_manual`。

## Kimi ACP 或原生 TUI

```bash
agent-hub session start --runtime kimi --push --cwd /path/to/project
agent-hub session start --runtime kimi --push --resume <session-id> --cwd /path/to/project
```

ACP 是轻量交互窗口，不是原生全屏 TUI。正常回答即可，桥接自动回执；用户输入与 Hub 命令串行使用同一条连接。`/exit` 退出后退回 `waiting_manual`，不接受 `--` 后的 Runtime 参数。

如果当前 Kimi 构建明确支持实验性 `tui_channel`，可增加 `--native-tui` 打开真正的原生 TUI。Hub 通过本机 Unix Socket 进入原生发送队列和审批面板，不启动 ACP；启动器自动开启实验开关。不要用未支持该能力的版本强行尝试，也不要与 ACP 同时启动。自定义构建通过 `AGENT_HUB_KIMI_EXECUTABLE` 指定，不替换用户已有二进制。

## Codex 桌面原生队列

在当前聊天中使用 `worker register-current --push`（或 `desktop attach --push`）。桥接调用现有 `codex queue --thread <CODEX_SESSION_ID> --message ...`，不启动另一个 App，不重启桌面，不在另一进程恢复当前模型线程。

收到命令后按消息中的参数数组调用 `desktop report --command-id ... --status succeeded|failed`，结果从 stdin 传入。回执必须在收到指令的真实原生会话中提交；只在桌面回答不会回传 Hub。入队成功只是接受投递，必须核对最终回执；超时、断线、回执不明都不得重投。桥接持久化每个 command_id，回执核对原生会话并保护重复调用。桌面进程退出后通道关闭。

Skill 只是操作说明，不能绕过桌面权限或代替 Connector 和桥接保持连接。登记、`worker list` 和回执是分别授权的本机命令，直接为每条命令使用 Codex 工具自带的单次提升权限，不必先等待 `spawn EPERM` 或 `fetch failed`。不要 sudo、修改全局沙箱、切换终端或改用后台 Worker。回执需要访问本机 Connector，登记成功不代表后续命令可以不加权限地执行。

登记后保存返回的 `worker_id`，核对 `presence=online`、`push_capable=true`、`desktop_bridge=ready`，并用同一数据目录的 `worker list` 复核。登记成功但列表失败时，保留登记结果并报告原始错误，不能仅凭列表错误口述未接入。只在桌面回答不会提交 Hub 回执；回执结果不明时不要重复执行或重投任务，应先核对 Hub 的真实命令状态。

## Worker 通信录与直连

`worker directory` 使用当前原生 Session 获取同一 Hub 内其他未注销 Worker 的脱敏目录；普通工作指令也会收到当次目录快照。目录可用于选择真实 `worker_id`，但不能从中获取 Session ID、cwd、完整 metadata、任务上下文或凭证。

```bash
agent-hub worker directory --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
agent-hub message send --to WORKER_ID --prompt "<请求>" --wait \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
agent-hub message wait COMMAND_ID --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

消息经过 Hub 的持久化 Command 路由，不经过中央大脑。Hub 根据 Connector 和原生 Session 确定发送方，接收方看到核验后的 sender；普通 `command.create` 和 Admin API 不能伪造 `worker_message`。发送方不能给自己发消息，也不能借此修改任务或获得 Admin 权限。

接收方完成当前 Command 的正常回执就是回复。`message send --wait` 与 `message wait` 由 Hub 完成事件唤醒；已结束的结果可再次等待，不会重新执行。`wait_timed_out` 保留真实 command_id 和状态，不取消工作。断线、超时或结果不明时用原 command_id 再等待，不要重新发送；每个接收方仍串行执行。Codex 桌面逐条使用原生单次提升权限执行这些 CLI，不 sudo、不修改全局沙箱。旧 Connector 未声明直连能力时会返回明确错误，不会降级成来源不明的普通指令。第一版只支持单条请求/回复，不做广播或自动多轮对话。

## 状态与恢复

注册前核实：名称体现角色，`cwd` 是真实工作目录，能力和简介反映实际范围。同一 `runtime + runtime_session_id` 重复注册幂等，不要把同一身份分给多个员工。

```bash
agent-hub worker list --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

保存返回的 `worker_id`，不展示凭证。以实际 `presence`、`push_capable` 和 `work_state` 判断可调度性，不只看 Connector 在线。

状态真实变化时：

```bash
agent-hub worker status WORKER_ID working --task-id TASK_ID --data-dir "$HOME/.agent-hub/connector"
agent-hub worker status WORKER_ID idle --data-dir "$HOME/.agent-hub/connector"
```

也可使用 `waiting` 或 `blocked`，不能虚报。

只有用户明确要求撤下自己时才执行：

```bash
agent-hub worker unregister-current --data-dir "$HOME/.agent-hub/connector"
```

软注销保留任务、命令和原生历史，活动工作或当前协调者身份会拒绝；显式重新注册同一身份可恢复。普通 Agent 不得读取 Admin Token 或注销其他员工。
