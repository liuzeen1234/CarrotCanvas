---
name: carrot-canvas
description: 从任意项目通过 CarrotCanvas API 创建和编辑画布、编排生成节点、运行已有工作流、读取生成历史并下载素材，支持 AI 与人工交接。用户提到 CarrotCanvas、萝卜画布或明确要用该画布生产素材时使用；普通网页 canvas 或直接操作 ComfyUI Desktop 不触发。
---

# CarrotCanvas 跨项目控制

用机器接口操作同一份持久化画布。默认服务 `http://localhost:3100/api`，可用环境变量 `CARROT_CANVAS_URL` 覆盖为包含 `/api` 的地址。服务须从当前任务环境可达；云端的 localhost 不指向用户电脑。Skill 本身不会启动服务或扩大网络/文件权限。

本目录的 `scripts/canvas.mjs` 是无第三方依赖的 Node 22+ 客户端。以此 SKILL.md 的实际目录定位脚本，调用时用绝对路径；当前工作目录可以是用户的任何项目，不需要切到画布仓库。无 Node 时先使用环境提供的运行时。

## 发现与目标

1. `node <绝对脚本路径> get /health` 检查服务，再 `get /actions` 获取实时 action 的 method/path/schema、可用性、影响与权限。可过滤输出，但实际调用前读对应条目。
2. `get /canvas` 列出画布。明确指定的画布按 ID 或唯一名称匹配；不同项目优先用独立命名画布，不随意接管最近打开的一张。需要新画布时 `create "项目名 · 用途"`，记录返回 ID。
3. `get /canvas/<id>/agent-view` 读取最新图、revision、控制状态。复用工作流前读 `/workflows`、`/workflows/<id>` 和对应实时 schema；不要凭记忆猜工作流 ID、模型名、参数或动态端口。

部分 Action Registry 的 body/output schema 仍较宽泛，不能据此宣称任意参数有效。节点及运行的已验证协议见 [references/operations.md](references/operations.md)。遇到未覆盖字段先查实际接口或已有有效数据；本机仓库默认位于 `D:/dev/CarrotCanvas`，必要时只读 Controller/类型定义，不要求每次加载仓库历史。

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

运行提交必须带 canvasId/nodeId、当前 proof 与稳定幂等键，通过平台记录 Run，不能绕过平台直调 provider 冒充画布生成。采用 [运行与媒体约定](references/operations.md#运行与媒体)；生成等待也保持生命周期，不能靠 TTL 正常释放。接手时检查已有 Run 的 Handoff，必要时 adopt 原 Run，禁止以重新提交代替接手。取消前读取 `capabilities.cancel`，当前 provider 不保证精确取消。

先核对 Run 终态、真实产物、画布引用与文件内容，再声明完成。下载使用 `download <assetId> <当前项目内绝对路径>`（拒绝覆盖已有文件），不要硬编码后端 data 目录。报告画布 ID/链接、Run ID、可用产物路径及未完成项；失败/needs_attention/超时不等于成功。

当前 Skill 封装现有画布和生成能力，不承诺自动分镜、时间轴剪辑或最终成片系统已实现。
