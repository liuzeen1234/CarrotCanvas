# AI 原生画布与人机接力

> 状态：Phase 0A 已实现并通过行为级验收  
> 最后更新：2026-09-05  
> GitHub Issue：[Issue #1](https://github.com/liuzeen1234/CarrotCanvas/issues/1)

本文是 AI 原生画布控制、人机接力、生成历史与自主视频生产的仓库内唯一设计入口。Issue 用于讨论和追踪；本文记录已拍板决策、实施边界、阶段状态和后续 AI 会话必须遵守的约束。

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

建议默认参数：TTL 45 秒，每 15 秒续约。打开画布不自动抢占；人工进入编辑模式或 Agent 开始写任务时显式获取。

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
- 前端 `nodeRuns` 属于页面内存，刷新丢失。
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
- 人工编辑器默认以只读观察者进入，不自动占用空闲画布；无控制者时明确显示“无控制者 · 只读”并提供“取得编辑权”，有人工或 AI 控制者时持续轮询并准确显示其类型与状态，仅此时提供“请求交接”。人工主动取得 lease 后每 15 秒续租；锁定时完整禁用节点编辑、运行、中断、上传、删除、连线和新增，但仍允许查看、下载、选择和 viewport。人工持有者观察到 `handoff_pending` 后停止新编辑，等待串行保存及追写队列完全排空后才释放。列表页重命名/删除使用短租约。
- 编辑器在返回按钮与画布标题之间以独立浮块常驻展示“有未保存更改 / 保存中 / 已保存时间 / 保存失败”状态，并提供立即保存按钮与 `Ctrl/Cmd+S`；保存失败时保留待提交内容并允许手动重试，存在待保存或在途写入时关闭页面会触发浏览器离开提醒。只读会话明确显示“只读”，不以“已保存”误导当前控制状态。
- 控制权状态由底部大提示条改为画布标题后的紧凑浮块，默认不展示 holder ID，也不重复“当前控制者”文案；通过绿/橙/蓝边框和底色区分可编辑、只读与交接中，点击后再展示完整 ID、revision、状态说明和请求交接入口。
- PC 端画布详情页独占 ProLayout 右侧内容区，移除默认内容 padding、画布边框圆角和页面级纵向滚动，画布工作区完整铺满可用宽高；其他路由保持原布局间距。
- viewport 改存浏览器 localStorage，不再写入 canonical graph，也不增加 revision；旧 graph 中 viewport 仅作一次兼容读取。
- 自动化证据：6 个 Jest suite / 43 个用例通过；其中 SQLite 集成测试覆盖单写者、交接与新 epoch、旧 lease 拒绝、TTL/进程实例失效、revision 冲突、幂等重放、batch 单次增版、非法 batch 无部分修改、回执故障事务回滚和人工强制接管原因。
- 真实 HTTP 验收覆盖：健康检查、45 项 Action Registry schema/error 元数据、第二写入者 423、共享资产/Codex2API 无 lease 写入 409、幂等请求重放、旧 revision 409、request-handoff/holder renew/release/new acquire、旧 epoch 409。
- 人工页面双会话验收：AI `phase0a-ui-agent` 持有时页面显示 AI/active/只读，节点运行、删除、提示词、模型及开关均禁用；人工请求交接后 AI 观察 `handoff_pending` 并在 revision 1 释放，页面自动取得 epoch 2 并恢复编辑；人工重命名保存后 revision 2；缩放 viewport 后 revision 仍为 2 且 canonical `graph.viewport` 为 null。验收临时画布已受控清理。
- 真实业务画布复验：在“AI接管协作测试”上，人工 epoch 12 经 `request-handoff` 主动释放，AI `codex-phase0a-acceptance` 取得 epoch 13 并成功执行 revision 77→78 的受控 operation，旧人工 epoch 12 写入返回 `409 STALE_LEASE`，随后人工取得新 lease 并恢复编辑。进一步验证默认只读观察后，空闲状态准确显示“无控制者/取得编辑权”，AI `codex-display-check` 持有 epoch 15 时页面在轮询周期内更新为 AI/active/只读及完整 ID。最终现场交接验证中，人工 epoch 16 → AI epoch 17 → 人工 epoch 18，AI 失联时 TTL 到期恢复路径生效。
- 已知阶段边界：0A 仍使用过渡期 `replace_graph` 和浅层 graph 校验；完整节点语义 operations、领域图校验、Operation Log、Checkpoint 与 inverse undo 属于 0B。Run 持久化、候选历史和运行中接力属于 1A/1B。

### Phase 0B：完整画布机器控制——未开始

- [ ] create/update/move/delete node。
- [ ] connect/disconnect 与后端完整图校验。
- [ ] 人工端 `replace_graph` 过渡及语义命令迁移。
- [ ] Operation Log、Checkpoint、inverse-operation undo。
- [ ] 节点删除与资产生命周期事务化。
- [ ] 无浏览器完成节点编排 E2E。

### Phase 1A：持久化 Run 与生成历史——未开始

这是正式开放 AI 自主/批量生成、运行中接力和选片的硬前置条件，不阻塞 Phase 0A/0B。

- [ ] 持久化 GenerationRun，保留成功、失败、取消和未完成任务。
- [ ] 保存最终输入、能力/工作流版本、操作者、上游资产、产物、错误和时间。
- [ ] ComfyUI 与 Codex2API 统一接入 Persistent RunService。
- [ ] 重跑追加候选，不自动删除旧产物。
- [ ] 候选组、`candidateAssetIds`、`selectedAssetId`、`approvedAssetId`。
- [ ] 已批准产物不能被 AI 静默替换或删除。
- [ ] 按画布、节点、镜头查询生成历史的 API 和 UI。
- [ ] run/get/list/wait/cancel/retry/adopt。
- [ ] 后端重启后核对与恢复未完成 Run。
- [ ] 统一 Asset 导入、lineage 和浏览器上传先落 `assetId`。

### Phase 1B：运行中双向接力——未开始

- [ ] AI 发起 Run 后交给人工继续。
- [ ] 人工发起 Run 后交给 AI 继续。
- [ ] 底层取消能力和限制可被 Agent 发现。
- [ ] E2E 覆盖成功、失败、取消、重启和租约过期。

### Phase 2：Shot Plan、选片与自主生产——未开始

- [ ] Shot Plan 和镜头状态。
- [ ] Brief、分镜规划和验收条件。
- [ ] 候选比较、人工选片和基础质量检查。
- [ ] 角色、场景、风格参考资产。
- [ ] 成本、时长和运行次数预算。
- [ ] 多镜头执行和断点续跑。

Phase 2 必须在 Phase 1A 验收通过后开始。

### Phase 3：成片闭环——未开始

- [ ] 时间轴或等价序列模型。
- [ ] 拼接、裁剪、转场、配音、音乐和字幕。
- [ ] 音画同步与最终检查。
- [ ] 导出预设与成片资产。
- [ ] 受控外部发布。

## 7. 阶段验收合同

阶段状态只有在该阶段的功能清单、行为场景和验收证据全部满足后，才能标记为“已完成”。接口存在、页面可打开或单次手工成功均不能单独作为完成依据。

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

最终必须交付：

1. Action Registry，作为运行时能力事实。
2. OpenAPI/JSON Schema，作为接口契约。
3. `docs/AI-COLLABORATION.md`，面向人工使用者和开发者。
4. `skills/carrot-canvas/SKILL.md`，面向接手平台操作的 AI。
5. 可重复执行的无浏览器 E2E 与 Skill 验证脚本。

`SKILL.md` 只维护稳定的操作策略、协作约束、错误恢复和完成检查；具体 action、参数和 schema 必须动态读取 Action Registry/OpenAPI，不能把 Skill 变成容易过期的接口副本。

Skill 应指导 AI：能力发现、请求交接、lease 生命周期、安全 operations、revision 冲突恢复、Run 接管、候选与批准保护、高影响操作确认、Handoff 写入和主动释放控制权。

Skill 应随各阶段接口逐步更新，不能等全部代码完成后才首次编写；最终由一个没有项目历史上下文的新 AI 做黑盒验收。

## 9. 核心验收门槛

至少满足：

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

完整验收清单以 Issue #1 为准；阶段实现不得用“接口已存在”替代行为级 E2E。

## 10. 后续 AI 会话工作约定

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
