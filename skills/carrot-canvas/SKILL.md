---
name: carrot-canvas
description: 从任意项目通过 CarrotCanvas API 创建和编辑画布、编排生成节点、运行已有工作流、读取生成历史并下载素材，支持 AI 与人工交接。用户提到 CarrotCanvas、萝卜画布或明确要用该画布生产素材时使用；普通网页 canvas 或直接操作 ComfyUI Desktop 不触发。
---

# CarrotCanvas 跨项目控制

用机器接口操作同一份持久化画布。默认服务 `http://localhost:3100/api`，可用环境变量 `CARROT_CANVAS_URL` 覆盖为包含 `/api` 的地址。服务须从当前任务环境可达；云端的 localhost 不指向用户电脑。仅在当前环境是用户本机、CarrotCanvas 仓库可用且权限允许时，才可按下述流程启动本地服务；这不扩大网络、文件或进程权限。

本目录的 `scripts/canvas.mjs` 是无第三方依赖的 Node 22+ 客户端。以此 SKILL.md 的实际目录定位脚本，调用时用绝对路径；当前工作目录可以是用户的任何项目，不需要切到画布仓库。无 Node 时先使用环境提供的运行时。

## 发现与目标

1. `node <绝对脚本路径> get /health` 检查服务，再 `get /actions` 获取实时 action 的 method/path/schema、可用性、影响与权限。可过滤输出，但实际调用前读对应条目。
2. `get /canvas` 列出画布。明确指定的画布按 ID 或唯一名称匹配；不同项目优先用独立命名画布，不随意接管最近打开的一张。需要新画布时 `create "项目名 · 用途"`，记录返回 ID。
3. `get /canvas/<id>/agent-view` 读取最新图、revision、控制状态。复用工作流前读 `/workflows`、`/workflows/<id>`；动态参数按对应 schema 核对。ComfyUI 离线时 schema 查询可能不可用，按 [运行与媒体](references/operations.md#运行与媒体) 判断能否直接提交已确认的工作流输入，不把在线 schema 查询作为所有生成的硬性前置。不要凭记忆猜工作流 ID、模型名、参数或动态端口。

部分 Action Registry 的 body/output schema 仍较宽泛，不能据此宣称任意参数有效。节点及运行的已验证协议见 [references/operations.md](references/operations.md)。遇到未覆盖字段先查实际接口或已有有效数据；本机仓库默认位于 `D:/dev/CarrotCanvas`，必要时只读 Controller/类型定义，不要求每次加载仓库历史。

## 本地服务检测与启动

先运行 `node <绝对脚本路径> get /health` 检测后端；需要打开画布界面时，再请求 `http://localhost:8000` 检测前端。以 HTTP 响应为准，不只看进程或端口：后端应返回成功状态以及 `status: ok`，前端应返回 2xx。

检测失败时先判断运行环境。只有当前任务运行在用户本机、`D:/dev/CarrotCanvas`（或已明确定位的仓库）存在，并且启动本地进程属于当前请求所需操作时，才在仓库根目录执行：

```text
pnpm --filter @carrot-canvas/backend build
pnpm --filter @carrot-canvas/backend start
pnpm --filter @carrot-canvas/web dev
```

后端和前端应作为独立后台进程启动，输出分别重定向到仓库内 `backend/data/backend.stdout.log`、`backend/data/backend.stderr.log`、`web/dev.stdout.log`、`web/dev.stderr.log`。不要用 `tsx` 启动后端；它会缺失 NestJS 装饰器元数据。启动前检查 3100 和 8000 的现有监听，避免重复启动；如果端口已被占用但健康检查失败，先识别所属进程，不擅自终止非 CarrotCanvas 进程。

启动后短暂等待并重新检查 `/health` 与前端 HTTP 状态。失败时读取上述日志的末尾并报告具体错误；不要仅因启动命令已返回就宣称服务可用。若处于云端/远程环境、仓库不存在、依赖未安装、权限不足，或 `CARROT_CANVAS_URL` 指向外部服务，则停止自动启动并说明需要用户在服务所在机器处理。

## 写入与交接

短操作：准备 UTF-8 JSON 文件 `{ "intent": "目的", "idempotencyKey": "本批唯一且可追踪的键", "operations": [...] }`，执行：

```text
node <绝对脚本路径> operations <canvasId> <JSON文件绝对路径>
```

多步操作、生成或等待：在当前项目写一个任务 `.mjs`，默认导出 `async function(session)`，执行 `run <canvasId> <任务文件绝对路径>`。示例与方法见引用文档。所有写入和等待留在同一进程生命周期；每次启动 run 都是一次新租约。逐条工具调用间不要裸 acquire 后遗留 token，也不要另外启动只保活的后台脚本。

客户端自动正常申请交接/等待（最多 60 秒）、获取 lease、每 10 秒检查续租完整响应、串行写入、跟踪成功 revision、收尾主动释放。收到交接会关闭新写入，排空在途图修改，通过最近 Run 保存交接摘要并释放；已有 provider 生成继续落库。没有 Run 时保留图和操作日志，任务完成说明中交代下一步。任务可以通过 `session.signal`、`session.done` 感知交接，不要捕获 `SESSION_STOPPED` 后循环重试，也不要阻塞 Node 事件循环。

保持 `actorType=agent`，不冒充人工、不使用 force-takeover。租约丢失或状态不明停止写入；冲突时重新读取 graph/control/log，判断已发生的变化，重算操作后才能继续。不把旧操作换一个 revision 直接重放。网络超时可能已经提交，先查 Run/操作日志；原请求重放必须保留完整输入、原 expectedRevision 和幂等键，当前通用脚本不自动重试写入。

## 生成与交付

按用户目标和已授权预算运行；普通素材请求不意味着修改全局服务、密钥、工作流或大批量生成。明确删除画布、覆盖恢复、替换已批准产物、批量清理和外部发布的授权；已有明确授权不用重复询问。Registry 的权限标记可能不完整，候选 approve 也不能冒充 human。

创建或更新画布卡片时，按用户给出的语义填写可选 `data.cardName` 和 `data.note`，让人工能在卡片标题和正文中识别用途；不要把它们误当成节点 ID、工作流名或模型入参。引用、交付或请人工选择媒体产物时优先报告平台 `assetId`，必要时同时给 Run ID；具体字段合同见节点与操作约定。

Codex2API 图片编辑与图像理解的 `image-target` 可按明确顺序接入最多 16 张参考图。多图提示词必须把 `@` token 绑定到稳定的 edge/asset `referenceId`，不能把“图 1/图 2”序号当作身份；增删或重排图片后，在提交时按当前顺序重新编译提示词。仍被提示词引用的图片必须先解除 token 与绑定再断线或删除，详细数据结构、原子操作顺序和 Run 快照字段见节点与操作约定。

ComfyUI 的 MiniMax H3 全能参考卡使用统一 `input:image:reference-group:images` 入口，最多 9 张图片，稳定 `@` 引用在提交时编译为 `<Picture N>`；Z-Image Turbo 通用图生图使用同一入口但最多 1 张。Agent 必须读取实时 workflow API JSON/inputConfig 确认能力，不能因为统一 UI 而假定所有 ComfyUI 工作流都支持多图。

运行提交必须带 canvasId/nodeId、当前 proof 与稳定幂等键，通过平台记录 Run，不能绕过平台直调 provider 冒充画布生成。采用 [运行与媒体约定](references/operations.md#运行与媒体)；生成等待也保持生命周期，不能靠 TTL 正常释放。接手时检查已有 Run 的 Handoff，必要时 adopt 原 Run，禁止以重新提交代替接手。取消前读取 `capabilities.cancel`；TTS 支持 speech 片段边界取消，其他 provider 以实时能力为准。

ComfyUI、CosyVoice 3、IndexTTS2、Qwen3-TTS 共用一张 FIFO 本机重型计算租约。提交这些 Provider 前读取 `/local-compute-scheduler/status`；`blocked` 非空时停止提交并报告结构化原因。Qwen3-TTS 的预设 speaker 与文字设计音色均无需参考音频，具体节点和提交合同见运行与媒体约定。

ComfyUI 未运行本身不是生成阻塞：已有有效托管启动配置时，正常提交 `/comfyui/runs` 会由调度器按需启动后台、等待健康检查，再准备动态参数并提交。不要要求用户先手动启动 ComfyUI Desktop，也不要绕过调度器启动 8188。只有实际检测到外部进程、返回 `COMFYUI_TAKEOVER_REQUIRED` 时才处理接管确认；schema 查询与资产回灌不触发启动，离线边界见运行与媒体约定。

先核对 Run 终态、真实产物、画布引用与文件内容，再声明完成。下载使用 `download <assetId> <当前项目内绝对路径>`（拒绝覆盖已有文件），不要硬编码后端 data 目录。报告画布 ID/链接、Run ID、可用产物路径及未完成项；失败/needs_attention/超时不等于成功。

当前 Skill 封装现有画布和生成能力，不承诺自动分镜、时间轴剪辑或最终成片系统已实现。
