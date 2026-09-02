# CarrotCanvas 🥕

本地 ComfyUI 生图 / 生视频工作台 · 无限画布节点编排

对接本地部署的 ComfyUI，通过无限画布进行流程节点编排，生成图片与视频并集中管理。

## 技术栈

- **后端**：NestJS + TypeORM + SQLite（better-sqlite3）
- **前端**：Umi + Ant Design + React + TypeScript
- **画布**：@xyflow/react（React Flow）
- **包管理**：pnpm workspace（monorepo：`backend/` + `web/`）

## 环境要求

- Node.js >= 20
- pnpm >= 9（包管理）

## 快速开始

```bash
# 安装依赖（仓库根目录）
pnpm install

# 启动后端（NestJS，默认 http://localhost:3100）
pnpm dev

# 启动前端（Umi dev，默认 http://localhost:8000，已代理 /api 到后端）
pnpm dev:web

# 两端同时启动
pnpm dev:all

# 构建
pnpm build

# 生产运行后端（需先 build）
pnpm start
```

## 目录结构

```
CarrotCanvas/
├─ backend/          # NestJS 后端
│  └─ src/
│     ├─ main.ts     # 入口（端口 3100，全局前缀 /api）
│     ├─ app.module.ts
│     ├─ app.controller.ts / app.service.ts  # /api/health
│     ├─ database/   # TypeORM + better-sqlite3
│     └─ workflows/  # 工作流管理（导入/查询/编辑/删除 + 格式校验）
├─ web/              # Umi + AntD 前端
│  └─ src/
│     ├─ pages/index.tsx          # 首页
│     ├─ pages/canvas.tsx         # 无限画布（@xyflow/react）
│     ├─ pages/settings/index.tsx # 设置页（工作流管理）
│     ├─ components/settings/     # 工作流管理组件
│     └─ layouts/index.tsx        # 布局
└─ pnpm-workspace.yaml
```

## 端口约定

| 服务 | 端口 |
|---|---|
| 后端 NestJS | 3100 |
| 前端 Umi dev | 8000 |

> 注意：3000 端口可能被其他本地服务占用，本项目后端默认使用 3100。

## 开发计划（TODO）

- [x] ComfyUI 工作流导入与管理（设置页，含 API 格式校验）
- [x] ComfyUI 连接配置（服务地址）
- [ ] ComfyUI 客户端（HTTP + WebSocket 任务监听）
- [ ] SQLite 数据表补全：generation_runs / assets / canvas_docs（canvas_docs 与 assets「中间产物存 data/assets 并按画布分区」设计见 [docs/CANVAS-INTEGRATION.md](docs/CANVAS-INTEGRATION.md)）
- [ ] 多画布 + 画布自定义节点（提示词、文生图生成、结果预览；一期仅文生图，方案见 [docs/CANVAS-INTEGRATION.md](docs/CANVAS-INTEGRATION.md)）
- [ ] 生成任务队列与进度
- [ ] 静态托管前端产物 + 单文件打包（交付形态）
