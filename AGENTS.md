# AGENTS.md

本文件为在该仓库工作的 AI 代理提供必要指引（面向人类开发者的说明见 README.md）。

## 关键入口

- **ComfyUI 运行功能的当前设计、已拍板决策与落地进度**：`docs/COMFYUI-INTEGRATION.md`。任何涉及 ComfyUI API 运行/入参/提交的需求，先读该文档再动手。
- 项目现状快照（技术栈、运行状态、已知环境问题）：`docs/PROJECT-SUMMARY.md`。
- 文档索引与命名约定：`docs/README.md`。

## 环境注意事项

- Windows + PowerShell。执行策略已设为 `RemoteSigned`（CurrentUser），`.ps1` 包装脚本可直接运行——`pnpm` / `npx` / `tsc` 直接调用即可，无需再走 `.cmd` 变体。本项目为 pnpm workspace，`pnpm` 已在 PATH（`%APPDATA%\npm\pnpm.cmd`）。
- 集成终端曾出现"命令被逐字符回显、污染 stdout"的问题，根因是 Kiro 集成终端（`TERM_PROGRAM=kiro`）中 PSReadLine 的行重绘。已在用户级 profile（`D:\personal-files\docs\WindowsPowerShell\profile.ps1`）中处理：检测到集成终端时卸载 PSReadLine，独立手动终端不受影响。如仍遇到回显乱码，多为该会话在 profile 更新前启动，重启终端会话即可。
- **命令执行环境是 Windows PowerShell 5.1**：不支持 `&&` / `||`（PowerShell 7 才引入），命令分隔一律用 `;` 或分行，不要写 bash 风格的 `&&`。
- **Node 版本坑（仅豆包/Doubao agent 需要处理；其他 AI IDE 的 agent 不会遇到，无需处理）**：Doubao agent 执行命令的进程 PATH 会被 agent 运行时注入自带的 node（当前 v20.20.2，位于 `...\Doubao\User Data\sandbox_runtime\bases\...\node`）且排在系统 Node **前面**，导致 `node -v` 解析到旧版、pnpm 11（要求 Node ≥22.13）直接报错。**Doubao agent 执行所有 node/pnpm 命令前先执行 `$env:Path = "C:\Program Files\nodejs;" + $env:Path`**；系统 Node v24+ 在 `C:\Program Files\nodejs`。
- 后端用 `tsx` 运行存在装饰器元数据缺失问题（NestJS DI 失效），开发/运行时用 `tsc` 编译后从 `dist/main.js` 启动。
