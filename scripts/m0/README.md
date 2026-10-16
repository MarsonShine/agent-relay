# M0 实验脚本

结果、复现、预算和限制见 [M0 报告](../../docs/m0/README.md)。当前 Windows 基线通过；历史失败保持可查。

- process-probe.mts：有界 JSONL/退出观察和外部取消信号。
- approval-config.mts：显式审批策略、Windows 原生沙箱和有限调用预算。
- readonly-evidence.mts：夹具快照、固定补丁与基于工具证据的只读判定。
- codex-probe.mts：每次执行一个指定场景，拒绝覆盖结果。

真实调用默认 gpt-6-luna；更换模型须由用户明确选择。read-only-review 关闭沙箱/权限扩展审批，Windows 显式保留 elevated 原生沙箱；auto-review 模式仅用于可写流程或诊断，不能作为严格只读保证。默认六次请求，已获额外授权才可通过 RELAY_M0_CALL_LIMIT 增加，上限八次，保留已用次数。

运行 `npm run check` 执行不调用模型的检查。实际场景必须核对 readOnlyAccepted、workspaceUnchanged、工具拒绝证据及独立检查，不能凭 CLI 零退出或模型自述判成功。取消探针要求观察真实心跳后再停止，并核对文件不再变化及工具进程退出。
