# Keman Super Agent Harness：总体架构梳理

状态：草稿（2026-11-01），供讨论；实现基线见 [design.md](design.md)，调研见 [research/deepseek-superagent.md](research/deepseek-superagent.md)。
范围：Agent Hub（控制面）、主控 + Worker 的分工、各个具体 agent 怎么接进来。youxian-qa 是第一个接入的 agent，后面的 agent 按同一张清单接。

## 1. 一句话定位

**Hub 是控制面，不是运行时。** 它记的是任务、岗位、命令、交接、事件这些事实；真正的执行发生在各台机器上，人只在决策点出现。一个具体 agent 不是一段常驻代码，而是「一个岗位 + 一个仓库里的流程和权限 + 几个事件源适配器」。

六条原则，后面所有取舍都从这里来：

1. **省人的注意力**：每条通知、每个确认都要值回它占的注意力；干活时安静，有结果、要决策、失败了才说话。
2. **执行可见、权限留在终端**：不自建 agent loop，不免审批执行；模型跑在 Claude / Kimi / Codex 的 Session 里，白名单由各仓的 settings 管。
3. **任务归岗位，不归会话**：Session 是座位，断了换人坐，交接包从任务自己的记录生成，不迁移会话记忆。
4. **至少一次投递 + 幂等键**：命令、trigger、飞书发送都有自己的幂等键，重复送达不重复做；结果未知就标未知，不冒充成功。
5. **确定性优先**：能用规则做的（路由、去重、gate、超时、交接）绝不花一次模型调用；模型只做规划、评审、研判、判断。
6. **外部输入不可信**：群消息、PR 评论、邮件只是上下文，不是授权；对外动作要经过 gate 或人。

## 2. 分层

```text
L0 事件源 Sources        飞书群 / 私信 · GitHub PR / CI · 定时任务 · 线上外部任务协议 · 人（Dashboard / CLI）
                          │  确定性 gate（谁能触发、在哪个群、是否 @）→ trigger(trigger_key, thread_key, role)
                          ▼
L1 控制面 Agent Hub      Task · Role / Seat · Handoff · Command · Attention · Trigger / Thread · Mail · Event
   （AWS 单实例）         确定性主控：路由快路径、岗位选座、交接、超时、幂等
                          模型主控：Coordinator（规划 / 终审 / 慢路径研判）、Watchdog（只判断不动手）
                          Dashboard / Admin API / CLI
                          │  出站 WSS，每台机器一个 Connector
                          ▼
L2 接入层 Connector      命令队列、ACK、重放、每 Worker 串行；Channel 适配 Claude / Kimi / Codex；本地 API 给同机工具用
                          │
                          ▼
L3 执行层 Workers        模型型 Worker：可见交互 Session（现在）→ 无头运行时（下一步，Hub 按岗位容量拉起）
                          确定性 Worker：LDH 这类不调模型的 harness，直接执行剧本，异常才交给模型型值守
                          │
                          ▼
L4 具体 agent            岗位 + 仓库（工作目录、AGENTS.md / skills、settings 白名单）+ 源适配器 + 回报与对外规范
                          youxian-qa（第一个）· ldh-watch 值守（第二个候选）· 以后：客服运营、发布值守……
```

每层只依赖下一层的接口，不依赖实现：Hub 不知道飞书，只认 trigger；Connector 不知道任务是什么，只搬命令；Worker 不知道谁在排队，只处理收到的指令并回报。

## 3. 主控与 Worker 的分工

### 3.1 主控分两半

| 半边 | 做什么 | 不做什么 |
| --- | --- | --- |
| **确定性主控**（Hub 代码） | 订阅直达（thread_key 快路径）、岗位选座和排队、交接与恢复、幂等去重、无活动超时、Attention 的生成与回答路由、事件审计 | 不猜意图、不改写内容、不替人决定 |
| **模型主控**（Coordinator / Watchdog，各是一个登记的 Session） | 没有订阅可走的消息研判、多步编排的规划与终审、运行中命令是否真在推进 | 没有 Admin 权限，输出当不可信输入过 Schema 校验；Watchdog 只能提醒和上报，不取消不重试 |

规则：**先快路径，后慢路径**。一条消息能按 thread_key 直达负责人就不进 Coordinator；进了 Coordinator 也只能给出受限动作（chat / plan / orchestrate / start），由 Hub 校验执行。

### 3.2 Worker 的契约

不管哪种运行时，一个 Worker 对 Hub 只有这几件事：

- **登记**：`register-current --role <岗位>`，报真实的 runtime、session id、工作目录、能力。岗位有 `workdir` 时目录不符不算座位。
- **收命令**：一次一件，串行；指令可能以【交接】或【恢复】开头，意思是「你没有前任记忆，先核对现场再做『本次要处理』」。
- **回报**：`ack` → 若干 `progress`（长任务必须，否则 60 分钟按丢失处理）→ `report(outcome, question)`；`needs_input / blocked` 变成 Attention 等人回答。
- **不直接对人说话**：对外的消息、帖子、提交走源适配器的「草稿 → 审批 → 发出」，或走各仓自己定的发布规则。
- **范围**：话题里的追问在任务范围内处理，超出范围的回报说明，不自作主张开新活（`HANDBACK`）。

模型型和确定性 Worker 的区别只在 L3：确定性 Worker（LDH）按剧本执行、把异常变成 trigger；模型型 Worker 接 trigger 做判断。两者都可以登记到岗位上，Hub 不区分。

### 3.3 人的位置

人只出现在四个点：开/关座位（现在是手动，下一步自动）、回答 Attention、审批对外动作、看 Dashboard 的「等你处理」。其余时间不应收到消息。

## 4. 一个 agent 怎么接进来：接入清单

每接一个 agent，按这张表填；youxian-qa 这一列是现状，用来对照。

| 项 | 要定什么 | youxian-qa 现状 |
| --- | --- | --- |
| **岗位** | `role_key`、`workdir`、`takeover_after_ms`、容量策略（最少几个座位、谁开） | `qa`，`youxian-qa`，3 分钟，手动开窗口 |
| **执行身份** | runtime、权限白名单（dontAsk + 显式 allow）、读写边界（哪些系统只读） | Claude 交互 Session；`.claude/settings.json` 白名单；线上只读，staging 可写 |
| **流程知识** | 仓里的 AGENTS.md / skills：收到什么指令按什么流程做、证据标准、回报格式 | AGENTS.md「群里 @ 的跟进」「项目测试」+ 4 个 skills |
| **源适配器** | 每个事件源：gate（谁、哪个群、是否 @）、`trigger_key` / `thread_key` 规范、确认回执怎么发、追问怎么跟 | `projecttest watch`：所有群 @、业主私信；`feishu:<话题 id>` / `feishu-dm:<消息 id>` |
| **对外动作** | 哪些动作要人审批、审批在哪里、谁能审批、幂等键 | 群回复草稿私信业主，回「发」才发；`--key` 幂等 |
| **产出去向** | 报告、看板、群消息、PR | 飞书任务清单看板、`projects/` 报告、MIS 展示 |
| **观测与通知** | 日志在哪、健康怎么看、什么事件要通知谁 | `watch.log`、`watch status`、Dashboard；Hub 后续事件不回飞书（缺口） |
| **容量与退化** | 座位用多久退役、上下文脏了怎么办、没座位时怎么办 | 无（缺口） |

接入的最小闭环验收：一个事件进来 → gate 通过 → Hub 建任务派到岗位 → Worker 回报 → 对外动作经审批发出 → 任务 done → 后续消息不再转发。youxian-qa 已跑通到「追问」之前，普通群的追问待线上验证。

## 5. 现状：哪些已经是 harness 的，哪些还长在 youxian-qa 里

| 能力 | 已在 harness（agent-hub） | 还在 youxian-qa 里（第二个 agent 会重复造） |
| --- | --- | --- |
| 任务 / 岗位 / 交接 / 排队 | ✅ schema 16 | |
| trigger / thread 订阅 / 幂等 | ✅ | |
| Attention（needs_input / blocked） | ✅ | 私信回答接不回原任务 |
| 进展上报 / 无活动超时 / 语义看门狗 | ✅ | |
| Coordinator 快路径 / 批处理 / 证据指针 | ✅ | |
| **飞书 Source**（群列表、@ 识别、话题轮询、私信） | | `watch.py` |
| **对外动作审批**（草稿 → 「发」 → 发出） | | `feishu.py` 本机文件 |
| **通知出口**（Hub 事件 → 飞书私信） | | 只有派发那一刻的私信 |
| **外部输入 gate**（内外群、发送人） | | 没有：所有群所有人 |
| **无头 Worker 运行时 / 自动开座** | | 没有：人开窗口 |
| **Source 健康**（watch 挂了谁知道） | | 没有 |

结论：**下一步的重点不是再给 Hub 加调度功能，而是把左下角这些从 youxian-qa 抽到 harness 层**。否则 ldh-watch 接进来时要再写一遍飞书轮询、再写一遍审批。

## 6. 第二个 agent 的落位（用来验证清单）

`desktop-agents` 里的 LDH 是确定性 Worker，`ldh-watch` 是模型型值守：

- 岗位 `ldh-watch`，workdir `desktop-agents`，座位是 mac mini 上的 Claude 会话（桌面版收不到推送，所以拉为主推为辅，这正是「座位能力不同」的第一个案例）。
- 事件源：LDH 的异常（任务 BLOCKED 超时、设备掉线）→ trigger，`thread_key = ldh:<task id>`；飞书值守群的 @ 复用飞书 Source。
- 对外动作：评论、私信作者这类要审批，走同一套草稿 → 审批。
- 产出：修复动作回 LDH，修不了的变 Attention 找人。

如果飞书 Source 和审批还在 youxian-qa 里，这一步就得复制代码；抽出来后只是配置。

## 7. 演进路线

**阶段 A（现在，QA 闭环）**：跑通普通群追问；修「审批记录在本机、私信回答接不回任务、外部群无门槛、Hub 事件不回飞书」这四个（见 2026-11-01 评审）。

**阶段 B（抽 harness 层）**：
- `feishu` Source 搬出 youxian-qa，放到 Hub 机器上常驻（或 agent-hub 仓的 `sources/`），配置化：哪些群、内外群策略、@ 规则、ack 文案。
- 审批变成 Hub 的一种 Attention（`needs_approval`，带草稿内容和幂等键），回答即发出；记录在 Hub，跨机可见。
- 通知出口：Hub 事件 → 渠道（先飞书私信），规则「只在需要人时说话」。
- youxian-qa 改成只剩流程知识和权限。

**阶段 C（容量）**：无头 Worker 运行时（仓里 `qa_brain.py` 的 `claude -p` 模式可复用，但要看订阅条款），Hub 按岗位最少座位数拉起；座位里程上限，到了就换；「忙」把人工使用也算进去。

**阶段 D（事件驱动）**：飞书事件订阅替代轮询；GitHub / CI 作为 Source；主动类规则先 observe 再 auto。

**明确不做**：自建 agent loop、免审批执行、多 Hub 多主、跨 Session 迁移记忆。

## 8. 已定的事（业主 2026-11-01）

1. **从 youxian-qa 里抽出通用框架**，以后类似的 agent 基于它实现，这是当前最大的问题。
2. **无头运行时允许用 `claude -p`，但尽量少用**：无头对人不可控。默认座位是可见窗口，无头只做岗位空座时的兜底，且一个命令一个进程、跑完即退，输出全部进 Hub。
3. **飞书 Source 放 Hub 那台机器上**，不再依赖业主的 Mac。

## 9. 抽取方案：渠道桥（bridge）+ 审批型 Attention

### 9.1 新增的通用部件

| 部件 | 放哪 | 做什么 |
| --- | --- | --- |
| **渠道桥** `agent-hub bridge feishu` | agent-hub 仓，Node，Hub 机器上一个 systemd 服务 | 一个渠道一个进程，同时负责**进**（群/私信 → gate → trigger）和**出**（Hub 事件 → 私信通知；审批通过的草稿 → 发到群）。直接调飞书 Open API（app id/secret 放 0600 凭证文件），不再经 lark-cli。状态（游标、已处理、话题订阅）放本机文件，幂等靠 `trigger_key` 和飞书 `idempotency-key`，所以重启、重跑都安全 |
| **Source 入口** `POST /api/v1/triggers` | Hub Admin REST | 桥用 Admin Token 投递 trigger（现在只有 Connector WS 能投）。响应里仍带 `waiting_for_seat / seats_busy` |
| **审批型 Attention** | Hub：`agent_hub_report` 新 outcome `needs_approval`，带 `action: { channel, kind, target, text, key }` | 「对外动作要人批」从各仓的本机文件变成 Hub 上的一条记录：Dashboard 可见、跨机可见、接手的座位能看到「前任已提交草稿等审批」。回答 `approve` / `reject` / 其他文字；approve 后由对应渠道桥执行并把发出的消息 id 回写到 Attention，其他文字当修改意见转回负责的座位 |
| **事件游标** `GET /api/v1/events?after=<id>` | Hub | 桥按游标拉事件做通知，重启不漏不重 |
| **通知规则** | 桥的配置 | 只在需要人时说话：`attention.created`（提问 / 阻塞 / 待审批）、`handoff.exhausted`、派发时没座位或全忙、桥自身出错超过 N 分钟。任务 done、交接成功这类不通知 |
| **gate 配置** | 桥的配置文件 | 每个群：`role`（派给哪个岗位）、`policy`（internal 群 `auto`；external 群 `confirm`，先私信业主「查不查」；或 `ignore`）、ack 文案；私信：哪些人是业主、业主私信派给哪个岗位 |

桥把话题原文（最近若干条，≤1,500 字 + 「还有 N 条」）直接写进 trigger 文本，追问照旧按 thread_key 直达。于是 **Worker 完全不需要飞书凭证**：读不用、写走审批。这是「对人可控」的硬保证，比白名单更靠得住。

### 9.2 youxian-qa 剩下什么

- 保留：AGENTS.md 的流程、4 个 skills、settings 白名单、`projecttest board`（看板是 QA 的业务）、08:00 / 10:30 两个定时任务（它们在 Mac 上直接发群，不走桥，先不动）。
- 改：「群里 @ 的跟进」第 3 步从 `projecttest feishu --draft` 改成 `agent_hub_report(outcome="needs_approval", action=…)`；读话题从 `projecttest watch thread` 改成看 trigger 里带的原文。
- 删：`projecttest/watch.py`、`feishu.py` 的 draft/approve/pending、launchd `ai.a2hmarket.youxian-qa.watch`、白名单里对应的 `projecttest watch/feishu` 条目。测试 `test_projecttest_followup.py` 的用例移到 agent-hub 的桥测试里。

### 9.3 顺序与切换

> 进度（2026-11-01）：1、2 已在 `huanghaibin` 工作区完成（Hub schema 17、`agent-hub bridge feishu`、191 条测试通过，`design.md` §6.9），待提交和部署；3 起要在 Hub 机器上放飞书应用密钥后进行。

1. Hub：`POST /api/v1/triggers`、事件游标、`needs_approval` Attention（schema 17）。单测 + smoke。
2. 桥：移植 watch.py 的逻辑（所有群、普通群话题轮询、私信、gate、ack、通知、审批执行），配置先只写问题反馈群 / FindU / 数字员工迭代三群。
3. Hub 机器部署桥，先 `--observe`（只记录「本来会做什么」、不回不派）跑一天，和 Mac 上的 watch 对账。
4. 切换：停 launchd watch，桥改正式；youxian-qa 按 9.2 改并提交。
5. 第二个渠道或第二个 agent 接入时只写配置，不写代码——这是抽对了的验收标准。

### 9.4 无头兜底（阶段 C，先设计不做）

- 岗位配置 `headless: never | fallback`，默认 `never`。
- `fallback` 的岗位：Hub 发现排队超过 `headless_after_ms` 且没座位，向岗位 `workdir` 所在、声明支持无头的 Connector 发 `seat.spawn`；Connector 以仓的 settings（dontAsk 白名单）起 `claude -p`，一个命令一个进程，stdout 进 Hub 的命令输出，结束即退、不复用。
- 对人可控的保证：每次无头执行在 Dashboard 和通知里明确标「无头」，对外动作照样过审批，白名单和可见窗口相同；业主随时可以把 `fallback` 关掉。

## 10. 仓库与文档的归属

| 东西 | 放哪 |
| --- | --- |
| 控制面、Connector、Source 适配器、审批、通知、无头运行时 | `agent-hub`（本文和 design.md） |
| 确定性桌面 harness | `desktop-agents/ldh` |
| 每个 agent 的流程、权限、用例 | 各自仓（`youxian-qa`、`desktop-agents/skills/ldh-watch`） |
| 跨仓的平台级决策 | `findu-docs/engineering/` |
