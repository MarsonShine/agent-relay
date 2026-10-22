# Agent Relay

Agent Relay 在本机把一个研发任务交给 Codex CLI，组织调查、实现、独立审查和可信检查，并保存任务状态与证据。启用 GitHub 配置后，还可以从 issue 创建 PR，处理授权反馈，再更新同一个 PR。

**第一次使用先跑下面的模拟任务。** 它不需要 Codex 或 GitHub 登录，不调用模型，也不会修改目标仓库。确认自己会启动服务、提交任务和读取结果后，再按 [完整使用手册](docs/usage.md) 接入真实项目。

## 安装与运行条件

目前通过源码运行，包版本为 `0.1.0`，尚未正式发布，不提供 `npx agent-relay` 安装流程。

| 用途 | 需要准备 |
| --- | --- |
| 模拟 demo | Git、Node **26.8.2**、npm **11.14.1** |
| Windows 真实开发任务 | 上述工具，以及已认证的原生 Codex CLI **0.163.0-alpha.10.2**、有提交基线的目标仓库 |
| GitHub issue → PR | 上述真实运行条件，以及已认证的 `gh`、目标仓库的访问/推送权限和可信交付配置 |

Windows 已验证真实开发与交付；Linux 支持模拟服务与确定性回归，真实开发运行时会拒绝启动；macOS 未验证。Codex 版本会被严格校验，不能假定任意新版兼容。服务只监听本机，当前没有 Web 界面。

先用你使用的 Node 版本管理器或安装程序安装 Node 26.8.2；在安装好 Node 的终端执行 `npm install --global npm@11.14.1`，然后获取源码。已经安装匹配版本时跳过安装步骤。

```powershell
git clone https://github.com/MarsonShine/agent-relay.git
cd agent-relay
node --version
npm --version
npm ci
npm run build
node dist/cli.js --help
```

确认版本分别为 `v26.8.2` 和 `11.14.1`。安装所需版本后再执行 `npm ci`，不要关闭版本检查。以下 Windows 示例使用 **PowerShell 7**；Linux 的等价起步命令见 [使用手册](docs/usage.md#linux-模拟起步)。命令均从本工具仓库根目录执行，文档、示例和源码应来自同一个版本。

## 跑通第一个任务

需要两个终端：终端 A 保持服务运行，终端 B 负责提交和查询。`--data-dir` 是服务保存任务的目录，两个终端必须使用同一个值。

**终端 A：启动模拟服务。**

```powershell
node dist/cli.js serve --data-dir .agent-relay/tutorial --port 4318
```

看到包含 `"backend":"simulation"` 和 `"listening":"http://127.0.0.1:4318"` 的 JSON 后，保留这个终端。不要在浏览器打开地址，它是需要认证的本机接口。

**终端 B：进入同一个工具仓库目录，提交任务。**

```powershell
node dist/cli.js doctor --data-dir .agent-relay/tutorial
'验证任务提交与结果保存' | Set-Content -Encoding utf8NoBOM .agent-relay/tutorial/task.txt
$created = node dist/cli.js task create --repo . --input .agent-relay/tutorial/task.txt --key tutorial-001 --data-dir .agent-relay/tutorial | ConvertFrom-Json
$taskId = $created.task.id
$taskId
```

`doctor` 查询已经启动的服务；不是离线安装检测命令。保存打印出的任务 ID，之后用它查结果：

```powershell
$s = node dist/cli.js task status $taskId --data-dir .agent-relay/tutorial | ConvertFrom-Json
$s.task.status
$s.accepted
$s.evidenceIssues
```

如果仍是 `queued` 或 `running`，稍后重新执行上面三行查询。正常完成时应看到 `succeeded`、`True` 和空的 `evidenceIssues`。模拟任务的 accepted 只说明模拟证据完整，不代表已经完成真实业务需求。

**读取成果与执行记录。**

```powershell
$result = $s.artifacts | Where-Object kind -eq result | Select-Object -Last 1
Get-Content -Raw -LiteralPath (Join-Path .agent-relay/tutorial/evidence $result.sha256)
node dist/cli.js task events $taskId --after 0 --limit 100 --data-dir .agent-relay/tutorial
```

成果会说明未执行模型或仓库修改。返回终端 A 按 Ctrl+C 停止服务；下次以相同数据目录和端口启动，还能查询这个任务。重复提交相同 `--key` 和相同内容会返回原任务；想做新的任务就换一个 key。

## 下一步怎么用

| 你想做什么 | 入口 |
| --- | --- |
| 熟悉任务、结果、版本号与状态 | [基本操作与结果解读](docs/usage.md#基本操作与结果解读) |
| 演示问题答复 | [Demo 2：等待用户答复](docs/usage.md#demo-2等待用户答复) |
| 演示暂停、恢复、取消、修改需求和预算 | [Demo 3：控制长任务](docs/usage.md#demo-3控制长任务) |
| 在小型示例仓库修复真实代码 | [Demo 4：真实代码修复](docs/usage.md#demo-4真实代码修复windows) |
| 只调查代码，不实施修改 | [Demo 5：只读咨询](docs/usage.md#demo-5只读咨询) |
| 导入 issue、发布 PR、处理反馈 | [Demo 6：GitHub 交付](docs/usage.md#demo-6github-交付) |
| 查全部命令和配置参数 | [命令速查](docs/usage.md#命令速查)、[配置参考](docs/usage.md#配置参考) |
| 处理失败、版本冲突或服务重启 | [排错与恢复](docs/usage.md#排错与恢复) |

真实开发 demo 会调用模型、产生使用量，并在独立任务工作树中创建提交；GitHub demo 还会推送分支和创建 PR。阅读相应章节、核对目标和预算后再执行。示例仓库里的测试故意暴露一个小缺陷，详见 [demo 文件说明](examples/tutorial/README.md)。

## 使用边界

- 默认运行的是模拟执行器。真实执行必须显式提供 `--config` 和 `--runtime`；目前只接入 Codex CLI，没有 API 执行后端。
- 真实任务在独立工作树中运行；原仓库的未提交修改不会复制进去。项目规则、允许文件与检查命令需要事先确定，issue 或模型文本不能扩大权限。
- `accepted` 是当前本地候选的验收结果；`delivered` 是 GitHub 交付完成结果。二者都不表示已合并。
- 进程停止未知时保持隔离，不通过删库、删租约或重复启动来恢复写入。等待人工和暂停也消耗原任务的总期限。
- 数据目录包含私有任务、数据库、认证令牌和运行记录，不要提交或上传。日志脱敏不等于整个目录可以公开。

## 开发与项目进度

```powershell
npm run check
```

完整检查包含类型、格式、构建和测试。测试会启动并停止自身模拟进程，环境需要允许进程树终止；默认测试不调用真实模型。

M0–M4 已完成，当前进行 v1 收尾。实现 PR #6 和联调 PR #5、#7 已进入 main；本轮收尾见 [PR #8](https://github.com/MarsonShine/agent-relay/pull/8)。尚未正式发布，真实业务试点暂缓；旧失败任务和 unknown 实例保留隔离，不追认成功。

| 文档 | 用途 |
| --- | --- |
| [完整使用手册](docs/usage.md) | 新手教程、全部 CLI 用法、配置、demo 和排错 |
| [v1 收尾记录](docs/v1-closeout.md) | 修复与发布准备证据 |
| [M4](docs/m4.md)、[M3](docs/m3.md)、[M2](docs/m2.md) | 交付、恢复、执行器的详细契约与历史验收 |
| [M1](docs/m1.md)、[M0](docs/m0/README.md) | 控制内核与接入实验 |
| [产品规划](docs/product.md)、[架构设计](docs/architecture.md)、[工作流](docs/workflow.md) | 维护者设计文档 |
| [实现计划](docs/implementation-plan.md)、[路线图](docs/roadmap.md)、[评测方案](docs/evaluation.md) | 范围与后续方向 |
| [架构决策](docs/decisions/0001-execution-backends.md)、[技术依据](docs/references.md) | 决策与参考资料 |

## 许可

本项目采用 [Apache License 2.0](LICENSE)。依赖保留各自的许可证。
