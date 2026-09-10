# AI 原生画布与人机接力

> 状态：Phase 1B 已实现并通过行为级验收；当前需求范围已完成，Phase 2 及后续阶段暂不实施
> 最后更新：2026-09-10
> GitHub Issue：[Issue #1](https://github.com/liuzeen1234/CarrotCanvas/issues/1)

本文是 AI 原生画布控制、人机接力、生成历史与自主视频生产的仓库内唯一设计入口。Issue 用于讨论和追踪；本文记录已拍板决策、实施边界、阶段状态和后续 AI 会话必须遵守的约束。当前交付边界止于 Phase 1B；Phase 2、Phase 3 及其最终 Skill/成片闭环验收仅保留为未来参考，不属于当前需求、Issue #1 完成条件或 `v1.0.0` 发布范围。

涉及以下内容的实现开始前必须完整阅读本文：

- Agent REST/MCP 与 Action Registry。
- Canvas revision、控制租约和写入冲突。
- 人工与 AI 的控制权交接。
- Operation Log、Checkpoint 和 Handoff。
- 持久化 Run、生成历史、候选资产和选片。
- Shot Plan、自主视频生产与最终导出。
- `AI-COLLABORATION.md` 和 `skills/carrot-canvas/SKILL.md`。

## 1. 产品目标

CarrotCanvas 要从“人通过 Web UI 操作的节点式 AI 工具”发展为：

> AI 可根据自然语言目标自主规划、搭建、运行和修正视频生产流程；人工可以接手 AI 的画布，AI 也可以继续人工留下的工作，双方使用同一份可审计、可恢复的创作状态。

正式控制面不能依赖 AI 模拟鼠标、DOM 或画布坐标。UI 自动化只用于验收和兜底。人工 Web UI 与 AI Agent 必须调用同一套应用层命令和领域规则。

## 2. 已拍板决策

### 2.1 同一画布单写者

- 同一张画布在任何时刻只能有一个写入者：人工或 AI。
- 双方可以同时查看，但不能同时修改共享状态。
- 当前阶段不采用 CRDT、多人实时协同编辑或复杂自动合并。
- “无缝接力”指控制权切换前状态已落盘，新控制者从同一 revision 继续，旧控制者的延迟请求不能覆盖新状态。

### 2.2 请求交接是默认路径

正常控制权切换必须使用 `request-handoff`：

1. 请求方发出交接请求，画布进入 `handoff_pending`。
2. 当前控制者不再开启新操作批次，并完成正在执行的原子操作。
3. 当前控制者保存 revision、Run 引用、候选状态和 Handoff 摘要。
4. 当前控制者主动释放 lease。
5. 请求方获取新 lease，并从交接 revision 继续。

不设置日常自动抢占或倒计时强占。`force-takeover` 仅供人工在控制者失联、租约异常等故障恢复场景使用，必须记录原因。已提交的 Run 默认继续，不因交接自动取消。

### 2.3 REST 是业务核心，MCP 是适配层

- Application Command API 承载唯一业务逻辑。
- Web UI 与 Agent REST/MCP 复用相同服务。
- MCP 不维护独立画布模型，也不复制业务规则。
- 第一阶段先稳定 REST 和 schema，再提供 MCP 适配。

### 2.4 Action Registry 是完整控制的判定标准

每一个用户可执行的领域操作都必须映射到 Action Registry；以后不得新增只存在于 React `onClick` 中的领域功能。

每个 Action 至少声明：

- 稳定名称和版本。
- 人类描述与机器描述。
- 输入、输出 JSON Schema。
- workspace/canvas/node/run/asset/workflow 作用域。
- 是否要求 lease。
- 权限等级、人工确认要求、副作用。
- 幂等性、可撤销性、结构化错误码。
- 当前可用性及不可用原因。

### 2.5 展示状态与领域状态分离

以下属于本地展示状态，不增加 canonical canvas revision：

- viewport 缩放和平移。
- 小地图和面板开关。
- 当前选中的节点或连线。
- 浏览器窗口和个人视觉偏好。

节点位置属于共享画布内容，仍受 lease 和 revision 保护。

### 2.6 Run 属于画布，不属于会话

- 运行属于 Canvas/Node，而不是启动它的浏览器或 Agent 会话。
- 浏览器关闭、Agent 退出或控制权交接不得丢失 Run。
- 新控制者可以观察、等待、接管、精确取消或继续下游。
- Run 进度使用独立状态，不增加画布 revision。

## 3. “完全控制”的边界

AI 必须能通过机器接口操作：

- 画布：列表、新建、读取、重命名、归档、删除和控制权。
- 创作状态：Brief、Handoff、Checkpoint 和操作记录。
- 节点图：创建、更新、移动、连接、断开、删除、布局和校验。
- 能力：工作流、Codex2API、输入输出 schema、模型和健康状态。
- 工作流：读取、导入、创建、编辑、版本化、测试和删除。
- 资产：导入、上传、查询、连接、血缘、候选、选择、下载、导出和受控清理。
- 运行：提交、等待、查询、精确取消、有限重试、恢复、接管和历史。
- 视频生产：Shot Plan、候选生成、选片、镜头状态、批量执行、断点续跑和导出。

AI 可以查询服务是否配置、健康状态和可用模型，但不能读取 API Key 明文。

以下高影响操作需要独立授权或人工确认：删除画布/已批准资产/历史版本、覆盖式恢复 Checkpoint、大批量清理、修改服务或密钥、修改全局工作流、高成本批量运行、外部发布。

## 4. 核心状态模型

### 4.1 Canvas Control Lease

每张画布最多一个有效写入租约，至少包含：

- `canvasId`、`epoch`。
- `holderType: human | agent`、`holderId/sessionId`。
- 服务端保存的 `tokenHash`。
- `acquiredAt`、`lastHeartbeatAt`、`expiresAt`。
- `status: active | handoff_pending | expired | revoked`。

当前默认参数：TTL 45 秒；前端人工持有者每 15 秒续约，Agent 建议每 10–15 秒续约。人工进入空闲画布会自动竞争获取，但不抢占已有持有者；Agent 开始写任务时必须通过正常交接或空闲 acquire 显式获取。

所有画布写请求携带：

- `leaseToken`。
- `leaseEpoch`。
- `expectedRevision`。
- `operationId` 或 `idempotencyKey`。

统一冲突：

- `423 CANVAS_LOCKED`：另一方持有写入权。
- `410 LEASE_EXPIRED`：租约已过期。
- `409 STALE_LEASE`：lease epoch 已变化。
- `409 REVISION_CONFLICT`：基于旧 revision 写入。
- `403 OPERATION_NOT_ALLOWED`：权限不足或对象受保护。

租约落数据库而不是只放进程内存。后端重启后旧租约按过期处理；过期只释放写入权，不删除状态或取消 Run。

#### AI 持有者必须遵守的续租与交接合同

1. Agent 取得 lease 后，只要任务、等待中的生成或用户要求的持续占用尚未结束，就必须在 TTL 内持续调用 renew；建议间隔 10–15 秒，并为短暂失败预留至少两次重试窗口。
2. Agent 必须读取每次 renew 的完整响应，不能把续租实现为忽略返回值的“保活循环”。响应为 `handoff_pending` 时，禁止再开始新的写操作或高成本 Run。
3. 收到 `handoff_pending` 后，Agent 应完成已经开始且不可安全中断的最小收尾，排空待提交的 canonical 写入，记录必要 Handoff，然后主动调用 release。默认应在一个续租周期内开始响应，不得继续无条件续租阻塞人工。
4. 用户明确要求“什么都不做、只维持控制权”也不取消交接义务；人工一旦申请编辑权，守护进程仍必须退出保活并释放。
5. Agent 任务成功、失败、取消、进程退出或无法确认 lease 状态时，都必须尽力主动 release；不能依赖 45 秒 TTL 作为正常交接方式。TTL 仅用于崩溃、断网等故障兜底。
6. renew 返回 `LEASE_EXPIRED`、`STALE_LEASE` 或当前 epoch/holder 已变化时，Agent 必须立即停止使用旧 token，重新读取 canvas/control；未经新一轮正常交接不得自行恢复写入。
7. 通用 Agent SDK、Skill 或外部守护脚本必须把“续租 + handoff_pending 检测 + 排空 + release”封装成同一生命周期，禁止提供只续租、不响应交接的生产实现。

### 4.2 Canonical Canvas State

CanvasDoc 增加：

- `revision`：每个成功的原子操作批次递增一次。
- `schemaVersion`。
- `brief`。
- `activeCheckpointId`、`lastHandoffId`。
- `updatedByType`、`updatedById`。

迁移期保留整图保存，但必须包装为受 lease、epoch 和 `expectedRevision` 保护的 `replace_graph`。随后逐步迁移到语义化 operations；拖动节点可批量提交 `move_nodes`。

### 4.3 Operation Log、Checkpoint 与 Handoff

Operation batch 至少记录 base/result revision、actor、lease epoch、intent、operations、idempotency key、时间和结果。

Checkpoint 用于完整恢复；日常撤销使用带前置条件的 inverse operations，避免整图恢复覆盖后续人工修改。

Handoff 至少保存：

- 当前目标、阶段和 revision。
- 已完成事项及下一步。
- 正在运行的 runIds。
- 最近产物、已批准和已否决候选。
- 待人工决策和受保护对象。
- 简短决策理由，不保存冗长内部思维链。

## 5. 当前实现差距

截至 2026-09-05：

- Canvas graph 仍以宽松 `unknown[]` 存储和浅层校验为主。
- 前端仍采用本地 nodes/edges 与防抖整图 PATCH。
- ComfyUI Run 保存在后端进程 Map，最多保留有限条目，重启丢失。
- 前端只读观察者可轮询后端现有 ComfyUI 内存 Run 并恢复卡片进度/终态，但后端重启后仍会丢失；Codex2API 尚未接入统一共享 Run。
- 生成资产可以落盘并记录基础来源，但同节点重跑会清理上一版 generated 资产。
- Codex2API 生成结果同样采用按节点覆盖清理。
- 尚无持久化 GenerationRun、候选组、selected/approved 状态及完整输入快照。
- ComfyUI 当前 interrupt 接口的底层语义是全局中断，不能宣称为精确取消。

因此目前没有可用于选片和运行中接力的真正“生成历史”。

## 6. 实施阶段与状态

### Phase 0A：控制权与机器入口基础——已完成（2026-09-05）

- [x] Action Registry 覆盖现有领域功能。
- [x] CanvasDoc 增加 revision、schemaVersion、Brief/Handoff 引用。
- [x] Canvas Control Lease：status/acquire/renew/release/request-handoff/force-takeover。
- [x] 所有 canonical canvas 写入口校验 lease、epoch 和 expectedRevision。
- [x] 前端人工 lease、只读和交接状态与后端校验在同一可用改动中上线。
- [x] 展示状态与 canonical graph 分离。
- [x] `GET /api/canvas/:id/agent-view`。
- [x] `POST /api/canvas/:id/operations`。
- [x] 结构化错误和 idempotency。

实现说明：

- 新增持久化表 `canvas_control_leases` 与 `canvas_operation_receipts`；进程实例变化会使旧租约过期，token 只保存 SHA-256 摘要。
- `GET /api/actions` 提供运行时 Action Registry，包含稳定 action name、输入输出 JSON Schema、权限、lease 要求、副作用、幂等/可逆性、可用性和结构化错误声明，并覆盖现有 Controller 领域入口。0A 的 operations 支持 `replace_graph`、`rename_canvas`、`set_brief`；节点级语义 operations、Operation Log 与 Checkpoint 仍严格留在 0B。
- 兼容 `PATCH /api/canvas/:id` 已包装为受 lease/revision/idempotency 保护的 operation batch；删除画布同样要求 lease。Canvas 条件更新与 operation receipt 在同一 SQLite 事务中提交，回执失败会回滚 Canvas 和 revision。
- 带 `canvasId` 的 ComfyUI Run、Codex2API 生图/编辑和节点生成资产清理也校验同一 lease/epoch/expectedRevision，避免绕过 graph API 修改画布共享产物。
- 人工进入画布时若后端确认控制权空闲，会自动竞争取得人工 lease 并进入可编辑状态；若已有人工或 AI 控制者，或竞争瞬间被其他写入者抢先取得，则保持只读并持续轮询、准确显示控制者类型与状态，仅此时提供“请求交接”。人工取得 lease 后每 15 秒续租；锁定时完整禁用节点编辑、运行、中断、上传、删除、连线和新增，但仍允许查看、下载、选择和 viewport。人工持有者观察到 `handoff_pending` 后停止新编辑，等待串行保存及追写队列完全排空后才释放。列表页重命名/删除使用短租约。
- 编辑器在返回按钮与画布标题之间以独立浮块常驻展示“有未保存更改 / 保存中 / 已保存时间 / 保存失败”状态，并提供立即保存按钮与 `Ctrl/Cmd+S`；保存失败时保留待提交内容并允许手动重试，存在待保存或在途写入时关闭页面会触发浏览器离开提醒。只读会话明确显示“只读”，不以“已保存”误导当前控制状态。
- 控制权状态由底部大提示条改为画布标题后的紧凑浮块，默认不展示 holder ID，也不重复“当前控制者”文案；通过绿/橙/蓝边框和底色区分可编辑、只读与交接中，点击后再展示完整 ID、revision、状态说明和请求交接入口。
- PC 端画布详情页独占 ProLayout 右侧内容区，移除默认内容 padding、画布边框圆角和页面级纵向滚动，画布工作区完整铺满可用宽高；其他路由保持原布局间距。
- viewport 改存浏览器 localStorage，不再写入 canonical graph，也不增加 revision；旧 graph 中 viewport 仅作一次兼容读取。
- 自动化证据：6 个 Jest suite / 43 个用例通过；其中 SQLite 集成测试覆盖单写者、交接与新 epoch、旧 lease 拒绝、TTL/进程实例失效、revision 冲突、幂等重放、batch 单次增版、非法 batch 无部分修改、回执故障事务回滚和人工强制接管原因。
- 真实 HTTP 验收覆盖：健康检查、45 项 Action Registry schema/error 元数据、第二写入者 423、共享资产/Codex2API 无 lease 写入 409、幂等请求重放、旧 revision 409、request-handoff/holder renew/release/new acquire、旧 epoch 409。
- 人工页面双会话验收：AI `phase0a-ui-agent` 持有时页面显示 AI/active/只读，节点运行、删除、提示词、模型及开关均禁用；人工请求交接后 AI 观察 `handoff_pending` 并在 revision 1 释放，页面自动取得 epoch 2 并恢复编辑；人工重命名保存后 revision 2；缩放 viewport 后 revision 仍为 2 且 canonical `graph.viewport` 为 null。验收临时画布已受控清理。
- 真实业务画布复验：在“AI接管协作测试”上，人工 epoch 12 经 `request-handoff` 主动释放，AI `codex-phase0a-acceptance` 取得 epoch 13 并成功执行 revision 77→78 的受控 operation，旧人工 epoch 12 写入返回 `409 STALE_LEASE`，随后人工取得新 lease 并恢复编辑。进一步验证默认只读观察后，空闲状态准确显示“无控制者/取得编辑权”，AI `codex-display-check` 持有 epoch 15 时页面在轮询周期内更新为 AI/active/只读及完整 ID。最终现场交接验证中，人工 epoch 16 → AI epoch 17 → 人工 epoch 18，AI 失联时 TTL 到期恢复路径生效。
- 已知阶段边界：0A 仍使用过渡期 `replace_graph` 和浅层 graph 校验；完整节点语义 operations、领域图校验、Operation Log、Checkpoint 与 inverse undo 属于 0B。Run 持久化、候选历史和运行中接力属于 1A/1B。

### Phase 0B：完整画布机器控制——已完成（2026-09-05）

- [x] create/update/move/delete node 后端语义操作。
- [x] connect/disconnect 与后端完整领域图校验。
- [x] 人工端常规保存迁移为语义 diff；不兼容的 React Flow 扩展字段变更仍受控回退 `replace_graph`。
- [x] Operation Log、Checkpoint、带 revision 前置条件的 inverse-operation undo。
- [x] 节点删除改为 graph/log/receipt 先原子提交，生成资产在提交成功后垃圾回收；回收失败不破坏 canonical graph 引用。
- [x] 无浏览器完成节点编排 HTTP E2E 初版。

实现说明与验收证据：

- `canvas.operations` 已支持 `create_node`、`update_node`、`move_nodes`、`delete_node`、`connect`、`disconnect`，与兼容 `replace_graph` 共用 lease、revision、幂等、领域校验和 operation log 事务。
- 图校验覆盖受支持节点类型及必要字段、节点/连线重复 ID、缺失节点、句柄格式和节点归属、媒体类型、单输入最大一条入线与有向环路；工作流存在时还会读取真实 `inputConfig` 精确验证动态字段，工作流已删除时允许历史节点与产物继续展示。
- 新增操作日志读取、安全撤销、Checkpoint 列表/创建/恢复接口并登记进 Action Registry。安全撤销只允许目标批次仍是当前 revision 时执行，避免覆盖撤销之后的人工修改；删除带产出资产节点的批次不可日常撤销，必须使用删除前 Checkpoint。Checkpoint 恢复属于覆盖式高影响操作。
- 人工编辑器的自动保存会对已确认 graph 计算语义 diff；新增/更新/移动/删除节点和连接/断开均提交语义操作。页面“历史”抽屉展示 actor、intent、revision 和操作类型，可创建恢复点、安全撤销，以及经明确确认后覆盖恢复。
- 只读观察者每 2 秒拉取 canonical canvas；发现更高 revision 时自动更新节点、连线、名称与产出，不再要求人工刷新页面。观察者同时读取现有 ComfyUI 内存 Run，工作流卡片和结果卡片均可显示排队、运行进度、成功、失败或中断状态。
- 新增可复用 `AgentLeaseGuard` 与默认 HTTP transport：统一封装 acquire、10 秒 heartbeat、renew 响应解析、`handoff_pending` 后的写入闸门/排空/release，以及 lease 丢失后禁止旧 token 自动重取。外部 Node Agent 可直接复用，不再自行拼装无条件保活循环。
- 节点删除、operation log、receipt 与持久化资产 GC job 在同一事务中落库；提交成功后执行文件清理，失败记录次数和错误并在后端重启或后续操作时重试。Checkpoint 对其中所有 `assetId` 形成强引用：节点删除和 Codex2API/ComfyUI 同节点覆盖重跑均不得清理这些资产，避免恢复出断裂引用。
- 自动化证据：7 个 Jest suite / 60 个用例通过；覆盖完整领域校验、批次原子性、回执回滚、撤销前置条件、动态 handle、GC 失败与重试、“恢复点引用旧产物 + 同节点重跑”资产保护，以及 AI heartbeat 保活、人工交接主动释放和旧 epoch 失效。后端 TypeScript 编译与前端生产构建通过。
- 3100 真实 HTTP 无浏览器验收完成空画布 → agent lease → 创建并配置 2 节点 → typed handle 连线 → 移动布局 → 读取审计日志 → 创建 Checkpoint → inverse undo（revision 0→1→2，最终 0 节点）；Action Registry 返回 50 项 action 与 9 类画布 operation，健康检查正常。
- 人工页面验收：从只读空闲状态取得人工 lease，历史抽屉正确显示 AI 操作批次，成功创建 revision 1 恢复点；撤销展示“仅最新修改可安全撤销”确认，恢复展示覆盖式确认。验收临时画布均已受控清理。
- AI 守护交接页面验收：在“人机协作体验2”上，正式 `AgentLeaseGuard` 以 epoch 8 持有并每 10 秒 heartbeat；人工点击“申请编辑权限”后，守护器在下一周期识别 `handoff_pending`、主动 release 并退出进程，页面自动取得人工 epoch 9。人工确认短暂等待后恢复编辑，API 核对 holder 为 human 且守护进程已退出。
- 已知阶段边界：Checkpoint 当前保护其引用资产且没有删除入口，因此受保护资产不会进入 GC；Checkpoint 清理与高影响历史保留策略后续单独设计。只读运行态展示目前仅覆盖进程内 ComfyUI Run，后端重启会丢失，Codex2API 也没有共享进度；统一持久化 GenerationRun、候选历史和批准保护仍属于 Phase 1A。

### Phase 1A：持久化 Run 与生成历史——已完成（2026-09-05）

这是正式开放 AI 自主/批量生成、运行中接力和选片的硬前置条件，不阻塞 Phase 0A/0B。

- [x] 持久化 GenerationRun，保留成功、失败、取消和未完成任务。
- [x] 保存最终输入、能力/工作流版本、操作者、上游资产、产物、错误和时间。
- [x] ComfyUI 与 Codex2API 统一接入 Persistent RunService。
- [x] 重跑追加候选，不自动删除旧产物。
- [x] 候选组、`candidateAssetIds`、`selectedAssetId`、`approvedAssetId`。
- [x] 已批准产物不能被 AI 静默替换或删除。
- [x] 按画布、节点、镜头查询生成历史的 API 和 UI。
- [x] run/get/list/wait/cancel/retry/adopt。
- [x] 后端重启后核对与恢复未完成 Run。
- [x] 统一 Asset 导入、lineage 和浏览器上传先落 `assetId`。

实现说明与当前验收证据：

- 新增 `generation_runs` 与 `generation_candidate_groups` 持久表。Run 保存 provider、平台/provider run ID、画布/节点/镜头/parent run、脱敏后的最终输入快照、能力或工作流版本、输入/输出资产、actor、attempt、错误与完整时间状态；同一 idempotency key 重放不重复提交，不同输入复用同一 key 返回冲突。
- ComfyUI 和 Codex2API 的文本生成、生图、编辑、图像理解均在 provider 请求前创建 Run；ComfyUI 继续使用 provider prompt ID，Codex2API 同步请求也得到平台 runId。历史 API 支持分页与 canvas/node/shot/status/provider 过滤，并提供 lineage、wait、retry、adopt 与诚实的 cancel 能力边界。
- ComfyUI/Codex2API 重跑改为追加资产，不再按节点自动删除旧产物。成功输出追加到同一 canvas/node/shot 候选组；人工可选择和批准，批准必须声明人工 actor，批准后不可改批，节点资产清理也会保留已批准资产。
- 生成卡片统一内嵌当前产物与横向版本历史：成功的文字、图片、视频进入节点历史，失败任务只进入画布级流水并保留错误。人工选择旧版本后会持续作为当前输出；下一次成功生成会自动切换到最新成功版本。文字 Run 持久化完整 `outputText`，节点历史显示确定性截断摘要，不额外调用模型生成摘要。
- 画布级“生成流水”是只读时间线，包含成功、失败、取消及文字产物，不提供选择/批准操作；长文字默认折叠并可展开。旧 Result 节点继续兼容，但新的 ComfyUI 运行直接在原卡片内展示产物，不再自动创建独立结果卡。
- 运行反馈按 provider 能力区分：Codex2API 无细粒度事件时从开始到结束显示动画 70%，成功或失败后隐藏；ComfyUI 沿用真实进度和当前处理节点名称。
- 服务启动时把遗留 queued/running 任务标为 `needs_attention` 并记录 `PROVIDER_STATE_UNCONFIRMED`，不伪造成功。ComfyUI 并发存在时拒绝其全局 interrupt，返回 `CANCEL_NOT_PRECISE`。
- 画布顶栏新增“生成历史”，展示 provider、状态、时间、尝试次数、节点、错误及全部候选缩略图，并提供选择/批准。真实 Chrome 页面已验证入口和空历史状态可见。
- 自动化：8 个 Jest suite / 64 个用例通过；新增持久 Run 幂等（含 JSON 字段顺序无关）、连续重跑候选追加、批准保护、文字产物持久化/自动选择/手工回切、重启核对测试。后端 TypeScript 与前端生产构建通过；3100 重启健康，SQLite 自动建表，Action Registry 已包含文字候选切换 action。
- 真实 provider E2E：在独立画布 `eb731614-68b6-4a06-83bc-fc9a8e2ebfd6` 上，ComfyUI “Z-Image文生图”连续运行两次，平台 Run `ed5a9521-300f-4139-9c88-03f59ccc01e3`、`19b2ca92-aba6-48a1-bc7c-3a2627b1bf6e` 均成功，候选组保留两个独立平台资产；Codex2API `codex` 生图连续运行两次，Run `0a190571-3b83-4e68-a73d-adf30d0e0139`、`9465c836-476a-4c26-b4dc-f94ad39f1096` 均成功并保留两个候选。
- 重启与幂等 E2E：重启 3100 后仍查询到 4 条 `succeeded` Run、两组各 2 个候选、ComfyUI `selectedAssetId=67599c51-a5cc-4e0a-aa8a-df0d142c92be`、Codex2API `approvedAssetId=22ce85f5-efa4-40b8-8509-2196dfbb9519`，批准资产 HTTP 200 且 lineage 返回对应输出资产。相同 Codex2API 幂等键重放返回原 Run `9465c836-476a-4c26-b4dc-f94ad39f1096`，总数保持 4，未再次提交 provider；实测过程中发现并修复 JSON 字段顺序导致的误冲突。
- 真实 UI E2E：Chrome 打开验收画布后，“生成历史与候选”抽屉展示全部 4 条 Run 和缩略图，跨重启准确显示“已选择”与“已批准”；尝试把批准切换到另一个 Codex2API 候选返回 `409 APPROVED_ASSET_PROTECTED`。
- 真实文字与节点历史 E2E：在画布 `07be6538-74f8-4e26-a4e3-6b75fae1e56e` 连续真实调用 Codex2API 两次，Run `16fa8b6c-0dfd-4620-961c-9570822be91b` 为最新成功版本并自动生效。Chrome 人工切换旧文字后，节点正文及“当前”标识同步迁移并保存；画布生成流水显示两条文字记录、摘要折叠和“展开全文”，随后已恢复选择最新版本。长调用期间原 lease 过期后的 graph 写入被正确拒绝，重新取得新 lease 后安全保存至 revision 2。
- 最终人工验收：2026-09-05 用户手动验证统一卡片产物、节点内历史与当前态样式、文字/图片版本切换、ComfyUI 正负提示词连线，以及文生文/图像理解的普通文本、图像提示词和视频提示词模式，未发现问题；Phase 1A 正式完成，可进入 Phase 1B。
- 已知边界：`retry` 当前创建带 parent lineage 的新尝试记录，由调用方按保存的输入重新提交；provider 自动重投与运行中 adopt 属于 1B 接力执行器范围。ComfyUI 第二次运行命中其缓存，provider 输出文件名相同，但平台仍形成独立 Run 和独立捕获资产，候选历史未覆盖。

### Phase 1B：运行中双向接力——已完成（2026-09-06）

- [x] AI 发起 Run 后交给人工继续。
- [x] 人工发起 Run 后交给 AI 继续。
- [x] 底层取消能力和限制可被 Agent 发现。
- [x] E2E 覆盖运行中、成功、失败、取消、重启待确认和旧租约失效。

实现说明与当前验收证据：

- 新增持久化 `generation_run_handoffs` 审计表。每次交接冻结记录平台 `runId`、`providerRunId`、Run 状态、输出资产、来源 actor/lease epoch、摘要和接手 actor/新 epoch；Canvas 的 `lastHandoffId` 同步指向最近交接。交接不修改 Run 身份、不重新提交 provider，也不自动取消任务。
- 新增 `POST /api/runs/:id/handoff`：当前租约持有者保存 Run Handoff 后主动释放画布 lease；actor 身份必须与租约持有者一致。新增的 `POST /api/runs/:id/adopt` 要求接手者已取得同画布的新 lease，并在原 Handoff 上记录接手者；同一接手者/epoch 重放幂等，其他接手者重复接管返回结构化冲突。
- `run.get`、`run.wait` 与历史列表返回持久化交接记录/最近交接和机器可读 `capabilities`。UI 的生成流水会显示“等待接手”“人工已接手”“AI 已接手”或“交接失败”，刷新后仍保留。人工页面响应交接请求时会先排空保存，再为最近 Run 写 Handoff 并释放 lease；请求方取得新租约后自动 adopt。可编辑者与只读观察者都会持续轮询共享 Run，接手后进度不会消失。
- Run 状态回调继续不依赖画布 lease，因此释放、旧 epoch、lease 过期或新控制者接手不会阻止 provider 终态落库。重启后无法核实的任务沿用 1A 规则进入 `needs_attention`，仍可通过同一 Handoff/adopt 流程接手处理。
- Action Registry 新增并明确声明 `run.handoff`/`run.adopt` 的 lease 约束和“不取消、不重投、保持双重 Run ID”语义；`run.cancel` 要求先读取 `capabilities.cancel`。当前 ComfyUI 只有全局 interrupt，Codex2API 为同步请求，均不宣称精确取消；统一接口对活跃任务返回 `409 CANCEL_NOT_PRECISE`，ComfyUI 原生 interrupt 在并发任务存在时继续拒绝危险全局取消。
- 自动化：9 个 Jest suite / 73 个用例通过；新增 SQLite 双向接力集成矩阵覆盖 `running`、`succeeded`、`failed`、`cancelled`、`needs_attention`，验证 AI→人工、人工→AI、旧 epoch 拒绝、身份防伪、重复 adopt 幂等、数据库中仅一个平台 Run，且 `providerRunId` 不变。后端 TypeScript 与前端生产构建通过。
- 3100 后端按生产方式重启后健康检查正常，数据库自动建立 `generation_run_handoffs`，运行时 Action Registry 可发现 `run.handoff`、`run.adopt`、`run.cancel` 及其能力边界。
- 真实 provider/UI 双向验收：使用 `Z-Image文生图` 30-step 长任务完成双向接力。人工→AI：页面收到请求后保存、写 Handoff、释放，AI epoch 9 adopt 原 Run `97ff2a93-73bd-4183-80de-55ec25820518`，providerRunId `9811cc66-51f0-4cdc-a392-1dc039502410` 保持不变，页面在只读阶段仍显示 97%/SaveImage，最终成功。AI→人工：Run `18b8e383-bfc3-4650-846a-0a7b8b9a6a62` 在 13% 时请求交接，Handoff 快照准确为 `running`，providerRunId `5982b5e2-6a24-44e4-85d3-9e38af850f6f`；人工 epoch 10 自动 adopt 后页面继续显示 33%→63%→90%→生成完成，生成流水显示“人工已接手”及新增可下载资产 `71cf8a4b-b06f-4013-8bea-1dcc7cc9a9e7`。全程平台 Run 数未增加、没有取消或重复提交。

### Phase 2：Shot Plan、选片与自主生产——暂不实施（范围外）

- 未来参考：Shot Plan 和镜头状态。
- 未来参考：Brief、分镜规划和验收条件。
- 未来参考：候选比较、人工选片和基础质量检查。
- 未来参考：角色、场景、风格参考资产。
- 未来参考：成本、时长和运行次数预算。
- 未来参考：多镜头执行和断点续跑。

本阶段从当前实施计划中移除。未来只有在用户重新明确立项后才恢复实施；届时应重新确认范围、优先级和验收合同，不因 Phase 1B 完成而自动启动。

### Phase 3：成片闭环——暂不实施（范围外）

- 未来参考：时间轴或等价序列模型。
- 未来参考：拼接、裁剪、转场、配音、音乐和字幕。
- 未来参考：音画同步与最终检查。
- 未来参考：导出预设与成片资产。
- 未来参考：受控外部发布。

## 7. 阶段验收合同

阶段状态只有在该阶段的功能清单、行为场景和验收证据全部满足后，才能标记为“已完成”。接口存在、页面可打开或单次手工成功均不能单独作为完成依据。

当前发布和 Issue #1 的验收范围止于 Phase 1B，且 Phase 0A、0B、1A、1B 均已通过。7.5 起的 Phase 2、Phase 3 与最终 Skill 合同作为未来若重新立项时的设计参考，不构成当前未完成项。

### 7.1 Phase 0A 验收合同

用户可观察结果：

- 人工可以显式取得画布控制权、正常编辑和保存，并看见当前控制者及交接状态。
- AI 持有控制权时，人工仍可只读查看、预览和改变本地 viewport，但不能修改共享状态。
- 人工与 AI 的正常切换经过 `request-handoff`；`force-takeover` 不作为日常入口。
- Agent 可以通过 Action Registry 和 `agent-view` 理解当前可用能力与画布状态。

必须通过的行为场景：

1. 人工持有 lease 时，第二个人工会话或 AI 写入返回 `423 CANVAS_LOCKED`。
2. 当前持有者收到交接请求后停止新编辑，完成待保存内容并释放；新持有者取得的 revision 与释放时一致。
3. 控制权切换后，旧 token、旧 epoch 和延迟请求返回 `409 STALE_LEASE`，不能改变画布。
4. lease 心跳正常续期；持有者异常退出并超过 TTL 后，另一方可以重新取得控制权。
5. 使用旧 `expectedRevision` 写入返回 `409 REVISION_CONFLICT`，不得静默覆盖。
6. 相同 idempotency key 重放只产生一次状态变化，并返回相同语义结果。
7. 一个 operation batch 成功只增加一次 revision；失败不产生部分修改或 revision 增长。
8. viewport、选择和面板变化不增加 canvas revision，刷新后不污染 canonical graph。
9. 前端取得人工 lease、携带 revision 保存、只读降级与后端强制校验同时可用，不允许只上线后端锁。
10. Action Registry 返回稳定 action name、schema、权限、lease 和错误信息；`agent-view` 不暴露密钥。
11. `request-handoff` 是默认 UI/Agent 路径；人工故障接管会记录原因并产生新 epoch。

完成证据：后端单元/集成测试、前端生产构建、3100 真实 HTTP 双写者与交接测试、人工页面只读/恢复编辑验证，以及本文中的实现说明和已知限制。

### 7.2 Phase 0B 验收合同

用户可观察结果：

- AI 不打开浏览器即可完整创建和调整节点图。
- 人工可以看见 AI 的操作批次、创建恢复点，并安全撤销一批 AI 修改。
- 无效连接和非法节点不会进入 canonical graph。

必须通过的行为场景：

1. Agent API 可创建、更新、移动和删除所有已支持节点类型，并能连接和断开 typed handles。
2. 后端拒绝重复 ID、缺失节点/handle、媒体类型不匹配、超出最大入线数、非法动态字段和禁止的环路。
3. 一批 operations 要么全部成功，要么全部失败；失败不得留下半张图。
4. 人工端 `replace_graph` 与语义 operations 遵守相同 lease、revision、校验和日志规则。
5. 每个成功批次记录 actor、intent、base/result revision、lease epoch、operations 和幂等键。
6. Checkpoint 可恢复完整状态；日常 inverse-operation undo 不覆盖撤销之后发生的人工修改。
7. 删除节点、关联边、候选引用和资产生命周期保持一致；文件清理失败不能造成 graph 已提交但关键资产引用损坏，反之亦然。
8. 仅通过 Agent API 完成“读取空画布 → 创建节点 → 配置参数 → 连线 → 移动布局 → 删除/撤销”的 E2E。

完成证据：领域校验测试、operation 原子性和撤销测试、事务/垃圾回收失败注入测试、无浏览器节点编排 E2E、操作日志样例及 UI 审计/Checkpoint 验证。

### 7.3 Phase 1A 验收合同

用户可观察结果：

- 人工可以按画布、节点和镜头查看完整生成历史，对候选进行选择和批准。
- 重跑会增加候选，不会替换或删除旧结果。
- 页面刷新或后端重启后，运行、参数、产物和选择仍然存在。

必须通过的行为场景：

1. ComfyUI 与 Codex2API 的每次提交都先创建持久化 GenerationRun，并保存最终有效输入和能力/工作流版本。
2. queued/running/succeeded/failed/cancelled/needs_attention 状态及错误、尝试次数和时间信息可查询。
3. Run 与上游资产、输出资产、canvas、node、shot 和 parent run 的 lineage 可双向追溯。
4. 同一节点连续重跑至少两次后，旧候选仍可访问，新候选追加到同一候选上下文。
5. `selectedAssetId` 与 `approvedAssetId` 刷新和重启后保持；未经授权的 AI 删除或替换被拒绝。
6. 相同 Run idempotency key 不会向提供方重复提交任务。
7. 服务重启后会重新核对未完成 Run；无法确认状态时标记 `needs_attention`，不能伪造成功或直接丢弃。
8. 历史 API/UI 支持分页和按 canvas/node/shot/status/provider 查询，且不返回密钥或不必要的敏感输入。
9. 浏览器上传先落为 Asset，再以 `assetId` 进入正式运行；刷新后 AI 可继续使用。
10. 底层不支持精确取消时，Capability/Action 明确声明限制，接口不得伪装为 run 级取消。

完成证据：数据库迁移和持久化测试、两种 provider 的 Run 适配测试、连续重跑候选测试、批准保护测试、后端重启恢复测试、历史 API/UI E2E 和资产 lineage 样例。

### 7.4 Phase 1B 验收合同

用户可观察结果：

- 人工和 AI 都能在生成任务进行中请求交接，新控制者从同一 Run 状态继续。
- 交接不会重复提交任务、丢失进度或自动取消运行。

必须通过的行为场景：

1. AI 启动 Run 后完成 Handoff 并释放 lease；人工刷新页面后可继续观察、选择结果或在能力允许时精确取消。
2. 人工启动 Run 后完成 Handoff；AI 可 adopt、wait、读取产物并继续下游。
3. 交接前后的 `providerRunId` 和平台 `runId` 保持不变，不产生重复 Run。
4. Run 成功、失败、取消、`needs_attention`、提供方断连、后端重启和 lease 过期场景均能交接。
5. 控制权的旧写请求仍按 epoch 拒绝，但 Run 状态更新不依赖旧 lease，能够继续持久化。
6. 不支持精确取消的 provider 在并发任务存在时拒绝危险取消，并给出机器可读原因。

完成证据：人工→AI 与 AI→人工双向 E2E、各终态和故障矩阵、重启中接力测试、无重复提交证明及 UI/Agent Handoff 样例。

### 7.5 Phase 2 验收合同

用户可观察结果：

- 用户提供 Brief 后，AI 可以形成明确 Shot Plan、生成候选并把审美决策交给人工。
- 人工选片或批准后，AI 能从该选择继续后续镜头，不会重新猜测。
- 长任务可以暂停、交接和断点续跑。

必须通过的行为场景：

1. Brief 能转换为有顺序、目的、时长、提示词、参考资产和验收条件的 Shot Plan，不依赖节点坐标推测顺序。
2. 每个 Shot 的 planned/generating/review/approved/rejected 状态转换合法且可审计。
3. AI 可为镜头生成多个候选并执行基础技术质量检查；审美不确定时进入 `needs_attention`，不擅自批准。
4. 人工选择或否决候选后，AI 接手读取同一决定，并将 approved 资产用于下游。
5. 角色、场景和风格参考资产在多个镜头中保持明确引用和血缘。
6. 最大运行次数、连续失败数、时长和成本阈值生效，达到阈值后停止并请求人工。
7. 中断、浏览器关闭、Agent 更换或控制权交接后，可以从未完成 Shot 继续，不重复已批准工作。
8. 通过 Agent API 完成至少一个多镜头样例：Brief → Shot Plan → 候选 → 人工选片 → AI 继续 → 所有镜头 approved。

完成证据：Shot 状态机测试、预算和失败阈值测试、跨镜头引用测试、断点续跑测试、一次真实多镜头人机接力 E2E 及最终 Shot Plan/候选记录。

### 7.6 Phase 3 验收合同

用户可观察结果：

- 已批准镜头可以按明确顺序形成可预览、可重新打开和可导出的成片。
- 音频、字幕和画面关系可检查，最终导出资产可追溯到全部输入与决策。
- 外部发布永远需要独立人工授权。

必须通过的行为场景：

1. 时间轴或等价序列模型能表达镜头顺序、裁剪、转场、音轨、字幕和版本，不依赖临时 UI 状态。
2. 只允许 approved 镜头默认进入最终成片；替换已批准素材需要显式操作和审计。
3. 渲染失败、部分产物失败和服务重启后可恢复，不重复已经完成且可复用的步骤。
4. 导出保存最终参数、源镜头、音频、字幕、工作流版本和产物 lineage。
5. 至少验证一种目标格式的时长、分辨率、帧率、音轨和文件可播放性。
6. 人工可预览并请求修改；AI 根据修改意见产生新版本，旧版本仍可追溯。
7. 发布/上传到外部服务在没有本次明确人工授权时必须停止；授权后记录目标、版本和结果。

完成证据：序列模型和渲染测试、失败恢复测试、媒体技术检查报告、成片版本与 lineage、人工修改回合 E2E，以及外部发布授权保护测试。

### 7.7 最终文档与 Skill 验收合同

1. Action Registry 与 OpenAPI/JSON Schema 和实际接口一致，自动检查不存在仅有前端入口的领域功能。
2. `docs/AI-COLLABORATION.md` 能让人工理解控制权、请求交接、只读状态、生成历史、选片和恢复方式。
3. `skills/carrot-canvas/SKILL.md` 不硬编码易变化的 action 参数，而是指导 AI 动态发现能力并遵守协作边界。
4. 一个没有本项目历史上下文的新 AI，仅依赖 Skill、Action Registry 和 schema，不操作鼠标即可完成一次双向交接的视频生产流程。
5. 黑盒 Skill 验收覆盖请求交接、revision 冲突恢复、运行中接手、候选选择、人工批准保护、高影响操作确认和主动释放控制权。

### 7.8 所有阶段统一提交证据

每个阶段完成时必须在本文对应阶段留下：

- 实际实现范围及与原设计的偏差。
- 编译、单元测试、集成测试和行为级 E2E 结果。
- 人工可见 UI 验收结果。
- 涉及持久化时的数据库迁移和重启恢复结果。
- 已知限制、延期项及其所属后续阶段。
- 对应提交或 PR，以及必要的接口/日志/截图样例。

完成阶段的会话负责先自验并更新证据；建议再由没有参与实现的会话按本合同独立验收。验收失败时保持“进行中”，不得通过降低或事后改写标准标记完成。

## 8. 最终文档和 Skill 交付

本节原规划与 Phase 2/3 的完整自主视频生产闭环绑定，当前暂不实施，也不作为 `v1.0.0` 或 Issue #1 的发布阻塞项。以下内容保留供未来重新立项时评估。

未来若重新立项，预期交付：

1. Action Registry，作为运行时能力事实。
2. OpenAPI/JSON Schema，作为接口契约。
3. `docs/AI-COLLABORATION.md`，面向人工使用者和开发者。
4. `skills/carrot-canvas/SKILL.md`，面向接手平台操作的 AI。
5. 可重复执行的无浏览器 E2E 与 Skill 验证脚本。

`SKILL.md` 只维护稳定的操作策略、协作约束、错误恢复和完成检查；具体 action、参数和 schema 必须动态读取 Action Registry/OpenAPI，不能把 Skill 变成容易过期的接口副本。

Skill 应指导 AI：能力发现、请求交接、lease 生命周期、安全 operations、revision 冲突恢复、Run 接管、候选与批准保护、高影响操作确认、Handoff 写入和主动释放控制权。lease 生命周期必须明确要求解析每次 renew 响应，并在 `handoff_pending` 时停止新工作、排空写入和 release，不能只做无条件心跳。

Skill 应随各阶段接口逐步更新，不能等全部代码完成后才首次编写；最终由一个没有项目历史上下文的新 AI 做黑盒验收。

### 8.1 跨项目基础 Skill——已实现并验证（2026-09-08）

用户于 2026-09-08 单独授权交付跨项目画布控制 Skill。本次封装已完成的 Phase 0A–1B 能力，不重启 Phase 2/3，也不宣称满足 §7.7 的最终视频生产黑盒验收。

- 仓库维护源为 `skills/carrot-canvas/`，用户级安装目录为 `C:/Users/liu/.codex/skills/carrot-canvas/`。Skill 通过实时 Action Registry、agent-view 与工作流 schema 发现能力；对于当前宽泛 schema，引用文件补充已核对的节点、运行、媒体协议并明确其边界。
- 自带无第三方依赖的 Node 22+ `scripts/canvas.mjs`，支持从任意当前目录读取 API、新建画布、语义批次、任务模块、multipart 媒体上传和资产下载。默认 `http://localhost:3100/api`，可通过 `CARROT_CANVAS_URL` 配置，不依赖后端源码或 pnpm workspace。
- `withCanvas` 统一正常请求交接、有限等待、10 秒续租、完整状态检查、串行写入、revision 跟踪、排空与主动释放。状态不明立即关闭写闸，不自动重取租约；业务写入不自动重试或覆盖冲突。长 provider 请求可在交接后继续服务端落库，禁止新 graph 写入。多个 Run 时以最新 Run 保存交接锚点，其余仍在同画布历史；无 Run 时直接释放，保留操作日志。
- 使用约束包括 agent 身份、批准保护、已有授权边界、Run ID 区分、非精确取消、实际参数解析及生成后 graph 产物同步。当前没有通用 DAG 自动执行器，Skill 明确要求调用方解析上游入参。下载拒绝覆盖已有文件。
- 验证：官方 `quick_validate.py` 通过；3 项 Node 行为测试覆盖在途图写入排空后交接、同步 provider 未结束先交接、续租异常禁止写入与不重取。仓库外真实 3100 HTTP 验收覆盖创建两节点/typed 连线、移动、revision 冲突、幂等重放、非法批次原子拒绝、multipart 上传/下载字节一致/覆盖保护、超过 45 秒 TTL 的自动续租、AI→人工与人工→AI 协议交接、任务异常主动 release，均通过。临时画布 `c7c95937-5ef8-4f23-9ba3-381addb15aa0` 已清理，生成 Run 数为 0。
- 本次未改后端业务或前端，不需重建重启；新增 Skill 没有重新执行真实 provider 生成或浏览器人工交接验收。真实生成与 UI 接力继续引用 Phase 1B 原有证据，不能将客户端模拟测试当成新一次 provider/UI 验收。

## 9. 核心验收门槛

当前范围（截至 Phase 1B）至少满足第 1–10、13 项；这些门槛已经随各阶段完成并留存证据。第 11–12 项依赖 Phase 2/3 和最终 Skill，当前暂不实施，仅保留为未来目标。

1. 任一时刻同一画布只有一个写入者。
2. 控制权切换后旧 lease 和延迟写请求失效。
3. 正常切换经过 `request-handoff`；`force-takeover` 仅用于人工故障恢复。
4. 只读查看和 viewport 改变不增加画布 revision。
5. 防抖保存完成后才允许交接。
6. 相同 idempotency key 不产生重复节点、操作批次或 Run。
7. 非法节点、端口、媒体类型、环路和跨画布资产返回机器可读错误。
8. 每次重跑产生可追溯的新 Run 和候选，旧候选不被自动删除。
9. 人工批准候选后，AI 未经授权不能覆盖或删除。
10. 后端重启后仍可查询 Run 历史、输入、产物、失败原因和选择状态。
11. 不打开浏览器，仅通过 Agent API 可完成创建画布到视频导出的完整流程。
12. 一个全新 AI 仅依赖 Skill、Action Registry 和 schema，可与人工完成一次双向接力。
13. AI 持有期间人工请求交接后，AI 在下一个续租周期内识别 `handoff_pending`，停止新写入并主动释放；持续占用守护模式同样通过该验收。

Issue #1 按 Phase 1B 的完成状态关闭；未来若重新启动 Phase 2 及后续工作，应新建或重新规划 Issue，不回退本次已完成结论。阶段实现不得用“接口已存在”替代行为级 E2E。

## 10. 后续 AI 会话工作约定

除非用户重新明确立项，不得继续实现 Phase 2、Phase 3 或最终 Skill/成片闭环；维护和修复现有 Phase 1B 范围不受此限制。

每个阶段建议使用独立会话和独立提交/PR。新会话必须：

1. 先阅读 `AGENTS.md`、本文及受影响模块对应的集成文档。
2. 开始前核对当前分支、工作区未提交变更和本文阶段状态。
3. 只实现用户指定的阶段，不提前展开后续阶段。
4. 保护不属于本任务的现有改动。
5. 完成编译、测试、后端健康检查和对应行为级 E2E。
6. 更新本文中的实际实现状态、偏差和变更记录。

Phase 0A 推荐的新会话指令：

> 实现 Issue #1 的 Phase 0A。开始前完整阅读 AGENTS.md、docs/AI-NATIVE-CANVAS.md 及相关集成文档；只实现 Phase 0A，完成测试和行为级验收，并更新设计文档的阶段状态，不开始 Phase 0B。

## 11. 变更记录

- 2026-09-10：画布所有现有卡片类型统一支持用户填写卡片名称与备注，字段随节点 data 经既有 lease/revision/语义化 `update_node` 流程持久化；卡片标题优先展示自定义名称。图片、视频、音频的当前产物、结果卡片、输入资产、节点历史候选与画布生成流水均在对应媒体附近显示完整且可复制的 `assetId`，便于人工在对话、接口和历史记录之间准确引用产物。同步更新仓库 `carrot-canvas` Skill，指导外部 AI 使用 `data.cardName` / `data.note` 并在交付与选片时报告完整 `assetId`。本次不改变资产 ID、Run、候选或 revision 合同。

- 2026-09-10：修复 Issue #15 移动端通过局域网 HTTP 访问时申请编辑权限永久停留在“申请中”。根因为非安全上下文没有 `crypto.randomUUID()`，human holder ID 在请求发出前即抛错且轮询吞掉异常；现统一提供基于 `crypto.getRandomValues()` 的 LAN HTTP 兼容 UUID（极旧浏览器有最终回退），覆盖控制权、保存、节点创建及各类 Run 幂等键。首次自动 acquire 失败会持续重试，轮询错误会显示具体状态；acquire 成功后立即保存 lease token 并维持续租，最新 canonical graph、生成历史或 Run adopt 短暂失败时保持写入禁用并每 2 秒重试，同步完成后才开放编辑。前端生产构建和 dev server 热更新通过，源码已无直接 `crypto.randomUUID()` 调用；3100 健康检查与 8000 页面访问正常，待用户在实际移动端刷新复验。

- 2026-09-10：画布 TTS 新增正式 `qwen3tts` Provider，0.6B CustomVoice 提供 9 个官方预设 speaker，1.7B VoiceDesign 支持只输入台词及音色/语调/表演描述直接生成，无需参考音频。Qwen worker 纳入既有持久化 FIFO 本机重型计算租约、GenerationRun、资产与候选合同，模型变体在同一 worker 内互斥换载。专用验收画布完成两条真实生成并回填结果，调度状态与进程观测正常。

- 2026-09-10：AI 配音节点新增“预设音色 / 自定义音色”双模式。新节点默认预设音色，可只输入台词、风格/情绪要求与语速直接生成；旧节点未存模式字段时继续使用自定义参考音频。预设由后端白名单解析，Run 保留模式与预设 ID 审计，不暴露文件路径；17 suites / 121 tests 与前后端构建通过。

- 2026-09-10：移除实验性的语音评价能力及其节点、接口、模型运行时、评价数据和测试画布。自动指标与最终人类听感不在同一决策维度，本阶段不再把该能力纳入画布生产闭环；TTS、精确停顿、通用 Run/资产以及本机重型计算调度保持不变。
- 2026-09-09：完成 Issue #17 TTS 精确停顿闭环。两种 Provider 共用 `<pause ms="N"/>`，平台在模型调用前解析版本化 pause plan，speech 段严格串行生成，静音按最终 WAV 采样率直接创建并无损拼接；整个推理、CPU 拼接、正式资产及 Run 落库持续持有同一外层本机重型计算租约。中间片段不进入资产/候选，取消停在 speech 边界，失败不覆盖旧候选。真实 CosyVoice Run `2da5fa14-35b4-4f9e-86e9-e73def3d7f06` 与 IndexTTS2 Run `d21d5a24-0d3b-4f2e-97ae-5eab26f140b4` 的 800ms/1500ms 静音均实现 0ms 采样帧误差，每条仅一个最终资产。
- 2026-09-09：Issue #12 支持在 AI 对话内确认 ComfyUI 托管。新增绑定当前进程快照的 5 分钟一次性令牌；Agent 可先展示快照并在收到本次明确确认后执行接管，无需用户回画布点击。执行前进程变化以及令牌缺失、伪造、过期或重放都会安全拒绝；Action Registry 标注 high-impact/human-confirmation。真实外部 Desktop 上完成令牌签发和伪造令牌不杀进程验证，16 suites / 101 tests 与前后端构建通过。

- 2026-09-09：Issue #11 GPU 调度升级为进程级 fail-closed。CosyVoice/IndexTTS 按需启动并在切出时验证端口与 PID 消失；ComfyUI 只结束调度器可证明所有权的进程，外部 Desktop 触发包含 PID/路径/内存的人工确认。任何 Provider 连续 3 次释放失败会记录 RAM/VRAM 观测、锁住后续队列并中断任务。真实 Desktop 冲突与取消不杀进程、重启清理两 TTS worker、16 suites / 100 tests 和前后端构建均通过，详见 [TTS-GPU-SCHEDULER.md](./TTS-GPU-SCHEDULER.md)。

- 2026-09-09：新增画布本地 AI 配音节点与统一 GPU Provider 租约。CosyVoice 3 / IndexTTS2 运行沿用 canvas lease/revision、持久化 GenerationRun、画布资产和候选历史合同；TTS 与 ComfyUI 三方只允许一个模型持有 GPU，后端重启会清理 worker 中可能残留的模型。真实双 TTS 生成、TTS→Z-Image 切换和浏览器播放闭环通过，未改变既定 Phase 2/3 范围。详见 [TTS-GPU-SCHEDULER.md](./TTS-GPU-SCHEDULER.md)。

- 2026-09-08：修复 Issue #10 只读旁观者产物可见性。画布现持续比较持久 Run 的状态、终态、输出及候选选择变化，并统一刷新节点历史与全局生成流水；旁观者把服务端当前选中的图片、视频或文字结果投影到本地节点和下游结果节点，但不进入画布保存队列、不要求 lease、也不增加 canonical revision。失败、取消与 `needs_attention` 等无产物终态仍通过共享运行态/流水同步；只保留运行、编辑参数、切换候选、恢复 seed 等写操作为禁用。

- 2026-09-08：按用户单独授权新增跨项目基础 `carrot-canvas` Skill 与独立 Node 控制脚本，覆盖动态能力发现、受控画布写入、双向交接、媒体上传下载及现有生成协议；结构校验、3 项生命周期测试和无费用真实 HTTP 验收通过。范围与证据见 §8.1，Phase 2/3 和最终成片 Skill 合同状态不变。

- 2026-09-07：实现 Issue #4 画布系统资源监控。画布右上角新增可折叠的 CPU/GPU/内存三圆环：圆环进度统一表示使用率，CPU/GPU 圆心优先显示温度、温度不可用时回退使用率，内存圆心显示占用率；GPU 点击详情可逐卡查看型号、负载、温度和显存。新增只读 `GET /api/system/resources` 与 `system.resources` Action，后端缓存采样并隔离单项失败；当前 Windows 环境使用 Node 系统时间/内存 API 和 `nvidia-smi`，CPU 温度无可靠传感器来源时明确返回不可用。展开/可见时 2 秒刷新，折叠或页面隐藏时降频；折叠状态仅存浏览器 localStorage，不修改 canonical graph 或 revision。新增 CPU 差分、多 NVIDIA GPU 解析及异常输出测试；完整后端 12 suite / 84 用例、后端 TypeScript 编译与前端生产构建通过。
- 2026-09-07：实现 Issue #9 ComfyUI seed 随机化。共享 schema 表单仅对结合 `/object_info` INT 类型与 KSampler/Noise/Seed 节点语义可靠识别的字段提供“一键随机 / 每次运行自动随机”，因此独立工具箱和所有含可识别 seed 的画布工作流卡片行为一致；画布持久化自动随机选项。自动 seed 在 Run 创建和 provider 提交前写入同一份最终 API JSON，`inputSnapshot` 保存实际值；卡片即时回显，节点历史与画布流水可显示/复制，节点历史可恢复一次 Run 的全部 seed。新增识别、误判保护及自定义节点元数据测试；完整后端 11 suite / 81 用例、后端 TypeScript 编译与前端生产构建通过。
- 2026-09-07：Issue #8 文生文上游文本二次加工通过用户手动验收并完成交付。仅 `capability=text` 在连接文本入参时将上游产物显示为只读“输入文本”，并保留独立可编辑的“加工要求”；未连接入参继续使用原有提示词逻辑，断开/重连不覆盖本地提示词。后端在请求提供方前以明确分区组合两部分，并在 Run 输入快照中分别保存 `carrotInputText` 与 `carrotInstruction` 以便复现审计；图像理解/图生文路径不受影响。新增组合边界、内部字段不透传和快照分字段回归测试；完整后端 10 suite / 78 用例、后端 TypeScript 编译与前端生产构建通过，3100 后端重启后健康检查正常。
- 2026-09-06：实现 Issue #7 图片与视频统一媒体预览。结果节点、ComfyUI/Codex2API 当前产物及节点生成历史统一使用独立预览层，支持同组稳定翻页、方向键切换、当前产物下载与关闭后恢复画布；视频节点卡片改为缩略入口，预览默认按源像素 100% 显示并提供“适应窗口”切换、源分辨率标识，切换或关闭时停止旧视频。该功能仅维护本地展示状态，不修改 canonical canvas revision。前端生产构建通过；真实画布验证图片双候选 `1/2 → 2/2` 翻页与下载目标同步，以及视频 `864 × 480` 原始分辨率、100% 默认模式和独立播放控件均正确。
- 2026-09-06：实现 Issue #2 画布手掌/指针交互模式。默认手掌模式保持拖动画布与节点；指针模式支持框选（节点部分相交即选中）、多选节点整体拖动和点击空白取消选择，在非文本输入焦点下按住空格可临时切换为手掌平移，松开或窗口失焦即恢复指针。交互模式与临时选择态仅属于本地展示状态，不写入 canonical graph，也不增加 canvas revision；节点最终位置仍通过既有 `move_nodes` 操作持久化。
- 2026-09-06：实现 Issue #6 Run 耗时展示。ComfyUI 与 Codex2API 卡片在排队/运行时本地每秒刷新已耗时，持久 Run 同步恢复 `queuedAt` / `startedAt` / `finishedAt`，因此刷新页面或控制权交接后可继续计时；节点历史和全局生成历史展示实际生成耗时，并通过提示说明排队、生成、总耗时与完成时间，旧记录时间不全时显示未知。进程重启协调把未完成 Run 标为 `needs_attention` 时补记结束时间。后端完整 10 suite / 76 用例、前后端生产构建通过。
- 2026-09-06：实现 Issue #5 图片提示词反推。图像理解卡片复用 `image-prompts` 兼容值和现有合并/正向/负向端口，但使用独立的视觉复现指令与 `reverse-image-prompt` Run 意图标记；历史切换与旧 `image-prompts` Run 保持兼容，不新增 canvas revision 或 Run 模型迁移。新增 2 个后端模式/异常测试，完整后端 10 suite / 75 用例、后端 TypeScript 编译和前端生产构建均通过；3100/8000 重启健康，真实“画风学习”画布确认反推选项、三路输出标识、限制文案和无图时禁用运行正确呈现；留待用户进行真实 provider 生成验收。
- 2026-09-06：按产品范围决定，AI Native 当前交付边界固定为 Phase 1B；Phase 2、Phase 3 及最终 Skill/成片闭环暂不实施，仅保留设计与验收合同作为未来参考。Phase 0A–1B 均已完成，Issue #1 可按当前范围关闭并发布 `v1.0.0`。
- 2026-09-06：完成 Phase 1B 真实 provider/UI 验收。验收发现并修复人工页面释放时漏写 Run Handoff、取得新租约后漏调 adopt、可编辑状态停止轮询共享 Run，以及 ComfyUI 列表进度未同步到持久 Run 四个串联缺口；30-step ComfyUI 双向接力确认同一 Run/ProviderRunId、连续进度、最终产物和历史交接标签均正确，Phase 1B 标记完成。
- 2026-09-06：实现 Phase 1B 运行中双向接力：持久化 Run Handoff、受 lease 保护的 handoff/adopt、接手幂等与身份校验、历史 UI 交接状态、机器可读取消边界，以及运行中和全部终态的 SQLite 双向 E2E。73 个后端用例、前后端构建、3100 重启/健康检查和 Action Registry 验证通过；等待真实长 Run 的 provider/UI 双向手动验收。
- 2026-09-05：用户完成 Phase 1A 最终手动验收，确认未发现问题；文档状态保持“已实现并通过行为级验收”，下一阶段为 Phase 1B 运行中双向接力。
- 2026-09-05：文生文和图像理解新增“视频提示词（正负分开）”，复用合并/正向/负向三路输出和 `outputParts` 历史；文生文针对文生视频描述动作、运镜、节奏及连续性，图像理解针对图生视频约束主体/服装/构图一致性。Run 记录输出模式，节点历史以紫色“视频提示词”标识。真实 Codex2API 文生视频提示词 Run `aa7306b0-07db-46c9-b7d5-f22659962cd8` 结构化生成成功。
- 2026-09-05：图像理解卡片同步支持普通文本/图像提示词模式；图像提示词模式从图片生成同版本正负提示词，保存 `outputParts` 并提供合并、正向、负向三路输出，沿用文字候选历史与整体切换语义。
- 2026-09-05：文生文卡片新增“普通文本 / 图像提示词（正负分开）”输出模式。仅图像提示词模式注入结构化 system message并强制非流式，Run 新增 `outputParts` 保存同版本正负提示词；节点同时暴露合并、正向、负向三路文本输出，分别兼容 Codex 单提示词输入与 ComfyUI 双 STRING 输入，历史切换同步恢复三路内容。真实 Codex2API 生成 Run `469af823-33e9-4c03-bcfc-b30a12e3a55a` 已验证结构化落库和页面展示。
- 2026-09-05：统一 Codex2API 与 ComfyUI 生成卡片：当前产物直接内嵌，节点下方提供成功产物横向历史；文字 Run 保存完整输出并显示本地截断摘要，图片/视频可预览下载。人工可切换任意旧版本且持续生效，下一次成功生成自动切到最新版本；失败仅进入包含错误信息的画布生成流水。画布流水取消选片/批准控件，文字可折叠展开；Codex2API 运行显示动画 70%，ComfyUI 保留真实进度和当前节点。真实文字双生成与人工回切/恢复最新通过。
- 2026-09-05：生成历史候选缩略图支持点击放大预览，并为每个候选提供平台资产下载入口；真实历史页面验证预览层与 4 个下载链接均可用。
- 2026-09-05：完成 Phase 1A 真实消耗验收：ComfyUI 与 Codex2API 各连续生图两次，4 条 Run/4 个资产持久化；选择、批准、lineage、批准替换拒绝、后端重启恢复、页面历史展示和幂等不重复提交通过。实测发现并修复幂等输入比较受 JSON 字段顺序影响的问题，Phase 1A 标记完成。
- 2026-09-05：Phase 1A 核心实现落地：统一持久化 GenerationRun/候选组与 lineage，ComfyUI、Codex2API 全能力接入，重跑改为追加候选，人工选片/批准保护、分页历史 UI、重启 `needs_attention` 核对和取消能力限制上线。
- 2026-09-05：完成 AI lease 守护器人工页面验收：AI epoch 8 持有期间人工申请编辑，守护器在下一 heartbeat 主动释放并退出，人工自动取得 epoch 9；确认“持续占用”模式不再阻塞正常交接。
- 2026-09-05：实现通用 `AgentLeaseGuard` 和 HTTP transport，AI heartbeat 不再只保活：renew 返回 `handoff_pending` 时先关闭新写入闸门，执行调用方最小排空回调，再主动 release；任务结束主动释放，旧 epoch/过期则进入 lost 且不自动重取。新增单元测试及真实 CanvasService 的 agent→human 新 epoch 集成测试。
- 2026-09-05：根据持续占用实测补充 AI 持权合同：Agent 必须持续续租并解析 renew 响应，`handoff_pending` 时停止新工作、排空最小收尾并主动 release；“只维持控制权”的守护模式也不得阻塞人工交接。新增一个续租周期内响应人工请求的验收门槛，并明确 TTL 只用于故障兜底。
- 2026-09-05：调整画布进入体验：首次进入时若控制状态为 available/expired/revoked，页面自动竞争取得人工 lease；取得后重新读取 canonical graph 避免初始读取竞态，竞争失败则刷新控制状态并安全回到只读。已有控制者时仍不抢占，继续使用请求交接流程。
- 2026-09-05：修复恢复点产物破图：统一资产覆盖清理入口会先收集该画布所有 Checkpoint graph 中的 `assetId`，被任一恢复点引用的旧产物在 Codex2API/ComfyUI 同节点重跑或节点清理时均保留；新增“旧产物受恢复点保护、新产物保留、无引用旧产物清理”的文件级回归测试。已在修复前物理删除的文件无法从 assetId 自动恢复。
- 2026-09-05：改进 0B 人机协作可见性：只读观察者会自动跟随更高 canvas revision，无需刷新即可看到 AI 的节点、连线和产出更新；同时轮询现有 ComfyUI 内存 Run，让工作流卡片与结果卡片共享显示生成进度和终态。明确该过渡能力不替代 Phase 1A 的持久化 Run，后端重启恢复和 Codex2API 统一进度仍未实现。
- 2026-09-05：修复工作流动态 handle 对 ComfyUI 子图节点 ID（如 `105:104`）的解析：不再按固定冒号段数拆分，改为根据 `inputConfig` 生成规范 handle 后精确匹配；同时修正 Codex 图像理解节点的输出类型为 text，补充“图像理解 → 图生视频提示词”回归测试。
- 2026-09-05：修复 Phase 0B 目标端口校验回归：后端此前把所有 `*-target` 误限定为 result 节点，导致前端合法的 Codex `text-source → text-target` 连线持续保存失败。现允许所有 Codex 能力节点接收提示词 `text-target`，并仅允许 edit/analyze 接收 `image-target`；新增对应集成回归测试。
- 2026-09-05：完成 Phase 0B：节点/连线语义 operations、完整领域图校验、持久化 Operation Log/Checkpoint 与安全 inverse undo；人工自动保存迁移为语义 diff并增加历史/恢复 UI；节点资产通过事务化持久 GC job 清理并保护 Checkpoint 引用。53 个测试、前后端构建、真实 HTTP 无浏览器编排和人工页面验收通过。
- 2026-09-05：人工打开画布不再自动获取空闲 lease，默认以只读观察者进入；控制浮块持续轮询并准确区分 AI、人工和无控制者，空闲时显式提供“取得编辑权”，有控制者时才提供“请求交接”。
- 2026-09-05：修复结果卡片的视频/图片下载被 Chrome 当作顶层 localhost 导航并报 `ERR_BLOCKED_BY_CLIENT`；下载按钮现在显式使用 HTML download 语义、保留原文件名并阻止画布点击冒泡。
- 2026-09-05：修复画布生成图片经开发代理下载时浏览器可能报网络错误的问题；资产附件响应现在显式返回 `Content-Length`、`Accept-Ranges` 和 `Cache-Control: private, no-transform`，并补充完整字节下载回归测试。
- 2026-09-05：修复人工取得 lease 后 Codex2API 节点仍使用初始只读闭包的问题；节点参数、文生文结果和图片资产现在可正常回写受控 graph 并触发保存，避免生成成功但页面无结果且不报错。
- 2026-09-05：补强 Phase 0A 保存可观测性：编辑器在返回按钮与标题之间增加独立保存浮块，常驻显示保存状态与最后保存时间，提供手动保存及 `Ctrl/Cmd+S`；失败后保留内容并支持重试，未完成保存时增加离开提醒；修复保存失败后无间隔自动重试的问题。
- 2026-09-05：压缩画布控制权提示：移除持续遮挡画布的大 Alert，改为标题后的状态浮块，默认隐藏 holder ID，点击后展示完整控制信息与交接操作，并以边框和底色表达编辑状态。
- 2026-09-05：调整 PC 画布详情布局为右侧内容区全幅显示，去除 ProLayout 默认边距及页面级纵向滚动条，不影响画布列表和其他页面。
- 2026-09-05：补充 Phase 0A、0B、1A、1B、2、3 及最终 Skill 的独立验收合同，明确用户可观察结果、必测行为和统一提交证据；阶段完成不得仅以接口存在或单次手工成功判定。
- 2026-09-05：按新增验收合同补齐 Phase 0A：operation 与幂等回执改为同一事务；旧 lease 重放先校验控制权；Action Registry 补真实 schema/error 元数据与遗漏入口；带 canvasId 的运行、产物写入和资产清理接入控制校验；前端交接改为保存队列排空后释放，并完整限制只读副作用、显示控制者。新增 SQLite 集成测试并完成双会话页面只读→请求交接→恢复编辑→保存及 viewport 不增版验收。
- 2026-09-05：完成 Phase 0A 初版：Action Registry、CanvasDoc revision 元数据、持久化控制租约、请求交接/人工故障接管、结构化冲突、幂等 operation receipt、Agent View 与 operations API；人工前端同步接入租约/只读/交接，viewport 从 canonical graph 分离。
- 2026-09-05：建立仓库内设计入口；确认单写者、请求交接优先、lease + revision、Action Registry、生成历史前置门槛、Phase 1A/1B 拆分及最终 Skill 交付要求。

- 2026-09-07（配置）：画布图生视频菜单新增 `MiniMax H3 双图参考生视频 · 重启天际`（工作流 ID `35c2f155-78f6-4762-9ce1-93b90c78856e`），支持两路图片与一路文本动态输入；默认素材与提示词可直接使用。入库与 schema 校验通过，本次未修改 canonical canvas graph、运行引擎或阶段完成状态。当前工作流不包含视频/音频参考输入。

- 2026-09-08（现有画布能力扩展，阶段状态不变）：MiniMax H3 全能参考在画布开放 46 个 typed 输入，包含完整 9 图 / 3 视频 / 3 对应配音 / 3 独立音频槽位以及可经文本连线输入的标量参数。新增 result.inputMode 输入节点（图片/视频/音频上传、文字字面量），沿用 create_node/update_node/connect 与 canonical revision/lease，未引入 Phase 2/3。带 canvasId 的媒体上传先后校验控制权，保存平台 upload 资产；多媒体回灌校验画布归属，运行提交冻结转换后的实际图与 inputAssetIds。真实示例画布 73b899eb-e086-4d54-a309-bc36c5b3c56d 经受控 operations 创建 5 节点 / 4 连线，随后正常释放 AI lease；Chrome 验证端点、媒体预览和文本同步，后端测试/构建及前端生产构建通过，详细证据见 COMFYUI-INTEGRATION.md。

- 2026-09-09（输入节点易读性，阶段状态不变）：图片、视频和音频输入节点在媒体预览下展示上传文件的原始文件名，并新增可选备注输入；备注作为节点 data 随 canonical graph、revision 和既有语义化 update_node 流程持久化，文字输入节点行为不变。
