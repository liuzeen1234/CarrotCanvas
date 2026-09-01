# CarrotCanvas 项目现状总结

> 最后更新：2026-09-01
> 本文件是对项目当前状态的完整快照，开发过程中行变更时应同步更新。

## 1. 项目定位

本地 ComfyUI 生图 / 生视频工作台。对接本地部署的 ComfyUI 模型，通过**无限画布**进行**流程节点编排**，生成图片与视频并集中管理。

使用者：本人本地桌面使用。

## 2. 技术栈与选型决策

| 层 | 选型 | 说明 / 决策理由 |
|---|---|---|
| 后端框架 | **NestJS 10** | 结构规范、模块化，社区成熟；先试 Bun 兼容，不行切 Node（已验证可跑） |
| 数据库 | **SQLite（TypeORM + better-sqlite3）** | 本地单文件，零装库，个人场景足够；用 TypeORM 便于后续管理多张表 |
| 前端 | **Umi + Ant Design + React + TS** | 国内团队熟悉组合，生态好 |
| 画布 | **@xyflow/react（React Flow）** | 流程节点编排为主（非自由绘画），轻量；若节点复杂再评估 FlowGram.AI |
| 包管理 | **pnpm 11** | 对 Umi/NestJS 兼容最好（比 bun 省事）；Bun 保留用于单文件打包 |
| 部署形态 | **Web 优先** | 纯 API 后端 + 前端，一键启动；解决"门槛"靠单文件交付而非 Electron |
| 交付 | **单文件 exe（待做）** | `bun build --compile` 或 pkg，双击即用、免装 Node |

### 关键架构决策

- **部署形态**：先做 Web（NestJS 纯后端 + 前端 build 产物由 NestJS 静态托管，同一端口），Electron 作为可选壳，不锁死。
- **端口**：后端默认 **3100**（3000 被 Infinite-Canvas 占用），前端 dev **8000**。
- **前后端通信**：开发期 Umi proxy `/api → localhost:3100`。
- **画布方向**：流程节点编排（提示词→生成→结果预览），用 React Flow 而非自由画布工具。

## 3. 项目结构

```
CarrotCanvas/                    # D:\dev\CarrotCanvas（git 仓库，MIT，作者 老刘）
├─ package.json                 # pnpm workspace 根
├─ pnpm-workspace.yaml          # workspace：backend + web；allowBuilds
├─ .npmrc                       # 镜像源（npmmirror）
├─ .gitignore
├─ README.md                    # 项目说明 + 快速开始
├─ LICENSE
├─ docs/                        # ★ 所有文档统一存放处（本目录）
│  ├─ README.md                 # 文档索引与约定
│  ├─ PROJECT-SUMMARY.md        # 本文档
│  └─ COMFYUI-INTEGRATION.md    # ComfyUI 集成·运行功能设计
├─ backend/                     # NestJS 后端
│  ├─ src/
│  │  ├─ main.ts                # 入口，端口 3100
│  │  ├─ app.module.ts
│  │  ├─ app.controller.ts      # GET /api/health
│  │  ├─ app.service.ts
│  │  ├─ database/
│  │  │  └─ database.module.ts   # TypeORM + better-sqlite3（数据文件 data/carrot-canvas.sqlite）
│  │  └─ workflows/              # ComfyUI API（工作流）管理模块
│  │     ├─ workflow.entity.ts
│  │     ├─ workflows.module.ts / controller.ts / service.ts
│  │     └─ comfyui-validator.ts # ComfyUI API 格式校验
│  ├─ package.json              # @carrot-canvas/backend
│  ├─ tsconfig.json / tsconfig.build.json
└─ web/                         # Umi + AntD 前端
   ├─ .umirc.ts                 # proxy /api → 3100
   ├─ src/
   │  ├─ pages/index.tsx        # 首页
   │  ├─ pages/canvas.tsx       # 无限画布（@xyflow/react 骨架）
   │  ├─ pages/settings/index.tsx # 设置页（路由 Outlet 布局）
   │  ├─ pages/settings/comfyui-api/index.tsx # ComfyUI API 管理页（独立路由）
   │  ├─ components/settings/ComfyUIAPIManager.tsx # ComfyUI API 列表 + 导入/编辑
   │  ├─ layouts/index.tsx      # 布局（AntD ConfigProvider）
   └─ package.json              # @carrot-canvas/web
```

## 4. 当前运行状态

- ✅ 后端 NestJS：`http://localhost:3100`，`GET /api/health` → `200 {"status":"ok"}`
- ✅ 后端 `workflows` 模块：CRUD + 导入 + ComfyUI API 格式校验（`/api/workflows`）
- ✅ 前端 Umi dev：`http://localhost:8000`，HTTP 200，首页 / 画布页 / 设置页（含 ComfyUI API 管理）可访问
- ✅ 前端 ComfyUI API 管理：列表 CRUD + 导入/校验（Table 视图），含 ComfyUI 地址配置与连接测试
- ✅ 前端构建通过（`pnpm build`）
- ⚠️ 后端当前以**系统 Node v24 运行编译产物** `dist/main.js`（tsx 存在装饰器元数据问题致 NestJS DI 失效，见 AGENTS.md）
- ⚠️ 两个服务目前由后台进程方式拉起，非固化脚本

### 启动命令

```bash
pnpm dev       # 后端 http://localhost:3100
pnpm dev:web   # 前端 http://localhost:8000
pnpm build     # 构建
pnpm start     # 生产运行后端（需先 build）
```

## 5. 环境清单

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | v24.17.0 | `C:\Program Files\nodejs` |
| pnpm | 11.24.0 | 全局安装，用 `pnpm.cmd` 调用（PowerShell 禁 .ps1） |
| Bun | 1.4.0 | `C:\Users\liu\.bun\bin\bun.exe`（用于单文件打包） |

### 已知环境问题 / 注意事项

1. **PowerShell 执行策略禁止 `.ps1`**：`npm`、`pnpm`、`npx` 等需用 `.cmd` 变体调用（`pnpm.cmd`）。
2. **3000 端口被占用**：本地 `D:\Infinite-Canvas`（Python/FastAPI）占用 3000，故本项目用 3100。
3. **pnpm 11 新配置**：`onlyBuiltDependencies` 已废弃，改用 `pnpm-workspace.yaml` 的 `allowBuilds` map；`strictDepBuilds` 默认 true，未批准的构建脚本会导致 pnpm 命令报错退出。
4. **Umi 对 bun 兼容不佳**：`npmClient: 'bun'` 会触发 Umi 配置校验报错（只接受 pnpm/tnpm/cnpm/yarn/npm），这是改用 pnpm 的原因之一。
5. **@umijs/max 不能与 umi 同时依赖**：会直接报错，web/package.json 只保留 `@umijs/max`。

## 6. 已完成事项

- [x] 创建 `D:\dev` 并 clone `git@github.com:rapidrabbitsliu/CarrotCanvas.git`
- [x] 环境：安装 Bun 1.4.0、pnpm 11.24.0；配置国内镜像源
- [x] 搭建 pnpm workspace monorepo（backend + web）
- [x] NestJS 后端骨架，health 接口跑通
- [x] Umi + AntD 前端骨架，构建 + dev 跑通
- [x] React Flow 无限画布骨架页
- [x] TypeORM + better-sqlite3 数据库接入，`workflows` 表建好
- [x] 工作流管理：导入（文件/粘贴）、查询、编辑、删除，含 ComfyUI API 格式校验
- [x] ComfyUI API 管理重构：`WorkflowManager` → `ComfyUIAPIManager`，独立路由页 `/settings/comfyui-api`，后端措辞统一为「ComfyUI API」
- [x] 建立 docs/ 统一文档目录

## 7. 待办 / 下一步（TODO）

- [ ] ComfyUI 运行功能（独立菜单/卡片式/入参表单/文件占位符/提交与进度）——设计方案见 `docs/COMFYUI-INTEGRATION.md`
- [ ] ComfyUI 客户端（HTTP + WebSocket 任务监听）
- [ ] SQLite 数据表补全：generation_runs / assets / canvas_docs
- [ ] 画布自定义节点：提示词、ComfyUI 生成、结果预览（从已导入工作流渲染节点）
- [ ] 生成任务队列与进度展示
- [x] ComfyUI 配置界面（服务地址）
- [ ] 前端产物由 NestJS 静态托管（单端口）
- [ ] 单文件 exe 打包（bun build --compile / pkg）
- [ ] 一键启动脚本（start.bat 固化两端启动）
