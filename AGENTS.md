# AGENTS.md

本文件为在该仓库工作的 AI 代理提供必要指引（面向人类开发者的说明见 README.md）。

## 关键入口

- **AI 原生画布控制、人机交接、生成历史与自主视频生产的当前设计、已拍板决策及阶段进度**：`docs/AI-NATIVE-CANVAS.md`。任何涉及 Agent API、画布 revision/lease、人工与 AI 交接、操作日志、Checkpoint、持久化 Run、候选资产、选片、Shot Plan 或 AI 操作 Skill 的需求，必须先完整阅读该文档；实现后同步更新其中的阶段状态与变更记录。
- **ComfyUI 运行功能的当前设计、已拍板决策与落地进度**：`docs/COMFYUI-INTEGRATION.md`。任何涉及 ComfyUI API 运行/入参/提交的需求，先读该文档再动手。
- 项目现状快照（技术栈、运行状态、已知环境问题）：`docs/PROJECT-SUMMARY.md`。
- 文档索引与命名约定：`docs/README.md`。

## 环境注意事项

- Windows + PowerShell。执行策略已设为 `RemoteSigned`（CurrentUser），`.ps1` 包装脚本可直接运行——`pnpm` / `npx` / `tsc` 直接调用即可，无需再走 `.cmd` 变体。本项目为 pnpm workspace，`pnpm` 已在 PATH（`%APPDATA%\npm\pnpm.cmd`）。
- 集成终端曾出现"命令被逐字符回显、污染 stdout"的问题，根因是 Kiro 集成终端（`TERM_PROGRAM=kiro`）中 PSReadLine 的行重绘。已在用户级 profile（`D:\personal-files\docs\WindowsPowerShell\profile.ps1`）中处理：检测到集成终端时卸载 PSReadLine，独立手动终端不受影响。如仍遇到回显乱码，多为该会话在 profile 更新前启动，重启终端会话即可。
- **命令执行环境是 Windows PowerShell 5.1**：不支持 `&&` / `||`（PowerShell 7 才引入），命令分隔一律用 `;` 或分行，不要写 bash 风格的 `&&`。
- **Node 版本坑（仅豆包/Doubao agent 需要处理；其他 AI IDE 的 agent 不会遇到，无需处理）**：Doubao agent 执行命令的进程 PATH 会被 agent 运行时注入自带的 node（当前 v20.20.2，位于 `...\Doubao\User Data\sandbox_runtime\bases\...\node`）且排在系统 Node **前面**，导致 `node -v` 解析到旧版、pnpm 11（要求 Node ≥22.13）直接报错。**Doubao agent 执行所有 node/pnpm 命令前先执行 `$env:Path = "C:\Program Files\nodejs;" + $env:Path`**；系统 Node v24+ 在 `C:\Program Files\nodejs`。
- 后端用 `tsx` 运行存在装饰器元数据缺失问题（NestJS DI 失效），开发/运行时用 `tsc` 编译后从 `dist/main.js` 启动。

## 开发工作流约定

- **开发期间后端验证直接用 3100，不另起端口**（如 3200 等临时实例）。开发过程中用户不会使用该后端，因此放心「该构建就构建、该重启就重启」。
- 改动后端代码后的标准流程：`tsc -p tsconfig.build.json` 编译通过 → 停掉 3100 旧进程（pnpm wrapper + `node dist/main.js` 都要停）→ 用与用户一致的方式重新拉起：从仓库根 `pnpm --filter @carrot-canvas/backend start`（后台、日志重定向到 `backend/data/`）→ 用 `GET /api/health` 与新增路由（如 `/api/canvas`）确认新代码已生效。
- 开发、修复与验证需要时，代理可自行重新构建并重启本项目的 **3100 后端**与 **8000 前端 dev**，无需另行向用户确认；重启前应确认目标端口及进程，重启后验证健康状态与页面可访问性。3000 Infinite-Canvas 属于其他项目，除非用户明确要求，否则不主动操作。

