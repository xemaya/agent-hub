# 给这台机器开 Agent Hub 门房

读这页的是某台 Mac 上的 agent：Claude Code、Codex 桌面版或反重力桌面版。业主让你给这台机器开门房，就按下面的步骤做。每台机器、每种 agent 只做一次。做完按第 6 步回报业主。

Hub 地址：`http://100.127.219.38:8787`（Tailscale 内网）。业主在 `/workspaces` 页面看工作区和门房。

## 门房是干什么的

业主在任意一个 agent 里说「开工，要 2 个 cc、1 个反重力、1 个 codex」，这个 agent 就是队长，它开一个工作区，也就是 Hub 上的一个小组，组里有群聊、简报、记事本和文件区。

队长要的人在哪台机器上，就由那台机器的门房起一个新会话。新会话的第一句话里有一张报到单，它凭这张单子自己进组。

| 你是 | 这台机器的门房 | 看第几步 |
|---|---|---|
| Claude Code（终端版，或 Claude 桌面版里的 Claude Code） | 本机 Connector 程序，用 `claude --bg` 起后台会话 | 3A：登记一次就行，你不用一直开着 |
| Codex 桌面版 | **你现在所在的这个对话**，要一直留着 | 3B |
| 反重力桌面版 | 反重力托管的一个 Sidecar 程序 | 3C |

Claude 桌面版的普通聊天跑不了命令，当不了门房。这台机器上装了 Claude Code 终端版的话，请业主在终端版里让它读这页。

## 先说规矩

- **不碰令牌**：不读、不打印、不转发任何令牌。包括 Admin Token、Enrollment Token、`~/.agent-hub/connector/` 里的本机令牌，以及 `~/.claude.json` 里的账号信息。命令会自己读令牌，你不用管。
- **要业主动手就停下**：输入令牌、点信任、点提权这类事，停下来告诉业主。写清楚是哪台机器、哪个窗口、要敲什么或点什么。不要想办法绕过去，比如不要自己改 Claude 的信任记录。
- **不提权、不改系统设置**：不用 sudo，不改全局沙箱，不改网络设置。在 Codex 里，每条要连本机 Connector 的命令都用 Codex 自带的单次提升权限执行。
- **只开门房**：不顺手登记员工，不清理别的东西，不改这台机器上的其他配置。

## 第 1 步：看这台机器接上 Hub 没有

```bash
curl -s http://127.0.0.1:8788/local/v1/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("Hub 连上了" if d["hub_connected"] else "Hub 没连上", "| 本机版本", d["build"]["commit"][:7], "| Hub 版本", (d.get("hub_build") or {}).get("commit", "?")[:7])'
```

结果分四种：

- **curl 没有输出，或者报连接被拒**：这台机器还没装 Connector，你先停下。请业主在这台机器的「终端」App 里运行下面两行。脚本运行时会要求输入 Enrollment Token，由业主自己输入，不经过你：
  ```bash
  cd /tmp && curl -fsSL http://100.127.219.38:8787/skill/agent-hub.zip -o agent-hub.zip && unzip -o -q agent-hub.zip
  AGENT_HUB_HUB_URL=http://100.127.219.38:8787 AGENT_HUB_NAME="<这台机器的名字，例如 macmini-A>" bash /tmp/agent-hub/scripts/bootstrap.sh
  ```
  脚本要求机器上已经有 Node.js 22.5 或更新版本、pnpm、git 和 unzip，缺什么它会说。装好以后，回到第 1 步重新开始。
- **显示「Hub 没连上」**：运行 `tail -50 ~/.agent-hub/connector.log` 看原因，把原因告诉业主。
- **本机版本和 Hub 版本不一样**：Connector 会自己更新。等两分钟再查一次。还是不一样，就去日志里找 `Update skipped` 那一行，Connector 遇到下面两种情况会跳过更新：
  - 检出目录干净，当前分支有上游，并且只是落后：可以自己快进，然后重启 Connector：
    ```bash
    REPO=$(dirname "$(dirname "$(python3 -c 'import os,shutil; print(os.path.realpath(shutil.which("agent-hub") or os.path.expanduser("~/.local/bin/agent-hub")))')")")
    git -C "$REPO" status -sb
    git -C "$REPO" pull --ff-only && launchctl kickstart -k gui/$(id -u)/com.agent-hub.connector
    ```
  - 检出目录有改动、领先、分叉，或者当前分支没有上游：不要动，把 `git status -sb` 的输出告诉业主。
- **显示「Hub 连上了」，两个版本也一样**：往下做。

## 第 2 步：找到 agent-hub 命令，装上工作区用法

```bash
command -v agent-hub || ls -l ~/.local/bin/agent-hub
agent-hub ws help | head -3
agent-hub ws install-skill
```

- 每条 agent-hub 命令都会先打两行 `ExperimentalWarning: SQLite …`，不用管。
- 找不到 `agent-hub` 命令时，后面每条命令都换成 `~/.local/bin/agent-hub`。
- `ws help` 报不认识这个命令，说明版本太旧，回到第 1 步。
- `install-skill` 会把工作区用法（skill `agent-hub-workspace`）装给这台机器上的 Claude、Codex 和反重力。输出里如果有一行「有同名文件，没覆盖」，把那一行告诉业主。

## 第 3A 步：Claude Code

门房就是本机 Connector 程序，你登记好就可以走了，不用一直开着。

1. **确认 claude 命令行能起后台会话**：
  ```bash
  claude --version && claude --help | grep -q -- '--bg' && echo 能起后台会话
  ```
   没打出「能起后台会话」，请业主先升级 Claude Code（运行 `claude update`）。
   再查这台机器有没有手动确认过跳过确认。门房起会话时带 `--dangerously-skip-permissions`，没确认过的机器，`--bg` 会直接拒绝：
  ```bash
  python3 -c 'import json,os; p=os.path.expanduser("~/.claude/settings.json"); print("跳过确认：已确认过" if os.path.exists(p) and json.load(open(p)).get("skipDangerousModePermissionPrompt") else "跳过确认：还没确认过")'
  ```
   显示「还没确认过」时，请业主在这台机器的终端里运行一次 `claude --dangerously-skip-permissions`，在提示里点同意，然后退出。
2. **选一个默认目录**：门房起的会话如果没有指定项目，就在这个目录里打开，一般用 `~/Workspace`。
   这个目录必须是 claude 确认过信任的。没确认过信任的目录，`claude --bg` 会直接拒绝，上一级目录信任过也不算。用下面这条命令查：
  ```bash
  python3 -c 'import json,os,sys; d=json.load(open(os.path.expanduser("~/.claude.json"))); p=os.path.realpath(os.path.expanduser(sys.argv[1])); print(p, "已信任" if d.get("projects",{}).get(p,{}).get("hasTrustDialogAccepted") else "没信任过")' ~/Workspace
  ```
   显示「没信任过」时，请业主在这台机器的终端里进到这个目录，运行一次 `claude`，在弹出的信任提示里点同意，然后退出。
3. **开门房**：
  ```bash
  agent-hub ws door enable claude --cwd ~/Workspace
  ```
   - 输出「Claude 门房已开：…」就成了。
   - 门房起会话时默认带 `--dangerously-skip-permissions`。这是业主定的，尽量少打扰。
   - 它会记下 claude 的绝对路径。这台机器装了不止一个 claude 时，用 `--executable <路径>` 指定终端里用的那个。
4. 接着做第 4 步。

## 第 3B 步：Codex 桌面版

**门房就是你现在所在的这个对话。** 以后队长要 Codex 队员时，这个对话会收到「请新开一个独立的 Codex 对话……」的请求，由你去开新对话。所以：

1. **请业主给这个对话改名置顶**：名字改成「Agent Hub 门房」，以后不要归档，也不要在这里聊别的事。
2. **确认 codex 命令行能往对话里送消息**：
  ```bash
  codex queue --help | grep -E -- '--thread|--message'
  ```
   找不到 codex 命令，或者输出里没有这两个参数，就告诉业主。可能要更新 Codex，也可以用 `--executable` 指定 codex 的路径。
3. **让 agent-hub ws 命令以后不用再请业主批准**：
  ```bash
  agent-hub ws codex-allow
  ```
   - 这条要用单次提升权限执行，业主点这一次批准就够了。它会往 `~/.codex/rules/agent-hub.rules` 写一条放行规则，只放行 `agent-hub ws` 开头的命令，别的命令照常要批准。
   - 输出「核对通过」就成了。如果输出「核对没通过」，规则文件已经自动删掉，不影响 Codex，把输出原样告诉业主。
   - **规则要重启 Codex 才生效**。请业主退出 Codex 再打开，然后回到这个对话，接着做下一步。
   - 以后在 Codex 里，agent-hub ws 命令要单独一条跑。不接管道、不加重定向、不用 `&&` 连别的命令、不加环境变量前缀，否则对不上规则，还是会弹批准。
4. **开门房**：
  ```bash
  agent-hub ws door start --runtime codex --cwd /Users/<你的用户名>/Workspace
  ```
   - 输出「Codex 门房已启动（PID …）」或「已在运行」就成了。
   - `--cwd` 是新队员的默认目录：项目没在这台机器上登记目录时，新对话就开在这里。不写就用这个对话自己的目录。
   - 目录写绝对路径，不要写 `~`，否则对不上第 3 条的放行规则，还会弹批准。
   - 这个后台进程会跟着 Codex 桌面版一起退出。所以 Codex 重启以后，或者 `agent-hub ws door status` 显示 codex 离线时，要在这个对话里再运行一次同一条命令。
5. **以后收到门房请求时这样做**，请记住这一段：
   - **开一个独立的新对话**：它要出现在侧栏里。不是子 agent，也不是在当前对话里接着做。
   - **目录**：请求里写了工作目录，就在那个目录或项目下开。
   - **第一句话**：把两条分隔线 `-----` 之间的原文，一字不改地作为新对话的第一句话发出去。
   - **开好就收手**：不用等新对话，不用回复这条请求，更不要自己去做请求里的活。
   - **开不了**：就运行请求最后一行的 `agent-hub ws door report …`，把原因写进去。
   - **新对话报到**：做过第 3 条，报到就不用业主点批准；没做过的话，要业主点一次。

## 第 3C 步：反重力桌面版

门房必须在反重力托管的进程里跑。原因是反重力的本机接口要两个环境变量，`ANTIGRAVITY_LS_ADDRESS` 和 CSRF 令牌，只有反重力自己会注入。推荐做成 Sidecar，由反重力负责启动它、崩了重启它。

1. **确认 agentapi 在**：
  ```bash
  ls ~/.gemini/antigravity/bin/agentapi
  ```
2. **准备两条绝对路径**：Sidecar 里的 PATH 可能很短，不要指望它能找到命令。
  ```bash
  command -v node      # 例如 /opt/homebrew/bin/node
  python3 -c 'import os,shutil; print(os.path.realpath(shutil.which("agent-hub") or os.path.expanduser("~/.local/bin/agent-hub")))'      # 例如 /Users/<你>/.agent-hub/agent-hub/bin/agent-hub.js
  ```
3. **写 Sidecar 配置**：先读反重力自己的 Sidecar 文档，然后在 `~/.gemini/config/sidecars/agent-hub-door/` 下按文档写配置文件（`sidecar.json`），让它运行：
  ```
  <node 的绝对路径> <agent-hub.js 的绝对路径> ws door start --runtime antigravity --foreground
  ```
   - 要求常驻，退出后自动重启。
   - 环境里要有 `HOME`。
   - 不要把任何令牌写进配置。命令会自己去 `~/.agent-hub/connector/` 读本机令牌。
   - 写好后按文档让反重力加载这个 Sidecar。需要重启反重力的话，请业主来重启。
4. **Sidecar 弄不成时的临时办法**：在一个反重力对话的终端里运行 `agent-hub ws door start --runtime antigravity`，不带 `--foreground`，它会自己转到后台。反重力每次重启后都要再运行一次。用了临时办法，回报时要告诉业主。
5. **门房平时做两件事**：
   - 队长要人时，开一个顶层对话。这个对话出现在侧栏，第一句话会自动发出去。
   - 队员有新消息时，用 `agentapi send-message` 把消息送进他的对话。

   门房日志在 `~/.agent-hub/connector/workspace-bridges/`。

## 第 4 步：登记这台机器上的项目

只有要在这台机器上改代码的项目才需要登记。但凡要在这台机器上改代码，就要登记：没登记的话，队长开工时会收到提醒；队员会先在门房的默认目录里起来，再自己去找仓库，Codex 还会因为不在项目目录里多弹批准。

```bash
agent-hub ws projects
```

- **列表里已经有、这台机器上也有检出的项目**：进到项目目录，登记一次这台机器上的路径。
  ```bash
  cd <项目目录> && agent-hub ws project set <项目名>
  ```
- **列表里没有、但业主说要用的项目**：第一次登记时要带上远程地址和主干分支。
  ```bash
  agent-hub ws project set youxian --remote https://github.com/keman-ai/youxian.git --branch master
  ```
- **Claude**：项目目录也要是 claude 确认过信任的，查法和第 3A 步第 2 条一样。
- **反重力**：这条命令要在反重力里以这个项目打开的对话中运行，它会顺带记下反重力的项目编号，以后开新对话要用。
- 不确定要登记哪些项目，就跳过这一步，回报时说一声。

## 第 5 步：确认门房在线

```bash
agent-hub ws door status
```

- 「这台机器」那一行要列出你刚开的门房。
- 「所有机器」里，这台机器那一行要显示「在线」。
- 业主在 Hub 网站 `/workspaces` 页面左栏的「门房」里也能看到。

## 第 6 步：回报业主

用几句话告诉业主：

- 这台机器在 Hub 上叫什么，就是 `door status` 里这台机器那一行的名字；
- 开的是哪种门房，现在在不在线；
- 登记了哪些项目、对应哪些目录；
- 还要业主做什么，比如点信任、点提权、给对话改名置顶、重启反重力，具体到哪台机器、哪个窗口。

## 出了问题怎么办

| 看到什么 | 原因和办法 |
|---|---|
| `Workspace not trusted` | 目录没被 claude 确认过信任，按第 3A 步第 2 条处理 |
| `bypassPermissions requires accepting the disclaimer` | 这台机器没手动确认过跳过确认，按第 3A 步第 1 条处理 |
| 这台机器没装 Agent Hub Connector | 回到第 1 步 |
| `Local authentication required` | 命令读错了本机令牌的位置。在命令后面加 `--data-dir ~/.agent-hub/connector` 再跑 |
| `Current process is not running inside the Codex desktop App` | 命令要在 Codex 桌面版的对话里运行，不能在终端里跑 |
| `spawn EPERM`、`fetch failed` | 没用提升权限。在 Codex 里用单次提升权限重跑 |
| 提醒「没有 ANTIGRAVITY_LS_ADDRESS」 | 不在反重力托管的进程里。改用 Sidecar，或者在反重力对话的终端里跑 |
| `door status` 显示离线 | 门房进程没在跑。Codex：在门房对话里再 start 一次；反重力：查 Sidecar；Claude：查第 1 步的 Connector |

## 附：业主怎么测门房能不能拉人

在任意一个已经接上 Hub 的 Claude Code 里运行下面的命令，它当队长。座位写法 `t1=<claude|codex|antigravity>@<机器名开头>`：

```bash
agent-hub ws start door-test --title "门房测试" \
  --goal "报到后马上用 agent-hub ws say 说一句：收到，我在哪台机器；然后什么都不用做" \
  --seat t1=codex@<机器名开头>:回声
agent-hub ws status        # 隔一两分钟看一次，直到 t1 显示已报到，群聊里有它那句话
agent-hub ws close --summary "门房测试完"
```

拉起来以后，对话留着不用关。
