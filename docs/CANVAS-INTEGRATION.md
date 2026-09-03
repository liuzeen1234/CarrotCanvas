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
2. **画布编辑器**：React Flow 画布 + **右键上下文菜单添加节点**（见下第 3 条与 §4.2.1）；节点可拖动、连线、删除；节点图改动**防抖自动保存**（个人本地工具，免手动 Ctrl+S），同时记住视口位置与缩放。
3. **节点添加交互 = 右键分级菜单（已拍板 2026-09-02）**：在画布任意空白处**右键**弹出上下文菜单，一级按工作流分类（文生图 / 图生图 / …），悬停「文生图」展开二级菜单列出该分类下所有已导入工作流；点某个工作流即在**右键处（该位置作为新节点左上角）**落一个绑定好该工作流的**生成节点**。一期只有「文生图」分类可用，其余分类项**置灰**（无可用工作流时同样置灰）。
4. **两类一等节点（一期，提示词并入生成节点，不做独立提示词节点）**：
   - **生成节点**：右键菜单落下时即绑定所选 `category=txt2img` 工作流，节点内嵌**自动生成的暴露字段表单**（与 ComfyUI API 管理页运行面板同一套），提示词作为表单里的一个多行字段直接填写；含运行按钮 + 中断 + 进度 + 状态；有一个 image 输出句柄向下输出图片。
   - **结果节点**：接在生成节点 image 输出下游，展示 loading / 生成结果（大图预览 / 放大 / 下载）。一期结果节点**由运行动作自动创建并连线**（见第 5 条），一般不需用户手动添加。
5. **运行与结果节点自动连出（已拍板 2026-09-02）**：在生成节点上点运行 → **先做参数完整性校验**（缺必填项则提示、不提交）→ 通过则复用阶段一运行链路提交 → 若该生成节点的 image 输出口尚未连结果节点，**自动在其右侧创建一个结果节点并连线**，结果节点立即进入 loading → 轮询进度 → **成功后产物捕获进本画布资产分区（§4.6）** → 结果回写本节点并同步给相连结果节点展示图片。一期为**手动逐节点运行**，不做整图一键跑。
6. **通用输出模型**：每个会产出内容的节点至少有一个**输出句柄**（一期仅 `image`，句柄带 `kind`），其输出可作为下游节点的输入；连线按 `kind` 做兼容校验（一期只有 image）。
7. **提示词覆盖（可选增强，非必需节点）**：一期不提供独立提示词节点，提示词就在生成节点表单里填。二期若引入提示词节点，连到生成节点时其文本覆盖「主提示词字段」；未连线则用生成节点表单内自己的值。
8. **一期不做**：图生图 / 视频节点、独立提示词节点、本地上传图片输入节点、整图按拓扑一键运行、`generation_runs` 运行历史持久化（均列入 §4.7 后续路线）；但**资产存储机制一期就按「同时容纳上传图 / 生图 / 视频」设计**，后续直接复用。

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

在 React Flow `nodeTypes` 注册两个自定义节点（`web/src/components/canvas/nodes/`；一期不做独立提示词节点，提示词并入生成节点表单）：

| 节点 | type | 输入句柄 | 输出句柄 | data 关键字段 |
|---|---|---|---|---|
| 生成节点 | `txt2img` | —（一期无上游输入，提示词在表单内填） | image（生成结果，句柄带 `kind:'image'`） | `{ workflowId, workflowName, formValues, lastAssets? }` |
| 结果节点 | `result` | image（接生成节点） | — | 读上游 `lastAssets`，自身不冗余存 |

- **生成节点由右键菜单落下时即绑定工作流**：右键分级菜单只列 `category === 'txt2img'` 的工作流（§4.2.1），其余分类项置灰；节点创建即带 `workflowId/workflowName`，不再有节点内的"选工作流"步骤（二期放开 img2img 时增加对应分类项）。
- **提示词并入生成节点表单**：提示词是 schema 表单里的一个多行字段（`control === 'textarea'`），随其它暴露字段一起填，无需独立提示词节点。
- **节点内表单布局约束（已拍板 2026-09-02，随 C5 实现）**：画布节点是窄容器且嵌在可缩放/平移的画布里，故节点内表单**必须单列、控件全宽、卡片内无滚动条**——
  - 复用共享件 `ComfySchemaForm` 时传 `singleColumn`（每字段独占一行、`Col span=24`、`Row gutter=0`）与 `scroll={false}`（不设 maxHeight、`overflow:visible`，节点按内容自然撑高）；
  - textarea 用 `autoSize`（随输入长高），节点外层高度自适应；
  - 节点容器 `overflow:hidden`、`box-sizing:border-box`，杜绝内部横/纵向滚动条与画布滚动冲突。
  - 设置页运行面板（`ComfyRunModal`）不传这两个开关，维持原两列 + 限高滚动，行为不变。
- **结果节点由运行自动创建**：见 §4.3.1；结果节点通过连线找到上游生成节点，直接渲染其 `lastAssets` 对应的平台资产 URL，资产实体只存一份（在画布分区内），结果节点不复制引用。
- **展示与重跑解耦**：节点结果图来自平台资产（永久可展示）；「重新运行」才需要工作流定义。工作流被删/改时，节点标注「工作流缺失/已更新，不可重跑」，但**历史结果图照常显示**。
- **节点外观**：统一卡片式——头部（类型标签 + 绑定名 + 运行/中断按钮 + **删除按钮**）、主体（表单或预览）、底部（状态/进度条），风格与 AntD 一致。
- **节点删除 = 二次确认（随 C5 实现）**：两类节点头部均有红色删除按钮，点击弹 AntD `Popconfirm` 二次确认后才删；删除经画布 Context 的 `deleteNode(nodeId)` 从受控 `nodes` 移除该节点并连带清理其相连 `edges`。删除按钮带 `nodrag` 避免误触发拖动。（画布级资产随节点删除的清理见 §4.6.4，属 C6。）

### 4.2.1 右键分级菜单（已拍板 2026-09-02）

- **触发**：React Flow 画布空白处右键，用 `onPaneContextMenu(event)` 阻止默认菜单并记录 `event.clientX/clientY`；用 AntD `Dropdown`/菜单在该屏幕坐标渲染。
- **菜单结构**：一级 = 工作流分类（文生图 / 图生图 / 文生视频 …，来自 `workflow.category` 的集合）；悬停「文生图」展开二级 = 该分类下所有工作流（`GET /api/workflows` 已返回 `category`，前端按 `category === 'txt2img'` 过滤后列出 name）。
- **置灰规则**：一期只有「文生图」分类项可点；其它分类项、以及某分类下无已导入工作流时，**disabled 置灰**，不隐藏（让用户知道后续会有）。
- **落点坐标**：把右键的屏幕坐标经 React Flow `screenToFlowPosition({x,y})` 转成画布坐标，作为新节点 `position`（**该点即节点左上角**）。
- **落下动作**：`addNodes` 一个 `type:'txt2img'` 生成节点，`data` 带选中的 `workflowId/workflowName`，`formValues` 初始按 schema 默认值填充。

**实现要点（C5 落地踩坑记录，避免后人重复）：**
- **右键监听挂在画布外层容器的 `onContextMenu` 上，不用 React Flow 的 `onPaneContextMenu`**：后者仅在命中空白 pane 时触发，用容器 `onContextMenu` 更稳且不受 pane 判定影响；handler 内 `preventDefault()` 屏蔽浏览器原生菜单，记录 `clientX/clientY`。
- **菜单用 fixed 定位的 AntD `Menu` 浮层，不用受控 `Dropdown`**：受控 `Dropdown`（`open` + `trigger={[]}` + 0 尺寸锚点）定位不可靠、实测弹不出；改为在右键屏幕坐标处渲染 `position:fixed` 的 `Menu`（自带视口边缘夹取防溢出）。
- **关闭用 `click`（非 `mousedown`）+ contextmenu + Esc**：AntD 二级子菜单弹层渲染在 `document.body`，若用 `mousedown` 做"外部点击关闭"会先于 `Menu` 的选中 `onClick` 触发 → 菜单先卸载 → 二级项点击不触发 `onPick`（曾导致"点工作流不落节点"）。改用 `click`（晚于选中 onClick）并放行 `.ant-menu-submenu-popup`，点空白/别处右键/Esc 均可关闭。
- **落点坐标**：选中后经 `screenToFlowPosition({x:clientX,y:clientY})` 转画布坐标；`screenToFlowPosition` 未就绪时 try/catch 兜底到原点，不阻塞落节点。
- **前端分类副本**：右键一级分类来自 `web/src/components/canvas/workflowCategories.ts`（与后端 `workflow-category.ts` 保持一致的副本，前端无法直接 import 后端）。

### 4.2.2 移动端支持：长按替代右键 + 窄屏布局（已拍板 2026-09-03）

**定位**：主力桌面开发；移动端仅需「能用即可」——作者远程（Tailscale 连回家庭网络）用手机验证远程 AI 开发效果，能建节点跑通即可，不做小屏 UI 深度优化。

- **长按 = 右键的移动端替代**：画布空白处**按住 ~450ms 且移动 < 16px** 判定为长按 → 在触点坐标打开与右键相同的分级菜单（复用同一 `openMenu(x,y)`）；移动过多（视为平移画布）/ 多指（缩放）/ 提前抬手则取消。
  - **实现要点（踩坑）**：长按检测**必须用原生 `touchstart/touchmove/touchend` 监听、挂容器 DOM 且 `capture:true`**——React 合成 `onTouchStart`（冒泡阶段）会被 React Flow 内部 d3-zoom 平移手势抢先/干扰导致收不到；capture 让容器先于内部拿到事件。监听用 `passive:true` 不阻断画布双指缩放。长按打开菜单后短时（~600ms）用 `onClickCapture` 抑制随之而来的合成 `click`，否则菜单被「外部点击关闭」立刻关掉。
  - 容器加 `user-select:none` / `-webkit-touch-callout:none` 抑制 iOS 长按的文字选择/放大镜。
- **窄屏布局适配**（`isNarrow = innerWidth < 768`，监听 resize/visualViewport 切换）：
  - **顶栏精简为一行**：返回按钮只留图标、画布名单行省略号、保留「N 节点」标签，隐藏「更新于…」与操作提示，避免窄屏被挤成竖排逐字换行。
  - **画布铺满、页面无滚动条**：窄屏下编辑器根容器先测出自身文档流中的顶部偏移，随后改用 **`position:fixed; top:<该偏移>; left/right/bottom:0`** 铺满 header 下方到屏幕底——**不靠 `100vh/dvh` 减 header 高度计算**（iOS `visualViewport.height` 有误差，曾导致画布底部留白 + 页面可滚动）。桌面端仍用「视口高度 − 容器顶部偏移」算高度，不受影响。
  - 空态提示按平台切换文案：桌面「右键选择…」/ 移动端「长按选择…」。
- **已知局限（可接受）**：小屏下节点内 schema 表单、拖拽连线操作局促；连线（拖句柄）在触屏上较难点——一期靠「运行时自动连出结果节点」（§4.3.1）规避，用户多数不需手动连线。

### 4.3 生成节点 = 工作流调用壳（运行协议复用 + 新增资产捕获）

- 生成节点本身不含 ComfyUI 协议逻辑，只是「绑定一条工作流 + 提供入参 + 触发运行 + 展示结果」的壳。**提交 `/prompt`、WebSocket 监控、中断等 runner 核心逻辑不改**；复用阶段一的 `ComfyUIRunnerService`。
- **与工具箱运行的区别：携带画布上下文，触发资产捕获**。`POST /api/comfyui/runs` 的 body 在现有 `{workflowId, apiJson}` 上扩展可选 `canvasId`、`nodeId`：
  - **带 `canvasId`（画布节点发起）**：运行成功后由资产服务把每个输出文件的字节从 ComfyUI 捕获、落盘到该画布分区并建 asset 行，输出描述里附带 `assetId` 与平台 URL（§4.6）。
  - **不带 `canvasId`（ComfyUI API 管理页工具箱发起）**：维持现状，只做实时代理展示、不落盘，避免改变工具箱行为。
- **前端共享逻辑抽取**：把 `ComfyUIAPIManager.tsx` 中的「schema 表单渲染、`applyFormValues` 值级写回、提交 + 轮询 + 中断、exposureConfig 主区/高级分区」抽到 `web/src/components/comfyui/`（建议 `useComfyRun.ts` 钩子 + `ComfySchemaForm.tsx` 组件 + 按 workflowId 缓存 schema），设置页运行面板与画布生成节点共用同一份，禁止两处各写一套。
- **节点运行步骤**：
  1. 绑定工作流时拉 `GET /api/comfyui/workflows/:id/schema`（按 workflowId 缓存）；
  2. **参数完整性校验**：按 schema 检查必填暴露字段（含图片上传、必填多行提示词）是否已填；有缺失则在节点内提示缺哪些、**不提交**（见 §4.3.1）；
  3. 深拷贝工作流 `apiJson` → `applyFormValues` 写入节点表单值（提示词即表单内的多行字段）；
  4. **自动连出结果节点**（§4.3.1）：若该生成节点 image 输出口尚未连结果节点，则 `addNodes` 结果节点 + `addEdges` 连线，结果节点置 loading；
  5. `POST /api/comfyui/runs {workflowId, apiJson, canvasId, nodeId}` 拿 promptId；
  6. 轮询 `GET /api/comfyui/runs/:promptId`，把 status/progress 更新到节点与下游结果节点瞬时态；
  7. `success` → 输出已被捕获为平台资产，拿 `[{assetId, url, kind}]` 写入 `node.data.lastAssets`（触发自动保存）并刷新下游结果节点展示图片；`error` → 节点与结果节点内直接展示错误信息。
- **单队列提示**：ComfyUI 串行执行，多个生成节点先后运行会排队。节点状态复用 runner 的 `RunStatus`：`pending`（排队中）/ `running`（运行中）/ `success` / `error` / `interrupted` / `unknown`。

### 4.3.1 参数校验 + 结果节点自动连出（已拍板 2026-09-02）

- **点运行先校验**：从 schema 取所有暴露的必填字段（LoadImage 图片、必填 multiline STRING 提示词、以及 schema 标记 required 的项），逐项检查 `formValues`；缺失则在节点内以 AntD 校验/提示形式标红缺项并中止本次提交，不打扰下游、不创建结果节点。
- **自动连出规则**（校验通过后、提交前执行）：
  - 查当前 edges，若该生成节点的 image 输出句柄**已连**任一 `result` 节点 → 复用它，不新建；
  - 未连 → 在生成节点右侧（如 `position.x + 节点宽 + 80`，y 对齐）`addNodes` 一个 `type:'result'` 节点，并 `addEdges` 一条从生成节点 image 输出到结果节点 image 输入的连线；
  - 结果节点立即进入 loading（复用运行 `pending/running` 态），成功后按 `lastAssets` 展示图片、失败展示错误。
- **重跑**：已存在连好的结果节点时，重跑只更新该结果节点内容（配合 §4.6.4 覆盖清理旧产物），不再新增结果节点。

### 4.4 连线数据流（一期只有生成→结果；提示词并入表单；为二期图生图预留）

- **一期**：不设独立提示词节点，提示词在生成节点表单内填。连线只承担一类关系，且在**前端运行时**解析、不经后端：
  - **生成节点 → 结果节点**：结果节点读上游 `lastAssets`，用平台资产 URL 展示（该连线由运行动作自动创建，见 §4.3.1）。
- **通用输出即输入**：卡片输出句柄带 `kind`（一期仅 `image`），下游节点按 `kind` 兼容才可连；这为二期"生成结果作为图生图输入"的连线复用同一模型。
- **二期预留（本次不启用，仅定方向）**：
  - **（可选）提示词节点 → 生成节点**：若二期引入独立提示词节点，连线把文本注入工作流「主提示词字段」——主提示词字段定义为该工作流 schema 中第一个 `control === 'textarea'`（multiline STRING）的暴露字段；连了则覆盖表单内该字段，未连用表单自身值。
  - **生成/结果节点 → 图生图节点**：把上游资产作为下游 LoadImage 入参。执行前做「ComfyUI 可达性兜底」：该图最初由 ComfyUI 生成、其 output 里通常还在，可直接用 `{filename, subfolder, type:'output'}` 零拷贝引用；**若 output 已被清理，则用平台分区里保存的资产副本重新 `/upload/image` 回灌 ComfyUI input 再提交**——这正是方案 B 自包含的价值：换机器、清过 output 也能基于历史产物继续图生图。

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
| **一期（本次）** | 多画布 CRUD + 列表/编辑器路由 + 节点图持久化；**右键分级菜单添加节点（一期仅文生图可选，其余置灰，右键处为节点左上角，§4.2.1）**；生成 / 结果两类节点（提示词并入生成节点表单，不做独立提示词节点）；**资产库落地（assets 表 + `data/assets/<canvasId>` 分区 + 生成成功自动捕获文生图产物 + `/api/assets/:id` 展示）**；单节点运行出图，**运行前参数校验 + 自动连出结果节点（§4.3.1）**；防抖自动保存；断 ComfyUI 仍可查看历史结果 |
| **二期** | 图生图生成节点（绑 img2img，右键菜单放开该分类）；（可选）独立提示词节点 + 主提示词字段路由；画布内上传入参图（存 upload 分区并转发 ComfyUI）；图生图产物捕获；连线喂图与「output 不在则用平台副本回灌」兜底（§4.4） |
| **后续** | 文生 / 图生视频、音频节点与产物捕获、Range 流式播放；整图按拓扑一键运行；`generation_runs` 运行历史持久化；**节点历史版本链 + 最佳结果挑选（生成策略由覆盖改追加）**；资产大小统计与清理、参数预设 / 节点模板 |

## 5. 落地步骤（当前进度）

- [x] C1 后端数据层：`canvas` 模块（`CanvasDoc` + 五个 CRUD 接口）与 `assets` 模块（`Asset` 实体、`data/assets/<canvasId>` 分区读写、`/api/assets/:id` 读取/下载、删画布级联清理），实体注册进 `database.module.ts`，`tsc` 编译通过
- [x] C2 后端运行捕获：`/api/comfyui/runs` 扩展 `canvasId/nodeId`；带画布时运行成功自动把输出字节捕获进对应分区并回 asset 引用，且按节点覆盖清理上一版 generated 资产（先建新后清旧，`deleteGeneratedByNode` 支持 `keepIds` 保留本次新捕获，§4.6.4）；不带画布的工具箱运行维持现状（代理不落盘）。**额外修复**：runner 提交前先确保 WebSocket 连接就绪（ComfyUI 在提交时该 client 的 WS 未连接则不下发 execution 消息，导致 run 卡 pending）——阶段一遗留的运行时缺陷，已一并修复（`ensureWs` 改为可等待 + `connectWs`）
- [x] C3 前端：路由改造（`/canvas` 列表 + `/canvas/:id` 编辑器）+ 画布列表页（新建 / 打开 / 重命名 / 删除，展示资产大小）。旧单文件 `pages/canvas.tsx` 删除，改为 `pages/canvas/index.tsx`（列表）+ `pages/canvas/editor.tsx`（编辑器外壳：加载画布 graph + React Flow 渲染 + 顶栏）。**额外修复**：`pnpm build` 因 Umi 4 + esbuild minify 的分包 IIFE helper 冲突失败，已按工具提示在 `.umirc.ts` 增加 `esbuildMinifyIIFE: true` 修复，构建通过
- [x] C4 前端：抽取共享运行逻辑到 `components/comfyui/`（`types.ts` 共享类型与纯函数 + `useComfyRun` 钩子 + `ComfySchemaForm` 表单组件 + `ComfyRunModal` 运行面板），schema 按 workflowId 缓存（`clearSchemaCache` 供编辑后失效）；`ComfyUIAPIManager` 删除内部重复实现、仅保留开关状态并改走共享件，行为不回归（`pnpm build` 与 `tsc --noEmit` 通过）
- [x] C5 前端：两类自定义节点（生成 `txt2img` / 结果 `result`，提示词并入生成节点表单）+ **右键分级上下文菜单**（一级分类 / 二级工作流，仅 txt2img 可点其余置灰，右键处经 `screenToFlowPosition` 转坐标作节点左上角落节点，§4.2.1）；生成节点复用 C4 共享件 `ComfySchemaForm` 渲染暴露字段表单——已落地：删除旧 `PromptNode`，`nodes/types.ts` 改为两类（txt2img 工厂创建即绑定工作流 + `formValues`）；新增 `CanvasContextMenu.tsx`（fixed Menu 浮层 + click/contextmenu/Esc 关闭）与 `workflowCategories.ts`；`Txt2ImgNode` 挂载并行拉工作流定义 + schema、内嵌 `ComfySchemaForm`（`singleColumn` + `scroll={false}`，textarea `autoSize`，卡片无滚动条），表单值 300ms 去抖回写 `data.formValues`；`editor.tsx` 移除顶栏工具栏、容器 `onContextMenu` 打开菜单、连线校验只留 image；两类节点头部加删除按钮 + `Popconfirm` 二次确认（Context 新增 `deleteNode`，删节点连带清相连边）。运行按钮 disabled 占位到 C6。**移动端适配（§4.2.2）**：长按（原生 touch capture 监听，450ms/16px）替代右键打开菜单；窄屏顶栏精简 + 根容器 `position:fixed` 铺满、页面无滚动条；空态文案区分右键/长按。`pnpm build` 通过并经手机端（Tailscale 远程）实测：长按弹菜单、选工作流落卡片、画布铺满无滚动。
- [ ] C6 前端：节点内运行——**点运行先按 schema 做参数完整性校验（缺项标红不提交）→ 校验通过若未连结果节点则自动创建并连线（§4.3.1）→ 提交 / 轮询 / 中断 / 状态** + 结果走平台资产 URL 展示；工作流缺失时历史结果仍可见
- [ ] C7 前端：画布防抖自动保存 + 视口持久化 + 刷新恢复（关掉 ComfyUI 也能看历史产物）；`pnpm build` 通过并端到端手测：建画布 → **画布空白右键 → 文生图 → 选工作流 → 右键处落生成节点** → 填参（缺参点运行被拦截）→ 点运行**自动连出结果节点并 loading** → 出图并确认落盘到 `data/assets/<canvasId>/generated/` → 同节点重跑确认复用同一结果节点且旧产物被覆盖清理、只留最新一组 → 关 ComfyUI 刷新仍见图 → 删工作流结果不丢 → 删画布目录被清 → 建第二张画布资产互不串

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

- 2026-09-03（实现）：**移动端「能用即可」支持落地**（新增 §4.2.2）——为作者用手机经 Tailscale 远程验证：① 长按（原生 `touchstart` capture 监听、450ms/16px 阈值、抑制随后合成 click）替代右键打开分级菜单，复用同一 `openMenu`；踩坑记录「React 合成 touch 事件被 React Flow 平移手势干扰，须用原生 capture 监听」；② 窄屏（<768px）顶栏精简为一行 + 空态文案区分右键/长按；③ 画布铺满且页面无滚动条——窄屏根容器测出文档流顶部偏移后改用 `position:fixed` 铺到 `bottom:0`，放弃 `dvh` 减 header 高度计算（iOS `visualViewport` 误差曾致留白）。手机端实测通过。仅前端改动。

- 2026-09-03（实现）：**C5 落地并按实测交互补充设计**——两类自定义节点 + 右键分级菜单 + 节点内自适应表单 + 节点删除二次确认，`pnpm build` 通过。相对原设计的新增/细化并回写文档：① §4.2 增「节点内表单布局约束」（`singleColumn` + `scroll={false}` + textarea `autoSize` + 容器 `overflow:hidden`，卡片内无横/纵向滚动条，设置页面板不受影响）与「节点删除 = `Popconfirm` 二次确认，经 Context `deleteNode` 删节点并清相连边」；② §4.2.1 增「实现要点」记录三处踩坑决策（右键挂容器 `onContextMenu` 而非 `onPaneContextMenu`；菜单用 fixed `Menu` 浮层而非受控 `Dropdown`；关闭用 `click` 而非 `mousedown` 以免打断二级项 `onPick`）+ 前端分类副本 `workflowCategories.ts`；③ 共享件 `ComfySchemaForm` 新增 `scroll`/`singleColumn` 开关（默认值保持设置页原行为）。落地步骤 C5 勾选完成并补实现说明。**仅前端改动**，未改后端 / 运行协议。

- 2026-09-02（设计更新）：**画布交互形态拍板调整**（用户确认三点）——① 节点添加改为**画布空白右键分级菜单**（一级分类 / 二级具体工作流，一期仅「文生图」可点、其余分类与空分类置灰），右键处经 `screenToFlowPosition` 转坐标作**新节点左上角**（新增 §4.2.1，改 §3.2/§3.3）；② **提示词并入生成节点表单，取消独立提示词节点**（§4.2 节点表由三类改两类、§4.4 连线一期只剩「生成→结果」，独立提示词节点降为二期可选增强）；③ 生成节点**点运行先做参数完整性校验（缺项不提交），校验通过后若未连结果节点则自动在右侧创建结果节点并连线、置 loading，成功后展示图**（新增 §4.3.1，改 §4.3 运行步骤）；补充「每个产出节点至少一个带 `kind` 的输出句柄、输出即下游输入」的通用模型（§3.6）。相应更新 §4.7 分期路线与 §5 落地步骤 C5/C6/C7 的交互描述与验收路径。**本次仅改设计文档，未改代码**。

- 2026-09-02（实现）：**C4 抽取共享运行组件落地**——新增 `web/src/components/comfyui/`：`types.ts`（SchemaAnalysis / RunStateData / ComfyUIAPI 等共享类型 + `applyFormValues` / `splitByExposure` / `fileKey` 纯函数）、`useComfyRun.ts`（schema 加载按 workflowId 缓存 + form/json 切换 + 提交/轮询/中断 + 图片上传 + 输出下载，支持画布上下文 `canvasId/nodeId` 与 `onRunStarted`/`onRunFinished` 回调）、`ComfySchemaForm.tsx`（受控 schema 表单：主区 / 高级参数折叠 + upload 控件）、`ComfyRunModal.tsx`（设置页运行面板整体：表单 / JSON 切换 + 进度 / 结果 + 作为封面）。`ComfyUIAPIManager.tsx` 删除约 660 行内部运行实现，仅保留 `runOpen/runWorkflow` 开关并渲染 `<ComfyRunModal>`；编辑保存后 `clearSchemaCache` 失效缓存。行为不回归：`pnpm build` 通过，`tsc --noEmit` 通过（临时 umi 模块 stub 验证后已删）。

- 2026-09-02（实现）：**C3 前端路由与画布列表落地**——`.umirc.ts` 路由改为 `/canvas → ./canvas/index`（画布工作台列表）、新增 `/canvas/:id → ./canvas/editor`（编辑器）；列表页 `pages/canvas/index.tsx` 实现卡片网格（新建 / 打开 / 重命名 / 删除，展示节点数 / 资产大小 / 更新时间，删除带二次确认）；旧单文件 `pages/canvas.tsx` 删除，编辑器 `pages/canvas/editor.tsx` 为外壳（加载画布 graph、React Flow 渲染节点/连线/视口、顶栏返回+名称+节点数）。**额外修复**：`pnpm build` 因 Umi 4 + esbuild minify 的分包 IIFE helper 冲突失败（`Found conflicts in esbuild helpers`），按提示在 `.umirc.ts` 增加 `esbuildMinifyIIFE: true`，构建通过。端到端手测 PASS：建画布 → 跳转编辑器（空图提示）→ 返回列表见卡片 → 重命名 → 删除（二次确认 + 级联清资产）→ 注入非空 graph 后编辑器正确渲染 2 节点/1 连线/视口。

- 2026-09-02（实现）：**C1 后端数据层落地**——新增 `backend/src/canvas`（`CanvasDoc` + 建/列/取/改/删 5 接口，列表含节点数与资产大小，新建自动建分区，删画布级联清资产）与 `backend/src/assets`（`Asset` 实体 + `data/assets/<canvasId>` 分区读写 + `/api/assets/:id` 读取、`/api/assets/:id/download` 下载），实体注册进 `database.module.ts`；`tsc` 编译通过并端到端验证（建画布→分区→改名存图→写资产→读/下载→统计→级联删除，全 PASS）。同日补齐单元测试栈（Jest + ts-jest + supertest，`pnpm test`，4 suite / 29 用例全绿）。
- 2026-09-02（设计）：§5 补「依赖顺序 / 可并行项 / 关键里程碑」（§5.1）——C1 为地基、C2 依赖 C1、C3 与 C2 并行、C4 为纯重构可随时并行且是 C5/C6 前置、C5→C6→C7 串行。
- 2026-09-02（设计更新）：节点产物策略定为**一期覆盖清理**——同一节点重跑成功后删除其上一版 generated 资产（行 + 文件）、只留最新一组，先建新后清旧；删节点同步清其产物，上传入参图不在覆盖范围。历史版本链与「最佳结果挑选」留后续，届时由覆盖改为追加（§4.6.4 / §4.7）。
- 2026-09-02（设计更新）：**拍板中间产物走方案 B（平台自有资产库）**——新增 §4.6：`data/assets/<canvasId>/` 按画布分区、`assets` 表、生成捕获 / 上传副本 / 视频三类入库方式、`/api/assets/:id` 读取、删画布级联清理、展示与重跑解耦（工作流删改不影响历史产物展示）；§4.3 `/runs` 扩展 `canvasId/nodeId` 并区分工具箱（不落盘）与画布（落资产）；§4.4 补「output 缺失时用平台副本回灌 ComfyUI」兜底；落地步骤由 C1–C6 扩为 C1–C7。
- 2026-09-02（设计）：确立「多画布一等实体 + 一期仅文生图」的分期方案；确定 `canvas_docs` 表与 `/api/canvas` 接口、三类节点模型、共享运行逻辑抽取、防抖自动保存，并为二期图生图数据流预留方向。
