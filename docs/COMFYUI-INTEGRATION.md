# ComfyUI 集成 · 运行功能设计

> 创建：2026-09-01
> 定位：记录「ComfyUI API 管理 → 可运行的调用工具」的需求与已拍板的技术方案决策，供跨 session 协作持续推进。需求仍在演进，本文档随决策更新，勿写死为完整 PRD。

## 1. 背景与目标

CarrotCanvas 已具备 ComfyUI API（工作流）的**管理**能力（导入 / 校验 / CRUD），但**不能运行**——「ComfyUI 客户端（HTTP + WebSocket 任务监听）」仍是 README 中的 TODO。

本功能目标：把 ComfyUI API 从一个"静态 JSON 仓库"变成**一套可独立调用的工具箱**——每个 API 是一张卡片，点进去填参数就能提交到本地 ComfyUI 执行并看到结果。

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

### 4.3 关键决策小结

| 决策点 | 结论 |
|---|---|
| 入口形态 | 一级菜单 + 卡片网格（工具箱） |
| 入参方式 | 自动表单为主 + JSONText 兜底（可切换） |
| 文件参数 | 上传 + 占位符编号，提交时值级替换 |
| schema 来源 | ComfyUI `/object_info`，缓存 + 降级 |
| 工作流获取 | 8188 `/userdata` 官方端点拉取（免目录扫描、免手动导出） |
| UI→API 转换 | 复刻官方前端 `graphToPrompt` 算法，转换后校验 + 手动上传兜底 |

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

- [ ] ① 路由改造：独立菜单 + 卡片网格视图（保留列表切换）
- [ ] ② 后端：工作流导入（8188 `/userdata` 拉取 + 复刻官方 `graphToPrompt` 的 UI→API 转换 + 校验入库，见 §4.4）
- [ ] ③ 后端：`/object_info` 拉取 + 缓存接口
- [ ] ④ 后端：schema 分析接口（入参 API JSON → 返回表单描述 `[{param, type, default, constraints, control}]`）
- [ ] ⑤ 前端：动态表单渲染 + 值写回 JSON + JSONText 模式切换
- [ ] ⑥ 后端：文件上传（写 input 目录）+ 模板渲染（占位符值级替换）
- [ ] ⑦ 提交 `/prompt` + WebSocket 进度监听 + 结果回传入库（`generation_runs` 表）

## 6. 变更日志

- 2026-09-01（补充）：新增「工作流导入」方案（§4.4）——通过 8188 官方 `/userdata` 端点直接拉取 ComfyUI 已保存工作流，后端复刻官方前端 `graphToPrompt` 算法做 UI→API 转换后入库，免去手动导出上传；落地步骤新增 ②。
- 2026-09-01：创建本文档，沉淀需求讨论（独立菜单 / 卡片式 / JSONText+文件占位符 / object_info 自动表单）。
