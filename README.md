# Agent Relay

Agent Relay 是支持多种 Agent 执行后端的本地研发编排工具。它将需求调查、设计、实现、独立审查和反馈修复组织为可恢复、有验收依据的工作流。

**当前状态：M2 本地研发闭环已验收；M3 持续协作与恢复能力已实现。** M3 提供需求/问题历史、受控进程跨服务停止核对、持久预算和副作用意图。默认服务仍使用模拟执行器；显式开发运行时使用 Codex CLI。真实运行仍限定 Windows；Linux 保留跨平台确定性回归。M3 真实业务候选尚未最终验收，已验证范围及剩余条件见 [M3 契约](docs/m3.md)；历史试点见 [M2 验收](docs/m2.md)。

## 产品边界

- 控制层管理任务、角色、交接、状态、预算、验证和 GitHub 交付。
- v1 通过子进程复用 Codex CLI 的上下文管理、工具循环与执行能力，生产适配器在 M2 接入。
- 后续 API Agent 运行时通过同一执行接口接入，内部管理模型请求、工具循环和上下文。
- 角色、执行后端、模型供应商、模型和权限分别配置。
- 咨询任务可以调查后直接回答；代码任务按实际复杂度经过设计、实现、审查和验证。
- 公开仓库存放源码、规范和脱敏样例；运行日志、凭据和任务代码不随工具仓库发布。

## 开发与运行

工具链固定为 Node **26.8.2**、npm **11.14.1**、TypeScript **5.9.3**；版本分别记录于 `.node-version`、`package.json` 和锁文件。使用内置 `node:sqlite`，无需另装数据库服务。文本换行由 `.gitattributes` 固定为 LF，Windows 检出同样遵守格式门禁。

```powershell
npm ci
npm run check
node dist/cli.js serve --data-dir .agent-relay/runtime
```

`npm run check` 执行严格类型检查、格式检查、构建和测试；`npm test` 也会先构建。测试包含真实的模拟子进程、进程树终止和服务强制终止，运行环境必须允许停止测试自身创建的进程。真实 Codex 实验不包含在默认测试中。

服务默认监听 `127.0.0.1:4318`。在另一个终端提交模拟任务：

```powershell
'验证模拟任务的状态与证据保存' | Set-Content -Encoding utf8 .agent-relay/task.txt
node dist/cli.js doctor --data-dir .agent-relay/runtime
node dist/cli.js task create --repo . --input .agent-relay/task.txt --key demo-001 --data-dir .agent-relay/runtime
node dist/cli.js task status <task-id> --data-dir .agent-relay/runtime
node dist/cli.js task events <task-id> --after 0 --limit 100 --data-dir .agent-relay/runtime
```

输出为 JSON。create 返回 `task.id`；同一个 `--key` 与相同请求可安全重试，内容不一致返回冲突。模拟任务的 `accepted: true` 只表示模拟证据完整；开发任务的 accepted 表示当前本地候选通过可信检查和独立审查，不表示已创建 PR 或合并。

变更命令使用 status 返回的 `task.version`：

```text
node dist/cli.js task pause <task-id> --version <version> --data-dir .agent-relay/runtime
node dist/cli.js task resume <task-id> --version <version> --data-dir .agent-relay/runtime
node dist/cli.js task cancel <task-id> --version <version> --data-dir .agent-relay/runtime
node dist/cli.js task answer <task-id> --version <version> --question <question-id> --question-version <question-version> --input <answer-file> --data-dir .agent-relay/runtime
node dist/cli.js task revise <task-id> --version <version> --requirement-version <requirement-version> --input <requirement-file> --data-dir .agent-relay/runtime
```

answer 的问题标识来自 status 中的 `task.question`。revise 仅在执行已停止时替换需求，保存历史并重新 triage；暂停任务保持暂停。两种操作都不重置预算。收到版本冲突时重新读状态，不盲目重发旧决定。活动任务的 pause/cancel 先进入 recovering，确认停止后才变为 paused/cancelled。服务终端按 Ctrl+C 会尝试暂停活动任务并关闭。

配置样例见 [examples/m1.config.json](examples/m1.config.json)。复制到私有运行目录后，用 `serve --config <file>` 加载；所有未知字段和未支持能力都会被拒绝。修改 `profiles.design.native.scenario` 为 `input` 可演示待答复，为 `slow` 可演示暂停或取消；默认 `success` 会快速完成。配置仅作用于新任务，已有任务保留创建时快照。M1 使用 design 角色执行单阶段模拟，完整角色交接属于 M2。

默认模拟限额：每任务最多 4 次运行、总时限 60 秒、单次 5 秒、租约 5 秒、每份日志或成果 256 KiB。总时限包含暂停和待答复时间，重启不重置；这些是模拟默认值，不是 Codex 的实测限额。明确分类的已停止只读失败最多默认重试 2 次基础设施错误，格式修复消耗任务迭代额度；退避与计数落库，不从原生错误文本猜测可重试性。

## 显式开发运行时

将 [M2 配置样例](examples/m2.config.json) 与 [运行时样例](examples/m2.runtime.json) 复制到私有目录，并替换所有占位路径、allowedFiles 和验证命令。三种角色均固定使用已支持的 Codex CLI / OpenAI / GPT-6 Luna，设计和审查只读；实现只能写任务工作树。运行时只接受登记的仓库，HTTP 任务正文不能指定命令、扩大路径范围或改变权限。

```text
node dist/cli.js serve --data-dir <private-data-dir> --config <private-m2-config.json> --runtime <private-runtime.json>
```

随后沿用 task create/status/events 等命令。数据目录、任务工作树根目录及目标原 checkout 必须分离。项目必须有提交基线；源代码的未提交修改不会复制到任务工作树。有效的未提交仓库规则、自定义 hooks/filters、子模块和符号链接等未支持能力会拒绝接入，不自动忽略规则。可信命令使用绝对 executable 和参数数组，在候选工作树内运行；Windows 内置文件监控按版本预检支持，自定义监控脚本仍拒绝。

开发状态包含阶段交接、每轮验证和工作树信息。实现结果需要干净的新提交；审查绑定候选 SHA 和需求版本，旧检查不能覆盖新代码。检查失败或审查反馈在同一迭代预算内修复；缺少证据、停止未知或预算耗尽会阻塞。用户答复升级需求版本并重新 triage，已用次数和截止时间不重置。

真实调用会产生模型使用量；调用次数与时间有上限，金额未知。原始运行记录仅保留在私有目录。本地 accepted 表示当前候选验收通过。M4 提供独立的 GitHub 交付状态：可信配置导入 issue，显式 publish 后有界轮询并处理授权反馈，complete-delivery 关闭反馈窗口；不自动合并。详见 [M4 契约](docs/m4.md)。

## 本机数据与恢复边界

不传 `--data-dir` 时使用用户主目录下的 `.agent-relay`。服务和 CLI 必须指定同一目录，其中包含 SQLite、随机认证令牌、监听端口及内容寻址成果。目录必须为当前 OS 用户私有；Unix 检查权限，Windows 依赖用户目录 ACL。令牌不通过命令行传递，浏览器来源请求被拒绝。同一 OS 账户和管理员属于信任边界。

日志和成果在落盘前执行脱敏与大小检查；任务原文、决策、数据库仍是私有数据，不能上传运行目录。缺失或损坏的成果会显示在 `evidenceIssues` 中，且 `accepted` 为 false。

服务重启不重领仍活动或停止状态未知的运行。新 Codex、可信验证和 Git 工作树变更由独立守护进程保有子进程句柄；服务重启请求原所有者停止，全部停止证据成立后才释放占用。已完成的工作树副作用只确认现状，未知操作不重放。旧版未登记运行、模拟器或守护进程失联仍保持 recovering；此时 resume 被拒绝。仅支持前台工具，Linux 原生运行未启用。租约到期不代表停止，不能通过直接修改数据库或删除租约恢复写入。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [M4 GitHub 交付](docs/m4.md) | 来源、发布意图、反馈、CI 与终态边界 |
| [M3 持续协作与恢复](docs/m3.md) | 需求历史、进程所有权、预算、意图和验证限制 |
| [M2 当前进度与契约](docs/m2.md) | Codex 适配器、生命周期与后续闭环边界 |
| [M1 控制内核契约与验收](docs/m1.md) | 已实现边界、运行协议和版本化验收证据 |
| [M0 实验结果](docs/m0/README.md) | Codex 真实接入证据、复现与阻塞项 |
| [产品规划](docs/product.md) | 范围、用户流程和完成标准 |
| [架构设计](docs/architecture.md) | 模块、数据、执行接口及可靠性边界 |
| [工作流](docs/workflow.md) | 状态转移、角色交接与错误处理 |
| [实现计划](docs/implementation-plan.md) | 按依赖排序的任务与里程碑状态 |
| [路线图](docs/roadmap.md) | 官方 API Agent、自研 harness、自动合并和 Web UI |
| [评测方案](docs/evaluation.md) | 系统可靠性与多 Agent 效果的验证 |
| [初始架构决策](docs/decisions/0001-execution-backends.md) | 已确定决策与后果 |
| [技术依据](docs/references.md) | 指南、官方文档及本机观察 |

## 许可

仓库已公开；开源许可证尚待维护者选择。公开可见不代表已授予开源许可。
