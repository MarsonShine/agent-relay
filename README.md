# Agent Relay

Agent Relay 是支持多种 Agent 执行后端的本地研发编排工具。它将需求调查、设计、实现、独立审查和反馈修复组织为可恢复、有验收依据的工作流。

**当前状态：规划阶段，尚无可运行产品。** 第一版使用 TypeScript、本地服务与 CLI，通过子进程调用 Codex CLI。自研 API Agent 运行时以及 DeepSeek 等官方 API 接入属于后续 roadmap，不是 v1 前置依赖。

## 产品边界

- 控制层管理任务、角色、交接、状态、预算、验证和 GitHub 交付。
- v1 复用 Codex 的上下文管理、工具循环与执行能力。
- 后续 API Agent 运行时通过同一执行接口接入，内部自行管理模型请求、工具循环和上下文。
- 角色、执行后端、模型供应商、模型和权限分别配置。
- 咨询任务可以调查后直接回答；代码任务按实际复杂度经过设计、实现、审查和验证。
- 公开仓库用于存放源码、规范和脱敏样例；运行日志、凭据和任务代码不随工具仓库发布。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [产品规划](docs/product.md) | 范围、用户流程和完成标准 |
| [架构设计](docs/architecture.md) | 模块、数据、执行接口及可靠性边界 |
| [工作流](docs/workflow.md) | 状态转移、角色交接与错误处理 |
| [实现计划](docs/implementation-plan.md) | 按依赖排序的开发任务及验收条件 |
| [路线图](docs/roadmap.md) | 官方 API Agent、自研 harness、自动合并和 Web UI |
| [评测方案](docs/evaluation.md) | 系统可靠性与多 Agent 效果的验证 |
| [初始架构决策](docs/decisions/0001-execution-backends.md) | 已确定决策与后果 |
| [技术依据](docs/references.md) | 指南、官方文档及本机观察 |

## 第一版预期体验

以下为拟定命令形态，尚未实现：

```text
agent-relay doctor
agent-relay serve
agent-relay task create --repo <path> --input <task-file>
agent-relay task status <task-id>
agent-relay task events <task-id>
agent-relay task answer <task-id> --input <answer-file>
agent-relay task pause <task-id>
agent-relay task resume <task-id>
agent-relay task cancel <task-id>
```

第一版按 M0–M4 交付：Codex CLI 接入验证、控制内核、本地闭环、恢复与持续协作、GitHub PR 交付。自动合并默认关闭，属于后续独立里程碑。

目标为 Windows 本机可用，核心逻辑在 Windows/Linux CI 验证。当前没有安装命令或支持版本承诺；M0 完成后记录实际验证的工具链和 Codex 版本。

## 许可

仓库计划公开；开源许可证尚待维护者选择。公开可见不代表已授予开源许可。
