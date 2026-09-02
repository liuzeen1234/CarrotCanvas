# Canvas 集成 · 画布节点调用工作流设计

> 创建：2026-09-02
> 定位：记录「多画布 + 画布内节点编排调用 ComfyUI 工作流」的需求与已拍板技术方案，供跨 session 协作持续推进。它与 [COMFYUI-INTEGRATION.md](./COMFYUI-INTEGRATION.md) 是前后两个阶段：后者把工作流做成「可独立运行的工具箱」（已完成），本文件把这套运行能力搬到无限画布节点上，并由平台自有资产库保证画布自包含。需求仍在演进，本文档随决策更新，勿写死为完整 PRD。

## 1. 背景与目标

CarrotCanvas 的产品定位是「对接本地 ComfyUI，通过无限画布做流程节点编排」（见根 `README.md` / [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md)）。阶段一（COMFYUI-INTEGRATION）已在 **ComfyUI API 管理页**内实现「卡片 → 运行面板弹窗 → 提交出图」的独立工具箱闭环，但**画布页 `web/src/pages/canvas.tsx` 仍是 React Flow 骨架**（3 个写死的占位节点：提示词 → ComfyUI 生成节点 → 结果预览），无法真正生成。

本功能目标：

1. **画布是多实例的一等实体**：不存在唯一全局画布。用户可「新建画布」，拥有多张互相独立的画布，每张画布各自保存节点图；节点生成只发生在某个被打开的画布内部。
2. **画布节点直接调用工作流库中的工作流**：在画布里添加「文生图」节点并绑定一条已导入的 txt2img 工作流，填参数、点运行，结果直接在画布节点上呈现。
3. **一期只做文生图（txt2img）闭环**：现有工作流只覆盖文生图；「拿文生图结果再去做图生图」作为二期迭代，本文件先把数据流与存储设计打通但一期不启用图生图。
4. **画布自包含（方案 B，已拍板 2026-09-02，见 §4.6）**：用户上传图、文生图产物、图生图产物、后续视频等**一切中间产物都存到项目专属目录，并按画布分区存储**。打开任一画布只依赖平台自有资产即可看到全部内容——即使 ComfyUI 不在线、其 output 被清理，或绑定的工作流后来被更新/删除，历史中间产物仍能正常展示。

## 2. 现状（2026-09-02）

**可复用（阶段一已落地）：**

- ✅ 工作流库 CRUD：`GET/POST/PATCH/DELETE /api/workflows`，列表返回含 `category`（txt2img/img2img/txt2vid/...）、`apiJson`、`exposureConfig`
- ✅ schema 表单描述：`GET /api/comfyui/workflows/:id/schema`（apiJson + `/object_info` → 控件描述，跳过连接输入）
- ✅ 运行执行：`POST /api/comfyui/runs {workflowId, apiJson}` 提交 `/prompt`；`GET /api/comfyui/runs/:promptId` 轮询状态/进度/输出；`POST /api/comfyui/runs/:promptId/interrupt` 中断
- ✅ 结果描述与代理：运行输出只收集文件描述符 `{filename, subfolder, type, url, kind}`，图片经 `GET /api/comfyui/view` **实时流式代理** ComfyUI 的 `/view`（后端不落盘、不缓存）
- ✅ 图片上传：`POST /api/comfyui/upload/image`（base64 转发 ComfyUI `/upload/image` 写入其 input 目录，后端不留副本）
- ✅ 前端运行面板：`ComfyUIAPIManager.tsx` 已实现「schema 动态表单 + exposureConfig 主区/高级分区 + 值级写回 apiJson + 提交轮询 + 结果展示」，是本次要抽取复用的来源

**现状的关键缺口（本文件要解决）：**

- ❌ 生成字节**只存在 ComfyUI 的 output 目录**，CarrotCanvas 后端零落盘；运行态只在内存 Map（≤50 条、重启清空）。ComfyUI output 一旦被清理，历史结果即死链且无法恢复。
- ❌ 画布多实例：无画布实体 / 表 / 接口，路由只有单个 `/canvas` 骨架页
- ❌ 画布自定义节点类型、节点 ↔ 工作流绑定、节点内运行
- ❌ 平台资产库：根 README TODO 中的 `assets` 表、`canvas_docs` 表均未建

## 3. 需求要点（一期）

1. **画布列表与新建**：`/canvas` 是画布工作台首页——卡片网格列出所有画布（名称 / 更新时间 / 节点数 / 资产大小），可「新建画布 / 打开 / 重命名 / 删除」；从列表进入某张画布才打开编辑器 `/canvas/:id`。
2. **画布编辑器**：React Flow 画布 + 节点工具栏（添加提示词节点 / 文生图节点 / 结果节点）；节点可拖动、连线、删除；节点图改动**防抖自动保存**（个人本地工具，免手动 Ctrl+S），同时记住视口位置与缩放。
3. **三类节点（一期）**：
   - **提示词节点**：多行文本，输出主提示词；
   - **文生图生成节点**：绑定且只能绑定 `category=txt2img` 的工作流，节点内嵌暴露字段表单 + 运行/中断 + 进度 + 结果缩略图，向下输出图片；
   - **结果节点**：接在生成节点下游，做大图预览 / 放大 / 下载。
4. **运行**：在生成节点上点运行 → 复用阶段一运行链路提交 → 轮询进度 → **成功后产物捕获进本画布资产分区（§4.6）** → 结果回写本节点并同步给相连结果节点。一期为**手动逐节点运行**，不做整图一键跑。
5. **提示词连线**：提示词节点连到生成节点时，其文本在运行时覆盖该工作流的「主提示词字段」；未连线则用生成节点表单内自己的值。
6. **一期不做**：图生图 / 视频节点、本地上传图片输入节点、整图按拓扑一键运行、`generation_runs` 运行历史持久化（均列入 §4.7 后续路线）；但**资产存储机制一期就按「同时容纳上传图 / 生图 / 视频」设计**，后续直接复用。

## 4. 技术方案决策记录

### 4.1 多画布模型（已拍板：画布为一等实体，后端持久化）

- **实体 / 表**：新增 `canvas_docs` 表（沿用根 README TODO 已规划的命名），实体 `CanvasDoc`：

  | 列 | 类型 | 说明 |
  |---|---|---|
  | id | uuid PK | 同时作为资产目录分区键（§4.6） |
  | name | text | 画布名，缺省「未命名画布」 |
  | graph | simple-json | 序列化节点图 `{version, nodes, edges, viewport}`，新建时为空图 |
  | created_at / updated_at | 时间戳 | 由 `@CreateDateColumn/@UpdateDateColumn` 维护 |

  注册方式与现有实体一致：在 `database.module.ts` 的 `entities: [Workflow, Setting]` 中追加 `CanvasDoc`、`Asset`，`synchronize: true` 自动建列建表，无需手写迁移。
- **后端新模块 `backend/src/canvas/`**（画布 CRUD）与 `backend/src/assets/`（资产存储，§4.6），并在 `app.module.ts` 注册。
- **接口**：

  | 方法 | 路径 | 说明 |
  |---|---|---|
  | GET | /api/canvas | 画布列表（只回 id/name/时间戳/节点数/资产大小，不回大 graph） |
  | POST | /api/canvas | 新建（body: `name?`），返回空图画布并创建其资产分区目录 |
  | GET | /api/canvas/:id | 取单个（含完整 graph） |
  | PATCH | /api/canvas/:id | 改名 / 保存 graph（body: `name?` / `graph?`） |
  | DELETE | /api/canvas/:id | 删除画布，**级联删除其资产分区目录与 asset 行** |

- **前端路由**（`.umirc.ts`）：`/canvas` → 画布列表页；`/canvas/:id` → 画布编辑器。现单文件 `pages/canvas.tsx` 改为目录 `pages/canvas/index.tsx`（列表）+ `pages/canvas/editor.tsx`（编辑器）。
- **graph 持久化内容**：节点 `data` 中持久化 `workflowId/workflowName`、表单值、提示词文本、**最近一次成功运行的资产引用 `[{assetId, url, kind}]`（平台资产，见 §4.6），不存图片二进制，也不再直接存 ComfyUI 的 output 描述符作为展示依据**；运行中的瞬时进度/转圈状态不入库，刷新后按资产引用恢复结果、不恢复"运行中"。

### 4.2 一期节点模型（已拍板：3 类节点，仅文生图）

在 React Flow `nodeTypes` 注册三个自定义节点（`web/src/components/canvas/nodes/`）：

| 节点 | type | 输入句柄 | 输出句柄 | data 关键字段 |
|---|---|---|---|---|
| 提示词节点 | `prompt` | — | prompt 文本 | `{ promptText }` |
| 文生图生成节点 | `txt2img` | prompt（接提示词节点） | image（生成结果） | `{ workflowId, workflowName, formValues, lastAssets? }` |
| 结果节点 | `result` | image（接生成节点） | — | 读上游 `lastAssets`，自身不冗余存 |

- **生成节点只允许选 txt2img 工作流**：添加节点时的工作流选择器对 `GET /api/workflows` 结果按 `category === 'txt2img'` 过滤；选其他类型工作流的入口一期不出现（二期再放开 img2img）。
- **结果节点不复制引用**：通过连线找到上游生成节点，直接渲染其 `lastAssets` 对应的平台资产 URL；资产实体只存一份（在画布分区内）。
- **展示与重跑解耦**：节点结果图来自平台资产（永久可展示）；「重新运行」才需要工作流定义。工作流被删/改时，节点标注「工作流缺失/已更新，不可重跑」，但**历史结果图照常显示**。
- **节点外观**：统一卡片式——头部（类型标签 + 绑定名 + 运行/中断按钮）、主体（表单或预览）、底部（状态/进度条），风格与 AntD 一致。

### 4.3 生成节点 = 工作流调用壳（运行协议复用 + 新增资产捕获）

- 生成节点本身不含 ComfyUI 协议逻辑，只是「绑定一条工作流 + 提供入参 + 触发运行 + 展示结果」的壳。**提交 `/prompt`、WebSocket 监控、中断等 runner 核心逻辑不改**；复用阶段一的 `ComfyUIRunnerService`。
- **与工具箱运行的区别：携带画布上下文，触发资产捕获**。`POST /api/comfyui/runs` 的 body 在现有 `{workflowId, apiJson}` 上扩展可选 `canvasId`、`nodeId`：
  - **带 `canvasId`（画布节点发起）**：运行成功后由资产服务把每个输出文件的字节从 ComfyUI 捕获、落盘到该画布分区并建 asset 行，输出描述里附带 `assetId` 与平台 URL（§4.6）。
  - **不带 `canvasId`（ComfyUI API 管理页工具箱发起）**：维持现状，只做实时代理展示、不落盘，避免改变工具箱行为。
- **前端共享逻辑抽取**：把 `ComfyUIAPIManager.tsx` 中的「schema 表单渲染、`applyFormValues` 值级写回、提交 + 轮询 + 中断、exposureConfig 主区/高级分区」抽到 `web/src/components/comfyui/`（建议 `useComfyRun.ts` 钩子 + `ComfySchemaForm.tsx` 组件 + 按 workflowId 缓存 schema），设置页运行面板与画布生成节点共用同一份，禁止两处各写一套。
- **节点运行步骤**：
  1. 绑定工作流时拉 `GET /api/comfyui/workflows/:id/schema`（按 workflowId 缓存）；
  2. 深拷贝工作流 `apiJson` → `applyFormValues` 写入节点表单值 → 若连了提示词节点，再覆盖主提示词字段（§4.4）；
  3. `POST /api/comfyui/runs {workflowId, apiJson, canvasId, nodeId}` 拿 promptId；
  4. 轮询 `GET /api/comfyui/runs/:promptId`，把 status/progress 更新到节点瞬时态；
  5. `success` → 输出已被捕获为平台资产，拿 `[{assetId, url, kind}]` 写入 `node.data.lastAssets`（触发自动保存）并刷新下游结果节点；`error` → 节点内直接展示错误信息。
- **单队列提示**：ComfyUI 串行执行，多个生成节点先后运行会排队。节点状态复用 runner 的 `RunStatus`：`pending`（排队中）/ `running`（运行中）/ `success` / `error` / `interrupted` / `unknown`。

### 4.4 连线数据流（一期只传提示词；为二期图生图预留）

- **一期**：连线只承担两类关系，且都在**前端运行时**解析、不经后端：
  - **提示词节点 → 生成节点**：把文本注入工作流「主提示词字段」。主提示词字段定义为该工作流 schema 中第一个 `control === 'textarea'`（multiline STRING）的暴露字段；若工作流有多个多行字段（如正向/负向提示词），其余仍在生成节点表单内填写，一期不做"多提示词节点路由到不同字段"（二期可在连线上选目标字段）。
  - **生成节点 → 结果节点**：结果节点读上游 `lastAssets`，用平台资产 URL 展示。
- **二期预留（本次不启用，仅定方向）**：生成/结果节点 → 图生图节点，把上游资产作为下游 LoadImage 入参。执行前做「ComfyUI 可达性兜底」：该图最初由 ComfyUI 生成、其 output 里通常还在，可直接用 `{filename, subfolder, type:'output'}` 零拷贝引用；**若 output 已被清理，则用平台分区里保存的资产副本重新 `/upload/image` 回灌 ComfyUI input 再提交**——这正是方案 B 自包含的价值：换机器、清过 output 也能基于历史产物继续图生图。

### 4.5 画布持久化与一致性（已拍板：防抖自动保存）

- 节点 / 连线 / 视口变化后 **debounce ≈ 800ms** 调 `PATCH /api/canvas/:id {graph}`；编辑器顶部给轻量「保存中 / 已保存」指示。
- 个人本地单用户场景，不做多人协同，也不处理多标签页冲突合并（同一画布多标签同开时以最后一次写入为准，一期接受）。
- 删除画布需二次确认，删除时连带清理其资产分区（§4.6）。**删除/更新工作流不级联影响画布与资产**：画布内引用它的生成节点保留、历史结果照常展示，仅标注「绑定工作流已缺失/已更新」，引导重新选择一条 txt2img 工作流后再跑。

### 4.6 中间产物与资产存储（方案 B，已拍板 2026-09-02）

**结论**：一切中间产物（用户上传图、文生图产物、图生图产物、后续视频/音频）都由**平台后端存到项目专属目录，并按画布分区**；画布展示只走平台自有资产 URL，不依赖 ComfyUI。放弃「只存 ComfyUI output 指针」的零拷贝方案（方案 A），因其在 ComfyUI output 被清理后会死链、画布不自包含。

#### 4.6.1 目录结构（分区维度 = 画布）

与 SQLite 文件 `data/carrot-canvas.sqlite` 同目录，新增 `data/assets/`，一级目录即画布 id：

```
backend/data/
├─ carrot-canvas.sqlite
└─ assets/
   └─ <canvasId>/                 # 一张画布一个分区，删画布即整目录清除
      ├─ upload/                  # 用户上传的入参图（二期图生图用）
      │  └─ <assetId>__<safeName>
      └─ generated/               # 文生图 / 图生图 / 视频 等生成产物
         └─ <assetId>__<safeName>
```

- 文件名以 `assetId` 前缀保证全局唯一、避免 ComfyUI 同名覆盖；`safeName` 仅保留可读原名并做路径清洗，**禁止任何用户输入直接拼路径（防目录穿越）**。
- 不再按节点/运行嵌套：节点、运行、来源类型都记在 asset 行里，查询与清理靠数据库，目录保持两级、简单可靠。

#### 4.6.2 `assets` 表

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | 同时作为文件名前缀 |
| canvas_id | text，索引 | 归属画布（分区键）；删画布级联删行 |
| node_id | text nullable | 由哪个画布节点产生/使用 |
| kind | text | `image` / `video` / `audio` |
| source | text | `generated`（生成产物）/ `upload`（用户上传） |
| run_prompt_id | text nullable | 来自哪次 ComfyUI 运行 |
| workflow_id | text nullable | 生成时绑定的工作流，**仅溯源；工作流删除不影响资产** |
| rel_path | text | 相对 `data/assets` 的路径 |
| origin_name | text nullable | ComfyUI 输出名 / 上传原始名 |
| mime | text nullable | 内容类型 |
| size | integer nullable | 字节数 |
| created_at | 时间戳 | |

#### 4.6.3 三类来源的入库方式

1. **生成产物（一期：文生图）**：`/runs` 带 `canvasId` 时，运行成功后资产服务对每个输出文件用现有 ComfyUI `/view` 通道**拉取字节** → 写入 `<canvasId>/generated/` → 建 asset 行 → 在 run 输出里回 `{assetId, url:'/api/assets/:id', kind}`。生成图在 ComfyUI output 的原件保留不动（平台存的是副本）。同一节点重跑按 §4.6.4 覆盖清理其上一版产物。
2. **用户上传（二期：图生图入参）**：新增画布级上传端点 `POST /api/canvas/:canvasId/assets/upload`，**先存项目副本**到 `<canvasId>/upload/` 并建行（source=upload），**同时转发** ComfyUI `/upload/image` 到其 input 目录以保证本次可运行；返回 `{assetId, platformUrl, comfyName}`。现有 `/api/comfyui/upload/image`（只转发、不留副本）继续服务工具箱。
3. **视频/音频（后续）**：走与生成产物相同的捕获通道，仅 `kind` 不同；平台读取端点后续补 HTTP Range 以支持视频拖动。

#### 4.6.4 读取与生命周期

- **读取**：`GET /api/assets/:id` 按 asset 行定位文件并流式返回（Content-Type 按 mime；下载用 `GET /api/assets/:id/download` 带 Content-Disposition）。只允许按 id 查行取文件，不接受前端传任意路径。
- **打开画布即自包含**：画布 graph 持有的是 assetId；展示只请求平台 `/api/assets/:id`，与 ComfyUI 是否在线、output 是否存在、工作流是否被删均无关。
- **删画布**：级联删除 `data/assets/<canvasId>/` 整目录与对应 asset 行（按画布分区使清理干净、无孤儿）。
- **节点重新生成 = 覆盖清理（一期策略，已拍板 2026-09-02）**：一期不保留历史——某生成节点再次运行成功、新产物捕获完成后，删除该节点（同 `canvas_id` + `node_id` + `source='generated'`）上一版的 asset 行与磁盘文件，只保留本次最新一组输出（批量多图则整组替换）。顺序上**先成功捕获新产物、再清旧产物**，避免捕获失败时把上一版也丢光。用户上传的入参图（`source='upload'`）不是节点产物，不在覆盖范围。
- **删除节点**：一期一并删除该节点的 generated 资产（无历史版本时它们是无引用孤儿）；`source='upload'` 的上传图若已不被任何节点引用则一并清理。
- **删/改工作流**：资产不动。
- **不做内容去重**：每次生成独立文件，靠覆盖清理控制占用；资产大小在画布列表展示。**历史版本链与「从多版结果中挑选最佳结果」后续再做（§4.7），届时生成策略由覆盖改为追加并保留版本链。**

### 4.7 分期路线

| 期 | 范围 |
|---|---|
| **一期（本次）** | 多画布 CRUD + 列表/编辑器路由 + 节点图持久化；提示词 / 文生图 / 结果三类节点，仅绑 txt2img；**资产库落地（assets 表 + `data/assets/<canvasId>` 分区 + 生成成功自动捕获文生图产物 + `/api/assets/:id` 展示）**；单节点运行出图；提示词连线；防抖自动保存；断 ComfyUI 仍可查看历史结果 |
| **二期** | 图生图生成节点（绑 img2img）；画布内上传入参图（存 upload 分区并转发 ComfyUI）；图生图产物捕获；连线喂图与「output 不在则用平台副本回灌」兜底（§4.4）；正/负向多提示词字段路由 |
| **后续** | 文生 / 图生视频、音频节点与产物捕获、Range 流式播放；整图按拓扑一键运行；`generation_runs` 运行历史持久化；**节点历史版本链 + 最佳结果挑选（生成策略由覆盖改追加）**；资产大小统计与清理、参数预设 / 节点模板 |

## 5. 落地步骤（当前进度）

- [x] C1 后端数据层：`canvas` 模块（`CanvasDoc` + 五个 CRUD 接口）与 `assets` 模块（`Asset` 实体、`data/assets/<canvasId>` 分区读写、`/api/assets/:id` 读取/下载、删画布级联清理），实体注册进 `database.module.ts`，`tsc` 编译通过
- [ ] C2 后端运行捕获：`/api/comfyui/runs` 扩展 `canvasId/nodeId`；带画布时运行成功自动把输出字节捕获进对应分区并回 asset 引用，且按节点覆盖清理上一版 generated 资产（先建新后清旧，§4.6.4）；不带画布的工具箱运行维持现状（代理不落盘）
- [ ] C3 前端：路由改造（`/canvas` 列表 + `/canvas/:id` 编辑器）+ 画布列表页（新建 / 打开 / 重命名 / 删除，展示资产大小）
- [ ] C4 前端：抽取共享运行逻辑到 `components/comfyui/`（`useComfyRun` + `ComfySchemaForm`），设置页运行面板改走共享件且行为不回归
- [ ] C5 前端：三类自定义节点 + 节点工具栏 + 工作流选择器（仅 txt2img）
- [ ] C6 前端：节点内运行（提交 / 轮询 / 中断 / 状态）+ 结果走平台资产 URL 展示 + 提示词连线注入；工作流缺失时历史结果仍可见
- [ ] C7 前端：画布防抖自动保存 + 视口持久化 + 刷新恢复（关掉 ComfyUI 也能看历史产物）；`pnpm build` 通过并端到端手测：建画布 → 绑 txt2img 工作流 → 连提示词 → 出图并确认落盘到 `data/assets/<canvasId>/generated/` → 同节点重跑确认旧产物被覆盖清理、只留最新一组 → 关 ComfyUI 刷新仍见图 → 删工作流结果不丢 → 删画布目录被清 → 建第二张画布资产互不串

### 5.1 依赖顺序、可并行项与里程碑

- **C1 是地基，必须最先做**（画布表 + 资产存储）；**C2 依赖 C1**（捕获产物要写资产分区）。
- **C3 只依赖 C1 的画布 CRUD，可与 C2 并行**。
- **C4 是对阶段一既有代码的纯抽取重构，不依赖 C1–C3，可随时并行启动**；且它是 **C5/C6 的前置**（先抽出共享运行件，节点才不用写第二套）。
- **C5 需要 C3（编辑器路由）+ C4（共享件）就位**；**C6 需要 C5（节点外壳）+ C2（产物捕获接口）就位**；**C7 收口于 C6**（画布持久化接口在 C1 已备好）。
- **C5 → C6 → C7 串行**：先有节点外壳才能接节点内运行，跑通后再做自动保存与总验收。

依赖示意（`→` 为前置，`‖` 为可并行）：

```
C1 数据底座 ─┬─→ C2 产物捕获 ──────────────────┐
            └─→ C3 路由/画布列表 ‖ C2          │
C4 抽共享件（不依赖 C1–C3，可随时并行）→ C5 节点外壳 ─┴→ C6 节点出图 → C7 保存/恢复/验收
```

- 关键里程碑：
  - **C2 完成 = 后端能自动落产物**（平台资产库可用）；
  - **C6 完成 = 画布能出图**（一期核心闭环打通）；
  - **C7 完成 = 刷新不丢、关掉 ComfyUI 历史结果仍在，一期可交付**。

## 6. 与 COMFYUI-INTEGRATION 的边界

- **COMFYUI-INTEGRATION（阶段一，已完成）**：以「ComfyUI API 管理页」为载体的独立工具箱，解决「工作流能被导入、校验、填参、独立运行」，产出被本文件复用的运行引擎；其运行结果是**实时代理 ComfyUI output、不落盘**的。
- **CANVAS-INTEGRATION（本文件，阶段二）**：以「无限画布」为载体，把同一运行引擎包装成画布节点，新增多画布管理、节点图持久化，以及**平台自有资产库（方案 B）**。阶段二**不改 runner 的提交 / WebSocket 监控协议**，但在其成功后新增一层「输出字节捕获 → 按画布分区落盘」，使画布自包含。
- 两处共用：schema 分析、`exposureConfig`、`/api/comfyui/runs`、前端共享运行组件。工作流的导入 / 编辑 / 暴露字段配置仍只在 ComfyUI API 管理页维护，画布只消费、不编辑工作流定义；工具箱运行不产生平台资产，只有画布节点运行（带 `canvasId`）才落资产。

## 7. 变更日志

- 2026-09-02（实现）：**C1 后端数据层落地**——新增 `backend/src/canvas`（`CanvasDoc` + 建/列/取/改/删 5 接口，列表含节点数与资产大小，新建自动建分区，删画布级联清资产）与 `backend/src/assets`（`Asset` 实体 + `data/assets/<canvasId>` 分区读写 + `/api/assets/:id` 读取、`/api/assets/:id/download` 下载），实体注册进 `database.module.ts`；`tsc` 编译通过并端到端验证（建画布→分区→改名存图→写资产→读/下载→统计→级联删除，全 PASS）。同日补齐单元测试栈（Jest + ts-jest + supertest，`pnpm test`，4 suite / 29 用例全绿）。
- 2026-09-02（设计）：§5 补「依赖顺序 / 可并行项 / 关键里程碑」（§5.1）——C1 为地基、C2 依赖 C1、C3 与 C2 并行、C4 为纯重构可随时并行且是 C5/C6 前置、C5→C6→C7 串行。
- 2026-09-02（设计更新）：节点产物策略定为**一期覆盖清理**——同一节点重跑成功后删除其上一版 generated 资产（行 + 文件）、只留最新一组，先建新后清旧；删节点同步清其产物，上传入参图不在覆盖范围。历史版本链与「最佳结果挑选」留后续，届时由覆盖改为追加（§4.6.4 / §4.7）。
- 2026-09-02（设计更新）：**拍板中间产物走方案 B（平台自有资产库）**——新增 §4.6：`data/assets/<canvasId>/` 按画布分区、`assets` 表、生成捕获 / 上传副本 / 视频三类入库方式、`/api/assets/:id` 读取、删画布级联清理、展示与重跑解耦（工作流删改不影响历史产物展示）；§4.3 `/runs` 扩展 `canvasId/nodeId` 并区分工具箱（不落盘）与画布（落资产）；§4.4 补「output 缺失时用平台副本回灌 ComfyUI」兜底；落地步骤由 C1–C6 扩为 C1–C7。
- 2026-09-02（设计）：确立「多画布一等实体 + 一期仅文生图」的分期方案；确定 `canvas_docs` 表与 `/api/canvas` 接口、三类节点模型、共享运行逻辑抽取、防抖自动保存，并为二期图生图数据流预留方向。
