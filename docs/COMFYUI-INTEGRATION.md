# ComfyUI 集成 · 运行功能设计

> 创建：2026-09-01
> 定位：记录「ComfyUI API 管理 → 可运行的调用工具」的需求与已拍板的技术方案决策，供跨 session 协作持续推进。需求仍在演进，本文档随决策更新，勿写死为完整 PRD。

## 1. 背景与目标

CarrotCanvas 已具备 ComfyUI API（工作流）的**管理**能力（导入 / 校验 / CRUD），但**不能运行**——「ComfyUI 客户端（HTTP + WebSocket 任务监听）」仍是 README 中的 TODO。

本功能目标：把 ComfyUI API 从一个"静态 JSON 仓库"变成**一套可独立调用的工具箱**——每个 API 是一张卡片，点进去填参数就能提交到本地 ComfyUI 执行并看到结果。

> 本文档是**阶段一（独立工具箱，已完成）**。阶段二「多画布 + 画布节点复用本文件的运行引擎调用工作流（一期仅文生图）」独立成文，见 [CANVAS-INTEGRATION.md](./CANVAS-INTEGRATION.md)；阶段二不新增运行协议、不改 runner。

## 2. 现状（2026-09-01）

- ✅ 后端 `workflows` 模块：CRUD + 导入 + ComfyUI API 格式校验（`ComfyUIValidator`）
- ✅ 前端 ComfyUI API 管理：`web/src/components/settings/ComfyUIAPIManager.tsx`（Table 列表 + 增删改查），挂在 `/settings` 下
- ✅ ComfyUI 地址配置 + 连接测试（`/api/settings/comfyui-url`、`test-connection`）
- ❌ 运行/提交、任务进度、结果管理均未实现

## 3. 需求要点

1. **侧边栏独立菜单**：「ComfyUI API 管理」从 `/settings` 子路由提升为一级菜单项（当前已提交的 `.umirc.ts` 里还是 `/settings/comfyui-api` 子路由）。
2. **卡片式组织（工具箱心智）**：每个 API 一张卡片（名称 / 分类 / 描述 / 标签），分类筛选；保留列表视图可切换。卡片点击即进入"运行"。
3. **运行面板 = 入参输入**：
   - **自动表单为主**：系统根据 API JSON + ComfyUI `/object_info` schema 自动生成参数表单（见 §4.2）。
   - **JSONText 兜底**：右上角可切换"JSON 模式"直接编辑模板；拉不到 schema 时自动回退。
4. **文件参数占位符机制**：需要传图/传文件的参数，界面可随意上传文件，每个文件自动编号（`{{file:1}}`），JSON 中引用该编号即可（见 §4.1）。
5. **提交与结果**：渲染完整请求体 → `POST /prompt` → WebSocket 监听进度 → 结果（图/视频）回传前端展示。
6. **工作流导入免手动导出**：用户无需在 ComfyUI 里手动「Export → API format」再回项目上传——通过 8188 官方端点直接拉取已保存工作流并自动转成 API 格式入库（见 §4.4）。

## 4. 技术方案决策记录

### 4.1 文件占位符机制（已拍板）

- **机制**：ComfyUI 的图片输入不传文件流，而是引用 `input/` 目录里的文件（LoadImage 节点的 `images` 参数是 `{"images":[{"filename":"x.png","subfolder":"","type":"input"}]}` 数组）。因此上传文件 → 保存到 ComfyUI `input/` 目录（或 `/upload/image`）→ JSON 里写 `{{file:N}}` → 提交时替换。
- **替换是值级的，不是文本级**：`{{file:N}}` 最终要替换成一个对象/数组，需解析 JSON 结构后做字段值替换，不能字符串拼接，否则破坏 JSON 语法。
- **两种引用形态**：标准 LoadImage 用 `images` 数组；部分节点用纯文件名字符串。建议语法：`{{file:N}}` → images 数组；`{{file:N:name}}` → 纯文件名字符串。
- **模板与文件分离**：占位符留在 API 模板中持久化，文件在提交时才上传，不污染库里的模板。
- **需处理边界**：多文件复用同一文件、文件命名冲突、ComfyUI `input/` 目录不可写的降级提示。

### 4.2 自动表单（schema 驱动，已拍板"表单为主 + JSONText 兜底"）

- **数据源**：ComfyUI 官方 `GET /object_info` 返回全部节点类型的参数定义（类型 / 默认值 / min/max/step / 下拉选项 / multiline）。这是生成表单的 schema 来源。
- **解析规则**：
  - 遍历 API JSON 每个节点，按 `class_type` 匹配 `/object_info` schema；
  - 区分 **widget 输入**（值是标量，需用户填）与 **连接输入**（值是 `["nodeId", 0]`，来自上游，跳过）；
  - 只把"无连接的 widget 参数"渲染成控件。
- **类型 → 控件映射**：

  | schema 类型 | 控件 |
  |---|---|
  | INT / FLOAT（含 min/max/step） | InputNumber / Slider |
  | STRING + multiline | TextArea（提示词最常用） |
  | STRING（单行） | Input |
  | COMBO（枚举） | Select |
  | BOOLEAN | Switch |
  | IMAGE / LoadImage | 文件上传（走 §4.1 占位符机制） |
  | MODEL/CLIP/LATENT 等 | 通常来自上游连接 → 自动隐藏；若为裸值则降级 |

- **风险与对策**：
  - 依赖 ComfyUI 在线拉 schema → **拉取后缓存**，离线降级 JSONText；
  - 节点 schema 随版本 / 自定义节点变化 → 缓存带 TTL 或启动刷新，未知类型降级 JSONText；
  - 非 widget 类型裸值 → 特殊处理或回退 JSONText。

### 4.5 暴露字段配置（导入时勾选 + 运行面板分区，已拍板 2026-09-02）

**动机**：schema 分析把「所有无连接 widget」全部平铺成表单（Z-Image 三视图实测 44 项），但用户实际只需填少数关键参数（如 4 张图 + 1 个提示词），其余都是默认值。ComfyUI 原生 `/object_info` 只有 `required/optional/hidden` 三档，**不提供「该不该暴露给终端用户」的语义**，因此这层必须在平台侧实现。

**决策**：
- 每张工作流持久化一份「暴露配置」`exposureConfig: { version, fields: [{nodeId, param}] }`（存**已暴露**列表，而非隐藏列表，默认收起以免回到 44 项）。存于 `workflows.exposure_config`（simple-json，nullable；`synchronize:true` 自动建列，无需迁移）。
- **导入时勾选**：`从 ComfyUI 导入` 弹窗预览阶段展示按节点分组的字段勾选表（字段名 / 类型 / 当前值），确定后随导入一起入库。
- **智能预勾**：默认勾选「图片上传（LoadImage）」与「多行提示词（multiline STRING）」；图生图工作流额外默认勾选 `denoise`（重绘强度），其余默认不勾 → 进高级区。用户可增删。后端 `suggestExposure` 计算建议，前端可覆盖。
- **运行面板分区**：按 exposureConfig 把 schema 字段拆为「主区（暴露字段，直接展开）」与「高级参数（未暴露，Collapse 折叠，可展开微调）」。**exposureConfig 为空 → 全部归主区（回退平铺）**，不破坏老数据。
- **事后可改**：编辑弹窗内置同一勾选表（走 `GET /workflows/:id/schema` + `PATCH /workflows/:id` 存 exposureConfig）。
- **字段名称、分组名称与使用建议**：每个自动表单字段可配置工作流级中文名称和使用说明，每个 ComfyUI 节点分组也可配置显示名称，统一持久化到 `workflows.field_config`。导入预览会为 `CLIPTextEncode`、`LoadImage`、`KSampler` 等常见节点生成中文分组名，并为 `denoise`、`steps`、`cfg`、`seed`、尺寸、提示词等常见参数生成可编辑的中文建议；编辑页可逐项覆盖。运行表单默认只显示友好名称，`class_type · nodeId` 移入标题悬浮提示，解决原始 key 难懂与重名字段难区分的问题。

**接口变化**：
- `POST /comfyui/workflows/preview` 增返 `schema`（字段分析）与 `suggestedExposure`（预勾建议）。
- `POST /comfyui/workflows/import` body 增 `exposure` → 存 `exposureConfig`。
- `POST /workflows`、`PATCH /workflows/:id` 支持 `exposureConfig`；`GET`/序列化返回 `exposureConfig`。
- `POST /workflows`、`PATCH /workflows/:id` 支持 `fieldConfig`；schema 接口把字段配置合并进 `label` / `description` 后返回。

### 4.3 关键决策小结

| 决策点 | 结论 |
|---|---|
| 入口形态 | 一级菜单 + 卡片网格（工具箱） |
| 入参方式 | 自动表单为主 + JSONText 兜底（可切换） |
| 文件参数 | 上传 + 占位符编号，提交时值级替换 |
| schema 来源 | ComfyUI `/object_info`，缓存 + 降级 |
| 工作流获取 | 8188 `/userdata` 官方端点拉取（免目录扫描、免手动导出） |
| UI→API 转换 | 复刻官方前端 `graphToPrompt` 算法，转换后校验 + 手动上传兜底 |
| 参数暴露 | 平台侧持久化 `exposureConfig`；导入时勾选（智能预勾图片+提示词）；运行面板主区/高级折叠分区；空配置回退平铺（见 §4.5） |

### 4.4 工作流导入方案（8188 拉取 + 复刻官方转换，已拍板 2026-09-01）

**动机**：避免用户每次在 ComfyUI 手动「Export → API format」再回项目上传。现有工作流应能直接拉取导入。

**已验证事实（本地实测 2026-09-01）**：
- ComfyUI 官方提供公开端点 `GET /userdata?dir=workflows` → 返回已保存工作流文件名列表（实测 9 个文件）；`GET /userdata/workflows/<file>` → 返回文件完整内容（200）。
- 保存的工作流为 **UI 格式**（graph format）：顶层含 `nodes/links/groups`，无顶层 `class_type`，**不可直接提交 `/prompt`**。
- 新版 UI 格式节点含 `widgets_values_named`（名字→值映射）与 `inputs[].widget` 标记 → 磁盘文件保留了转换所需的完整信息。
- 官方前端「Export → API format」调用内置 `graphToPrompt()`（源码在官方前端 bundle `dialogService-*.js`），即官方权威转换算法。

**方案**：
- 导入入口：「从 ComfyUI 导入」→ 调 8188 `/userdata?dir=workflows` 列出 → 用户勾选 → `/userdata/workflows/<file>` 拉内容 → 后端转换 → 复用现有 `POST /workflows` 导入/校验入库。
- 转换实现：后端复刻官方 `graphToPrompt` 算法——遍历 `nodes`，每节点输出 `{inputs, class_type, _meta}`；`inputs` 中已连线项写成 `["srcNodeId", outputIndex]`（查 `links` 表），widget 项取值自 `widgets_values_named`；丢弃画布信息（pos/size/groups/links）。
- 校验与兜底：转换后跑 `ComfyUIValidator` 结构校验；失败或非标准结构时提示「请用 ComfyUI 导出 API 格式后上传」，保留手动上传入口。

**可靠性边界**：
- 标准节点 100% 可靠（`widgets_values_named` + `inputs[].widget` 完整）。
- 自定义节点：走同一 widgets 序列化路径，大概率可靠；个别特殊 widget（曲线/隐藏值）需转换后校验确认。
- 不读本地文件系统目录、不依赖 ComfyUI 安装路径；仅需 ComfyUI 地址（已有 `comfyui-url` 配置）。

## 5. 落地步骤（当前进度）

- [x] ① 路由改造：独立菜单 + 卡片网格视图（保留列表切换）——已落地（commit 446eb41）
- [x] ② 后端：工作流导入（8188 `/userdata` 拉取 + 复刻官方 `graphToPrompt` 的 UI→API 转换 + 校验入库，见 §4.4）——已落地，含子图展开 / Reroute 穿透 / 新旧格式兼容；前端「从 ComfyUI 导入」弹窗
- [x] ③ 后端：`/object_info` 拉取 + 缓存接口——已落地（`ComfyUIClientService.getObjectInfo` 带缓存，供转换校验与后续表单用）
- [x] ④ 后端：schema 分析接口（入参 API JSON + `/object_info` → 返回表单描述 `[{param, type, default, constraints, control}]`）——已落地（`ComfyUISchemaService.analyze`：跳过连接输入 / schema 未定义参数，类型→控件映射 INT/FLOAT→input_number、STRING multiline→textarea、COMBO→select、BOOLEAN→switch、IMAGE→upload；实测 minimaxh3v1=19 项可编辑、Z-Image 三视图=44 项含子图 78:xx 分组）
- [x] ⑤ 前端：动态表单渲染 + 值写回 JSON + JSONText 模式切换——已落地（`ComfyUIAPIManager.tsx` 运行面板：自动表单按节点分组渲染，值级写回 apiJson 后再提交 /runs；Segmented 自动表单/JSON 双向切换；实测修改 filename_prefix 后提交，ComfyUI 输出文件名生效）
- [x] ⑥ 后端：文件上传（写 input 目录）+ 模板渲染（占位符值级替换）——已落地（POST /api/comfyui/upload/image 收 base64 → 转发 ComfyUI /upload/image 写 input 目录；前端 LoadImage 控件 Select 选已有图 + Upload 上传新图；实测 465KB 图片上传被 ComfyUI /object_info 识别；main.ts body 限制 15mb）
- [x] ⑦ 提交 `/prompt` + WebSocket 进度监听 + 结果展示——已落地（`ComfyUIRunnerService`：提交 /prompt + WS 监控 + 输出收集 + 前端运行面板）；2026-09-05 已接入统一持久化 `generation_runs` 与候选历史，画布节点重跑改为追加候选，不再覆盖清理旧产物

## 6. 变更日志

- 2026-09-05（AI Native 1A）：ComfyUI 每次提交会先创建平台 GenerationRun，保存最终 API JSON、工作流版本与画布/节点/资产 lineage；成功产物追加进候选组。服务重启后无法确认的 queued/running 任务标记 `needs_attention`；由于底层 interrupt 为全局语义，并发运行时明确拒绝伪装成精确取消。
- 2026-09-05（实机验收）：Z-Image 文生图在同一画布节点连续运行两次均成功；第二次命中 ComfyUI 缓存但平台仍生成独立 Run 和独立资产，候选组保留两个资产。后端重启后 Run、候选与 selected 状态保持，历史页面可见。
- 2026-09-03（配置）：MiniMax H3 文生视频与图生视频工作流的持久化采样步数统一从 20 调整为 8（高质量/快速分支均为 8），降低本机单次生成耗时。

- 2026-09-03（修复/实机验收）：MiniMax H3 官方本地 T2V/I2V 工作流实跑通过。转换器将 `MarkdownNote` 归为仅 UI 展示的虚拟节点并跳过，避免 `/prompt` 报 `missing_node_type`；runner 输出收集增加按文件扩展名纠正媒体类型，兼容 `SaveVideo` 把 MP4 描述放在 `output.images` 的情况。实测产出 `MiniMax_H3_00009_.mp4`（T2V）与 `MiniMax_H3_00010_.mp4`（I2V），代理均返回 `video/mp4`。

- 2026-09-02（文档）：阶段二画布方案独立成文 [CANVAS-INTEGRATION.md](./CANVAS-INTEGRATION.md)（多画布一等实体 + 画布节点复用本文件运行引擎，一期仅文生图，图生图留二期）；本文件范围与结论不变。
- 2026-09-02（实现）：新增「暴露字段配置」（§4.5）——`workflow` 实体加 `exposure_config`（simple-json，nullable，synchronize 自动建列）；`workflows.service` 透传 + `normalizeExposure`（去重、空归 null）；`comfyui.controller` preview 增返 `schema`/`suggestedExposure`（`suggestExposure`：图片 + 多行提示词预勾），import 接收 `exposure`。前端 `ComfyUIAPIManager.tsx`：可复用 `renderExposureSelector`（分组勾选表：字段名/类型/当前值 + 全选/全不选）接入「从 ComfyUI 导入」与「编辑」弹窗；运行面板 `splitByExposure` 拆主区/高级 Collapse，空配置回退平铺。后端 `tsc` 编译通过。
- 2026-09-01（实现）：落地步骤④⑤⑥（入参动态表单 + 图片上传）——新增 `ComfyUISchemaService`（apiJson + /object_info → 表单描述，跳过连接输入，类型→控件映射）；`comfyui-client` 增加 /object_info 10min TTL 缓存与 /upload/image（FormData 转发）；controller 新增 GET /workflows/:id/schema、POST /upload/image；main.ts 引入 body-parser（JSON body 15mb）支持大图 base64；前端运行面板自动表单按节点分组渲染 + 值写回 + JSONText 双向切换 + LoadImage 上传/选择控件（flex 布局修复上传按钮不可见）；实测：schema 三工作流、改 filename_prefix 提交生效、465KB 图片上传被 ComfyUI 识别。
- 2026-09-01（实现）：落地步骤②（工作流导入）与步骤③/⑦（运行执行）——新增 `backend/src/comfyui/` 模块（client / graph-converter / runner / controller）；复刻官方 graphToPrompt 并补充子图展开（subgraph 节点展开为 `父id:子id` 内部节点）与 Reroute 穿透；旧格式（位置 widgets_values）按 /object_info 映射；提交前展开 `%date%`/`%time%` 前端通配符；运行状态内存化 + 成功回写缩略图；前端接入「从 ComfyUI 导入」与运行面板。
- 2026-09-01（补充）：新增「工作流导入」方案（§4.4）——通过 8188 官方 `/userdata` 端点直接拉取 ComfyUI 已保存工作流，后端复刻官方前端 `graphToPrompt` 算法做 UI→API 转换后入库，免去手动导出上传；落地步骤新增 ②。
- 2026-09-01：创建本文档，沉淀需求讨论（独立菜单 / 卡片式 / JSONText+文件占位符 / object_info 自动表单）。
