# M0 实验脚本

运行方法、预算、兼容性与已知限制见 [M0 报告](../../docs/m0/README.md)。

- process-probe.mts：观察有界子进程、JSONL 与退出，提供显式取消。
- process-probe.test.mts：无需模型的生命周期和判定回归测试。
- codex-probe.mts：在独立 Git 测试目录中执行一次指定的 Codex 场景。

需要支持原生 .mts 的 Node；本次验证版本是 Node 26.8.2。M1 已提供锁定工具链及 npm run check；此目录仍仅为实验工具。

命令输出用于观察证据。脚本完成退出不代表场景通过，须检查 summary 中的 outcome、agentStatus、schemaValid、taskAccepted 和独立检查结果。CLI 完成轮次与任务成功分别记录。

显式设置 RELAY_M0_APPROVAL=auto-review 可复验自动审批通道，默认仍为 never。此模式不忽略任何规则，也不提供已验证的只读能力；当前 CLI 的只读隔离复验失败，禁止据此启用生产后端。取消测试使用有 30 秒自限的心跳夹具，只在真实工具开始写入后发出取消，并复查停止证据。
