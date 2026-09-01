# AGENTS.md

本文件为在该仓库工作的 AI 代理提供必要指引（面向人类开发者的说明见 README.md）。

## 关键入口

- **ComfyUI 运行功能的当前设计、已拍板决策与落地进度**：`docs/COMFYUI-INTEGRATION.md`。任何涉及 ComfyUI API 运行/入参/提交的需求，先读该文档再动手。
- 项目现状快照（技术栈、运行状态、已知环境问题）：`docs/PROJECT-SUMMARY.md`。
- 文档索引与命名约定：`docs/README.md`。

## 环境注意事项

- Windows + PowerShell，命令用 `.cmd` 变体调用 npm/pnpm 等（执行策略禁 `.ps1`）。
- 系统 Node 在 `C:\Program Files\nodejs`（v24+）；若 PATH 中 Node 版本过旧，需用系统 Node 全路径。
- 后端用 `tsx` 运行存在装饰器元数据缺失问题（NestJS DI 失效），开发/运行时用 `tsc` 编译后从 `dist/main.js` 启动。
