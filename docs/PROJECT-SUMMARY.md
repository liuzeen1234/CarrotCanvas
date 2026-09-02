# CarrotCanvas 项目现状总结

> 最后更新：2026-09-02
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
│  ├─ COMFYUI-INTEGRATION.md    # ComfyUI 集成·运行功能设计（阶段一：独立工具箱，已落地①-⑦）
│  └─ CANVAS-INTEGRATION.md     # Canvas 集成·画布节点调用工作流（阶段二：多画布/一期仅文生图，C1 后端数据层 + C2 产物捕获已完成）
├─ backend/                     # NestJS 后端
│  ├─ src/
│  │  ├─ main.ts                # 入口，端口 3100
│  │  ├─ app.module.ts
│  │  ├─ app.controller.ts      # GET /api/health
│  │  ├─ app.service.ts
│  │  ├─ database/
│  │  │  └─ database.module.ts   # TypeORM + better-sqlite3（数据文件 data/carrot-canvas.sqlite）
│  │  ├─ workflows/              # ComfyUI API（工作流）管理模块
│  │  │  ├─ workflow.entity.ts
│  │  │  ├─ workflows.module.ts / controller.ts / service.ts
│  │  │  └─ comfyui-validator.ts # ComfyUI API 格式校验
│  │  ├─ comfyui/                # ComfyUI 集成（步骤②③：工作流导入 + 运行执行 + 画布产物捕获）
│  │  │  ├─ comfyui-client.ts    # HTTP 客户端（/userdata、/object_info、/prompt、/view、/upload/image，含 fetchViewFile 拉字节）
│  │  │  ├─ comfyui-schema.service.ts # schema 分析：apiJson + /object_info → 可编辑入参表单描述
│  │  │  ├─ comfyui-graph-converter.ts # 复刻官方 graphToPrompt UI→API 转换（子图展开/Reroute 穿透）
│  │  │  ├─ comfyui-runner.service.ts  # 提交 + WebSocket 监控 + 输出收集（内存运行状态；提交前确保 WS 就绪）
│  │  │  ├─ comfyui-capture.service.ts # C2 画布产物捕获：输出字节落盘资产分区 + 按节点覆盖清理旧产物
│  │  │  ├─ comfyui.controller.ts      # /api/comfyui/* 端点
│  │  │  └─ comfyui.module.ts
│  │  ├─ canvas/                 # Canvas C1：画布一等实体（CanvasDoc + 建/列/取/改/删 5 接口，删画布级联清资产）
│  │  │  ├─ canvas.entity.ts
│  │  │  ├─ canvas.service.ts / controller.ts / module.ts
│  │  └─ assets/                 # Canvas C1：平台资产库（Asset + data/assets/<canvasId> 分区读写 + /api/assets/:id 读/下载）
│  │     ├─ asset.entity.ts
│  │     ├─ assets.service.ts / controller.ts / module.ts
│  ├─ package.json              # @carrot-canvas/backend
│  ├─ tsconfig.json / tsconfig.build.json
└─ web/                         # Umi + AntD 前端
   ├─ .umirc.ts                 # proxy /api → 3100
   ├─ src/
   │  ├─ pages/index.tsx        # 首页
   │  ├─ pages/canvas/index.tsx # 画布工作台（列表：新建/打开/重命名/删除，展示资产大小）
   │  ├─ pages/canvas/editor.tsx # 画布编辑器（加载 graph + React Flow 渲染 + 顶栏）
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
- ✅ 前端 ComfyUI API 管理：列表 CRUD + 导入/校验（卡片/列表视图），含 ComfyUI 地址配置与连接测试
- ✅ 工作流导入（步骤②）：后端 /api/comfyui/workflows 从 8188 /userdata 拉取已保存工作流，复刻官方 graphToPrompt 转 API 格式（新旧格式 + 子图展开 + Reroute 穿透），/preview 预览、/import 入库；前端「从 ComfyUI 导入」弹窗（选文件→预览→导入）
- ✅ 运行执行（步骤③）：POST /api/comfyui/runs 提交 /prompt，WebSocket 监控进度，GET /runs/:promptId 轮询，成功回写 `thumbnail_path`，/api/comfyui/view 代理输出图片；前端运行面板（提交→进度→结果缩略图→缩略图刷新）。**修复**：提交前先确保 WS 连接就绪（ComfyUI 在提交时该 client 的 WS 未连接则不下发 execution 消息，run 会卡 pending）
- ✅ 入参动态表单（步骤④⑤）：GET /api/comfyui/workflows/:id/schema 结合 /object_info 分析可编辑入参（文本/数值/下拉/图片，跳过连接输入，只暴露无连接 widget）；前端运行前自动表单渲染 + 值写回 apiJson + JSONText 模式切换（实测修改 filename_prefix 提交后 ComfyUI 输出文件名生效）
- ✅ 图片上传（步骤⑥）：POST /api/comfyui/upload/image（base64 JSON 转发 ComfyUI /upload/image 写入 input 目录，后端 body 限制 15mb）；LoadImage 控件支持上传新图 / 选择已有图（实测 465KB 图片上传成功并被 ComfyUI /object_info 识别）
- ✅ 前端构建通过（`pnpm build`；**修复**：Umi 4 + esbuild minify 的分包 IIFE helper 冲突导致构建失败，按提示在 `.umirc.ts` 增加 `esbuildMinifyIIFE: true`）
- ✅ 画布多实例 CRUD（Canvas C1）：`/api/canvas` 建/列/取/改/删，列表只回元信息 + 节点数 + 资产大小；新建画布自动创建 `data/assets/<canvasId>/` 分区；删画布级联清理其资产分区与 asset 行（已端到端验证）
- ✅ 平台资产库（Canvas C1）：`assets` 表（12 列与设计一致）+ `data/assets/<canvasId>` 分区读写（`saveGenerated`/`saveUpload` 服务层）+ `/api/assets/:id` 读取、`/api/assets/:id/download` 下载
- ✅ 画布产物捕获（Canvas C2）：`POST /api/comfyui/runs` 扩展 `canvasId/nodeId`（画布生成节点发起），运行成功后经 `ComfyUIAssetCaptureService` 把输出字节从 ComfyUI `/view` 拉取落盘进该画布 `generated/` 分区并回填 `assetId/assetUrl` 到 run.outputs；同节点重跑按 §4.6.4 覆盖清理旧产物（`deleteGeneratedByNode` 支持 `keepIds` 保留本次新捕获，先建新后清旧）；不带 canvasId 的工具箱运行维持代理不落盘（已端到端验证：出图落盘 → 同节点重跑旧资产 404 只留新一组 → 删画布级联清目录）
- ✅ 单元测试：Jest + ts-jest + supertest 测试栈，`pnpm test` 运行，**5 个 suite / 35 用例全绿**（canvas / assets 单测 + controller 接口测试 + `comfyui-capture` 捕获服务单测）；`AssetsService` 支持 `CARROT_ASSETS_ROOT` 环境变量覆盖资产根目录（测试隔离用，默认仍为 `data/assets`）
- ✅ 画布列表与编辑器路由（Canvas C3）：`.umirc.ts` 路由 `/canvas → ./canvas/index`（画布工作台列表）、`/canvas/:id → ./canvas/editor`（编辑器）；列表页卡片网格（新建/打开/重命名/删除，删除二次确认，展示节点数/资产大小/更新时间）；编辑器加载画布 graph + React Flow 渲染节点/连线/视口 + 顶栏；旧 `pages/canvas.tsx` 骨架页已删除（已端到端手测：建→开→改名→删全通）
- ✅ 画布共享运行组件（Canvas C4）：抽取共享运行逻辑到 `web/src/components/comfyui/`（`types.ts` + `useComfyRun` 钩子 + `ComfySchemaForm` + `ComfyRunModal`），设置页运行面板改走共享件（schema 按 workflowId 缓存），行为不回归
- ⏳ 画布节点编排（Canvas C5–C7）待做：三类自定义节点（提示词/文生图/结果）、节点内运行出图、防抖自动保存与视口持久化；方案见 [CANVAS-INTEGRATION.md](./CANVAS-INTEGRATION.md)（阶段二，一期仅文生图；后端 C1/C2 已完成，前端 C3 列表/编辑器路由、C4 共享运行组件已完成）
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
6. **pnpm 严格依赖隔离**：backend 需直接声明 `body-parser`（1.x，含 `@types/body-parser` dev 依赖）——main.ts 用它设置 JSON body 上限 15mb，支持图片 base64 上传；express 等通过 pnpm `.pnpm` 内部链接解析，勿用 npm 在 backend 下装包（会破坏 workspace）。

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
- [x] ComfyUI 工作流导入（步骤②）：8188 拉取 UI 工作流 → 复刻 graphToPrompt 转换（含子图展开/Reroute 穿透/新旧格式）→ 校验 → 入库；前端「从 ComfyUI 导入」交互（实测新/旧格式转换）
- [x] ComfyUI 运行执行（步骤③）：/prompt 提交 + WebSocket 监控 + 输出收集 + 缩略图写回 + 图片代理；前端运行面板（实测端到端生成成功）
- [x] ComfyUI 入参动态表单（步骤④⑤）：schema 分析接口（apiJson + /object_info → 表单描述）+ 前端自动表单 / JSONText 切换 / 值写回提交（实测修改 filename_prefix 生效）
- [x] ComfyUI 图片上传（步骤⑥）：/upload/image base64 转发写 input 目录 + LoadImage 上传/选择控件（实测 465KB 上传被 ComfyUI 识别）

## 7. 待办 / 下一步（TODO）

- [x] ComfyUI 运行执行（独立菜单/卡片式 + 提交与进度）——核心已落地，入参表单/文件占位符见步骤④⑤（`docs/COMFYUI-INTEGRATION.md`）
- [x] ComfyUI 客户端（HTTP + WebSocket 任务监听）
- [ ] SQLite 数据表补全：generation_runs / assets / canvas_docs（运行状态当前为内存态，未持久化）
- [ ] 画布自定义节点：提示词、ComfyUI 生成、结果预览（从已导入工作流渲染节点）
- [x] 入参动态表单（/object_info 拉取 + schema 分析，步骤④⑤）
- [ ] 生成任务历史持久化（generation_runs 表）
- [x] ComfyUI 配置界面（服务地址）
- [ ] 前端产物由 NestJS 静态托管（单端口）
- [ ] 单文件 exe 打包（bun build --compile / pkg）
- [ ] 一键启动脚本（start.bat 固化两端启动）
