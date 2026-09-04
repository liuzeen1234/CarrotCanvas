# 项目文档目录

本目录是 **CarrotCanvas 所有文档的统一存放位置**。后续涉及的架构、技术选型、开发规划、接口说明、部署、里程碑等文档一律放在这里，按主题分文件，不堆在项目根目录。

## 文档索引

| 文档 | 内容 |
|---|---|
| [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md) | 项目现状总结（技术栈、结构、运行状态、已解决问题） |
| [COMFYUI-INTEGRATION.md](./COMFYUI-INTEGRATION.md) | ComfyUI 集成·运行功能设计（阶段一：独立菜单/卡片式/JSONText+文件占位符/object_info 自动表单） |
| [CANVAS-INTEGRATION.md](./CANVAS-INTEGRATION.md) | Canvas 集成·画布节点调用工作流设计（阶段二：多画布/三类节点，一期仅文生图，C1 后端数据层 + C2 产物捕获 + C3 列表/编辑器路由 + C4 共享运行组件已完成） |
| [CODEX2API-INTEGRATION.md](./CODEX2API-INTEGRATION.md) | Codex2API 通用能力工具箱、统一代理与画布节点集成 |

> 新增文档时，请在此表登记一行索引，并遵循下述命名与组织约定。

## 命名约定

- 用大写下划线风格，语义化描述内容，例如：`ARCHITECTURE.md`、`API-SPEC.md`、`AI-DEV-PLAN.md`
- 一个文档只讲一个主题，避免"大杂烩"
- 已过时的内容用 `（已废弃）` 标注，或用 `archive/` 子目录归档

## 建议的文档规划（按需创建）

- `ARCHITECTURE.md` — 系统整体架构与模块划分
- `TECH-DECISIONS.md` — 关键决策记录（为何选 pnpm、端口、web 优先、单文件打包等）
- `API-SPEC.md` — 后端接口定义
- `DB-SCHEMA.md` — 数据库表结构
- `AI-DEV-PLAN.md` — 开发计划与里程碑
- `COMFYUI-INTEGRATION.md` — ComfyUI 对接方案
- `DEPLOYMENT.md` — 交付与部署（单文件打包）
