# M0：Codex CLI 接入实验

日期：2026-10-16。状态：**部分完成；真实调查→修改→反馈修复链路被当前执行策略阻塞，M0 尚未通过。**

## 已观测环境

| 项目 | 观测值 |
| --- | --- |
| OS | Windows |
| Node | v26.8.2（使用原生 TypeScript 类型擦除运行 .mts） |
| Git | 2.51.2.windows.1 |
| Codex CLI | 0.162.0-alpha.17.2 |
| 认证 | 本机 ChatGPT 登录；未复制认证文件 |
| 请求模型 / 思考参数 | gpt-6-astra / low |
| 实际路由确认 | JSONL 未独立证明实际模型及思考配置，不能仅以模型自述确认 |
| 工作目录 | 忽略目录内的专用 Git 测试仓库 |
| 执行方式 | 参数数组、shell:false、stdin 提示、显式 cwd、有限超时 |

路径和会话 ID 仅保留在本机忽略目录，不进入公开样例。这是一次特定版本实验，不是稳定版本兼容承诺。

## 结果矩阵

| M0 项 | 证据 | 结论 |
| --- | --- | --- |
| M0.1 环境与认证 | 本机版本、登录状态与可执行路径检查 | 完成；可执行路径由调用者配置 |
| M0.2 JSONL / stdin / schema | 只读调用退出 0、turn.completed、可解析结构化结果 | 协议通过；实际读取和执行被拒绝，调查未通过 |
| M0.3 修改与检查 | math.cjs 未变，独立 node check.cjs 退出 1 | 阻塞，不能宣称修复成功 |
| M0.3 显式续接 | 新控制进程读取已保存 ID，resume 返回同一会话，仍报告此前未修复 | 续接协议通过；反馈修改未通过 |
| M0.4 无效思考选项 | 400 错误事件、turn.failed、退出 1 | 失败被显式报告；不是本地提前拒绝，仍消耗一次请求机会 |
| M0.4 缺少认证配置 | 独立空 CODEX_HOME、指定缺少的 env_key，返回 Missing environment variable | 该缺失凭据路径通过；未覆盖过期令牌 |
| M0.4 只读写入探针 | status=denied，目标文件不存在 | 观察到拒绝；JSONL 无工具细节，不能独立证明具体拦截层 |
| M0.5 真实取消 | turn.started 后终止该子 CLI 树；退出 1，无 turn.completed；进程核对无残留 | 活动 CLI 取消通过；未到工具执行，不证明沙箱内工具树取消 |
| M0.5 模拟子进程树 | 子进程持续写 heartbeat；取消后文件不再增长且 PID 不存在 | Windows 实验树验证通过 |
| M0.5 静默 / 截断 / 非零退出 | 自动化进程样本 | 分类通过；不会把无终态退出当成功 |
| M0.5 中途崩溃恢复 | 尚无实际“工具写入后控制器崩溃”实验 | 未验证，不能安全重放未知副作用 |
| M0.6 兼容性证据 | summary.json、协议投影样例和本文 | 已记录 |

六次请求机会已用完：无效参数、调查、修改、续接、拒绝写入、取消。另有一次缺失凭据的本地失败探针。

四个返回用量的完成轮次合计 input_tokens=283558、cached_input_tokens=194688、output_tokens=940。缓存数包含于输入计数，不重复相加；失败及取消请求未提供用量，因此这些数值不是全部费用估算。金额未知。

自动化检查共 7 项通过。父进程退出样例在 Windows 上立即关闭管道，验证了不误报成功，但未复现管道持续占用至超时的分支。

## 证据与根因边界

调查、修改和续接结果均明确报告执行策略阻塞；文件内容和独立检查与报告一致。修改调用显式设置 workspace-write，但结果仍报告只读限制。

子进程继承桌面会话的权限环境，当前聊天附着的工作区与 Agent Relay 目录不同，这是限制来源的候选解释。尚未取得足够底层证据把该因素判定为唯一根因。--ignore-user-config 也没有使本机已安装插件完全不启动，不能把它当作完整配置隔离。

本实验没有忽略 execpolicy rules、移除权限环境或使用 bypass/full-access 参数。遇到限制后停止扩大权限。

关键契约：CLI 轮次结束不等于任务完成。实验同时保存 CLI outcome、Agent status、schema 验证和独立检查结果；blocked/denied 不能转为成功。

脱敏结果见 [summary.json](summary.json) 与 [事件投影](events.sanitized.jsonl)。事件投影省略消息正文并替换标识，仅用于协议观察，不是可重放的完整会话。

## 复现

首先运行不调用模型的检查：

```powershell
node --test scripts/m0/process-probe.test.mts
```

真实实验需使用本机已登录的官方 Codex，在允许访问实验目录的工作区运行。脚本不自行登录、获取凭据或更改执行策略：

```powershell
$env:RELAY_CODEX_BIN = (Get-Command codex).Source
$env:RELAY_CODEX_MODEL = 'gpt-6-astra'
$env:RELAY_M0_ROOT = '.agent-relay/m0-new'
node scripts/m0/codex-probe.mts setup
node scripts/m0/codex-probe.mts invalid-effort
node scripts/m0/codex-probe.mts no-auth
node scripts/m0/codex-probe.mts inspect
node scripts/m0/codex-probe.mts edit
node scripts/m0/codex-probe.mts resume
node scripts/m0/codex-probe.mts permission
node scripts/m0/codex-probe.mts cancel
```

模型名称必须是当前账号可用且明确选择的模型。每个实验根目录最多六次可能访问模型的调用，每次 180 秒上限；不可通过更换目录自动循环重置预算。setup 与已存在的动作目录会拒绝覆盖证据。

原始 stdout/stderr 和 session ID 写入 .agent-relay/，不得提交；它们可能包含路径、插件信息和任务内容。环境按系统必需变量及 Codex 控制变量筛选，不向子 CLI 转交不相关的供应商密钥。继承的策略仍生效。

scripts/m0 是实验工具，不是生产适配器：无实时持久化日志、无 OS 级租约、无可靠崩溃检查点、无完整 schema 库或类型检查流水线。取消使用强制树终止，尚未验证软中断及升级流程；生产实现须在 M1/M3 补齐。

## 下一步与禁用能力

在以 Agent Relay 为工作区的正常受限 Codex 环境重新运行受阻的调查、修改、续接实验；先检查权限边界，不通过禁用沙箱解决。

在该链路通过前，禁止启用自动写入和自动恢复写任务。沙箱内工具进程树取消、控制器崩溃后的核对以及 Linux 实测均保持未验证。M1 可参考执行协议，但不能把 M0 标为通过或依赖尚未建立的安全保证。
