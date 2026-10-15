# 技术依据与验证状态

检查日期：2026-10-15。链接内容可能变化；实现阶段应固定依赖版本并保存对应协议样本。

## 设计参考

- [AI Agent 入门](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter1.md)：Model 与 Harness 的边界。
- [Coding Agent 与通用 Agent](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter5.md)：验证、执行边界、反馈与错误恢复。
- [多 Agent 协作](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter10.md)：交接、隔离、同源错误和预算。
- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)：脚本执行与机器可读输出。
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)：其他程序接入路径；本项目 v1 选择 CLI。
- [Diversity of Thought](https://arxiv.org/abs/2410.12853)：特定数学任务中的异模型协作收益。
- [Demystifying Multi-Agent Debate](https://arxiv.org/abs/2601.19921)：多样性及讨论机制的重要性与局限。

指南作为设计参考，项目中的具体模块、数据契约和里程碑是本项目设计。研究结果不能直接推导软件工程任务中异模型组合必然最佳，也不能证明不同供应商的训练数据相互独立。

## 本机已观察

- codex-cli 0.162.0-alpha.17.2。
- exec 帮助列出 --json、--output-schema、--model、--sandbox、--cd、stdin 输入和 resume。
- resume 帮助支持显式 SESSION_ID、stdin、--json 和 --output-schema；与首次执行的参数集合不同。
- GitHub CLI 当前未登录。

## 尚未验证

真实模型调用、实际结构化输出、思考配置的有效性、取消后的进程树、恢复行为、CLI 版本兼容、GitHub 权限与远端创建。M0 完成前不得称为已通过。

DeepSeek 官方 API 的兼容性与工具协议留待 API roadmap 阶段调研和实测，不是 v1 的验收条件。
