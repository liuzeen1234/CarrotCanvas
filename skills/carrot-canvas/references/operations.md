# 任务脚本与协议

## 客户端

`node <skill>/scripts/canvas.mjs run <canvasId> <task.mjs>` 加载用户任务模块。以下示例仅编辑图，不产生模型费用：

```js
export const options = { summary: '已布置文本输入卡片，下一步连接生成节点。' };
export default async function (s) {
  const nodeId = 'project-brief'; // 在 agent-view 确认不存在，或改用新的唯一 ID
  await s.operations([{
    type: 'create_node',
    node: { id: nodeId, type: 'result', position: { x: 80, y: 100 },
      data: { kind: 'text', inputMode: true, lastText: '项目素材说明' }, style: { width: 300 } },
  }], '添加项目素材说明');
  return { canvasId: s.canvasId, revision: s.revision, nodeId };
}
```

- `s.get('/path')`：JSON 读取，默认超时 15 秒。
- `s.canvas`：初始/最近 operations 返回的图；`await s.refresh()` 重读 agent-view 并更新 revision。
- `s.operations(operations, intent, idempotencyKey?)`：原子批次；自动附 lease/epoch/revision/agent 身份。
- `s.write(method, path, body, options?)`：受生命周期管理的 JSON 或 FormData 写入；自动附 proof 与幂等键，但不会替你推导业务字段或验证授权。body 的 canvasId 必须与 session 一致。调用 Run/asset 路径前核对资源属于此画布。高影响操作在调用前核对用户授权。
- `s.uploadMedia(filename, kind, nodeId?)`：当前项目文件导入此画布，kind 为 image/video/audio；返回 `asset`，含 assetId/url/kind/filename，可存入节点 `lastAssets`。
- `s.waitRun(runId, {timeoutMs, intervalMs}?)`：轮询持久 Run，返回终态（包括失败/needs_attention）；超时抛错，不重新提交。
- `s.signal` / `s.done`：停止信号和释放完成通知。所有异步工作必须 await；不要启动无人收尾的任务。
- `s.close(summary)`：幂等释放；正常退出也会调用。优先写最近 Run 的 Handoff；无 Run 时直接 release。多个 Run 都留在同一画布历史，接手者读取完整列表；当前单个 handoff 接口会立即释放 lease，因此客户端只选最新 Run 作交接锚点。

也可以通过绝对 file URL 导入 `CanvasClient`，使用 `client.withCanvas(id, callback, options)`。`client.request` 是低层接口，只在无 lease 的读写（如已授权的新建画布）或独立验证协议时使用；画布业务写入放进 session。

客户端不隐藏错误、不自动重试业务写入、不自动重取丢失租约。超时后查询服务端再决定下一步。下载目前将单个资产读入内存后保存，较大视频应另用流式下载工具和同一资产 download URL。

## 节点与操作

运行时 `/actions` 和 `/canvas/<id>/agent-view` 是可用能力事实；以下是当前稳定结构，不是全量 schema 副本：

| 操作 | 内容 |
| --- | --- |
| create_node | `node: {id,type,position:{x,y},data,style?}` |
| update_node | `nodeId, dataPatch`（浅合并，嵌套对象需保留已有字段） |
| move_nodes | `positions: [{nodeId,position:{x,y}}]` |
| delete_node | `nodeId` |
| connect | `edge: {id,source,target,sourceHandle,targetHandle}` |
| disconnect | `edgeId` |
| rename_canvas | `name` |
| set_brief | `brief` 对象或 null |

优先语义操作，避免整图 replace_graph。节点位置是共享内容；viewport、选中态仅属于个人展示。

- 所有现有画布节点的 `data` 均可带 `cardName?: string` 与 `note?: string`。`cardName` 是人工可读的卡片标题，`note` 是用途、内容或上下文备注；两者随 canonical graph 持久化，但不替代稳定 `node.id`，也不应覆盖 `workflowName`、提示词或其他运行字段。创建节点时可直接填写；更新既有节点用 `update_node.dataPatch` 浅合并并保留其他 data。

- ComfyUI 节点统一 `type: 'txt2img'`，即使工作流生成视频也不改类型；data 含 `workflowId, workflowName, formValues`。formValues 键为 `${nodeId}::${param}`；nodeId 是 ComfyUI 图内 ID，可能带冒号。显示分类等字段参照选定工作流或已有有效节点。
- Codex2API 节点 `type: 'codex-capability'`；data 含 `capability: text|image|edit|analyze, prompt, model`，可有 `outputMode` 和 `lastAssets/lastText/lastTextParts`。模型从 `/codex2api/models` 发现。edit/analyze 的单个 `image-target` 最多接 16 条边；同一 target 的多条 `connect` 操作必须使用不同 edge ID，并按预期图片顺序写入。其他 target 仍最多一条边。
- AI 配音卡 `type: 'tts'`；data 为 `{provider:'cosyvoice3'|'indextts2'|'qwen3tts', voiceMode:'preset'|'custom'|'design', presetVoiceId?, language?, text, referenceText, instruction, speed, lastAssets?}`。`custom` 的 `audio-target` 是音色参考，`emotion-audio-target` 是 IndexTTS2 可选情绪参考，`text-target` 是可选上游配音文本，输出为 `audio-source`。Qwen3-TTS 支持无需参考音频的 `preset` 与 `design`；预设列表实时读取 `/tts/voices`，文字设计音色必须填写 `instruction`。不得把本地音频路径直接写进节点，自定义参考需先用 `s.uploadMedia` 得到当前画布 audio asset。
- 输入/结果卡 `type: 'result'`；data 含 `kind: text|image|video|audio`，输入模式 `inputMode:true`，文字放 `lastText`，媒体放 `lastAssets:[{assetId,url,kind,filename?}]`；媒体引用用平台资产而非其他项目本地路径。
- 每个正式媒体产物以 `assetId` 唯一标识。节点 `lastAssets`、Run 的 `outputAssetIds`、候选组选择和下载命令必须使用同一个完整 `assetId`；不要用文件名、数组序号或卡片名称代替。向用户交付或请求选择时明确列出 `assetId`，界面会在当前产物、结果、输入资产、节点历史和生成流水附近展示并允许复制。
- 常规 source 为 `text-source`、`image-source`、`video-source`、`audio-source`；正负提示词为 `text-positive-source` / `text-negative-source`。Codex 输入为 `text-target`，edit/analyze 可接 `image-target`。
- 工作流 target 从实时 `inputConfig.fields` 构造：image 为 `input:${nodeId}:${param}`，其余为 `input:${kind}:${nodeId}:${param}`。不要按固定冒号段数拆 ID。媒体类型必须匹配；除上述 Codex edit/analyze `image-target` 外，单个输入最多一条边。不允许有向环路。
- MiniMax H3 高质量图生视频保留原 `img2vid` 工作流身份，并提供四个多入线句柄：`input:image:reference-group:images`（图片 9）、`input:reference-group:videos`（视频 3）、`input:reference-group:videoAudios`（视频配音 3）、`input:reference-group:audios`（独立音频 3）。原工作流的单张 `first_frame` 图片会投影为参考图第 1 项，不再作为独立图片控件或身份存在。旧“全能参考”分类已从画布入口下线，不要创建该分类节点或把它改名后充当图生视频。
- 四组素材分别保存在 `referenceMedia[group]` 与 `referenceMediaOrder[group]`；旧图片字段 `referenceImages`、`referenceImageOrder`、`promptImageReferences` 仅用于兼容已有画布。连接素材的稳定 `referenceId` 为 edge ID，卡片上传素材为 `asset:<assetId>`。图片、视频、独立音频的 token 绑定写入 `promptMediaReferences`，其中包含 `group`；提交时根据各组当前顺序编译为 `<Picture N>`、`<Video N>`、`<Audio N>`。视频配音不生成 token，按顺序与参考视频配对，不能出现第 N 路配音但缺少第 N 个视频。
- 移除或断开素材前，先从提示词删除相应 token，并同步清除 `promptMediaReferences` 绑定；后端会阻止制造活动引用悬空。运行请求保存 `originalPrompt`、兼容字段 `imageReferenceMap`，以及含 `images/videos/videoAudios/audios` 四组的 `referenceMaps`。原 `MiniMaxH3ImageToVideo` API 在提交阶段转换为 `MiniMaxH3ReferenceToVideo`，Agent 不应自行改写持久化工作流或用全能参考工作流替代它。Z-Image Turbo 通用图生图沿用图片句柄，但最多 1 条。

### Codex 多图与稳定引用

Codex edit/analyze 的参考图顺序和提示词引用保存在目标节点 data 中；它们随既有 canonical graph JSON 持久化，不需要单独数据库表或迁移：

```js
{
  referenceImages: [
    { referenceId: 'edge-ref-character', assetId: 'asset-id', url: '/api/assets/asset-id', kind: 'image', displayName: '角色图' },
    { referenceId: 'asset:uploaded-asset-id', assetId: 'uploaded-asset-id', url: '/api/assets/uploaded-asset-id', kind: 'image', displayName: '服装图' },
  ],
  referenceImageOrder: ['edge-ref-character', 'asset:uploaded-asset-id'],
  promptImageReferences: [
    { referenceId: 'edge-ref-character', sourceNodeId: 'character-source', edgeId: 'edge-ref-character', token: '@角色图·a1b2c3', displayName: '角色图' },
  ],
}
```

- 连线图片的稳定 `referenceId` 是 edge ID；直接上传到卡片的图片使用 `asset:<assetId>`。不要用数组下标、文件名、卡片名或“图 N”作为稳定身份。
- `referenceImageOrder` 列出全部 referenceId，决定缩略图、提交文件和 provider 输入的顺序。新增图片追加到末尾；拖动排序只改此数组；移除中间图片后不要重命名其他 referenceId。
- 提示词里的 token 必须唯一，并在 `promptImageReferences` 中绑定相同 referenceId。提交时才按 `referenceImageOrder` 的当前位置把 token 编译为 `第 N 张输入图片（displayName）`。这样移除或重排未引用图片后，引用仍指向原资产。
- 解除引用须在同一 `update_node` 中同时删除 prompt token 和对应 `promptImageReferences` 条目，然后才能 `disconnect` 或删除来源节点。后端会拒绝任何新造成活动引用悬空的 operations/replace_graph；可以在同一原子批次删除引用目标卡及其来源。
- 读取旧画布发现引用的 edge/asset 已不存在时，停止生成并报告缺失 referenceId；修复来源，或同时清除 token、绑定和顺序项后再运行。不要猜测替代图片。

## 运行与媒体

ComfyUI、CosyVoice 3、IndexTTS2、Qwen3-TTS 的平台运行都经过同一持久化 FIFO 本机重型计算租约。开始真实生成前读取 `GET /local-compute-scheduler/status`；`blocked` 非空时停止继续提交并原样报告。Agent 只提交正常的 `/comfyui/runs` 或 `/tts/runs`，不得直调 worker 或自行结束 Provider 进程。

TTS 提交使用 `POST /tts/runs`，在 session 内传 `provider`、`voiceMode`、`text`、canvas/node/proof 和稳定幂等键。只有 `custom` 必须传当前画布的 `referenceAssetId`；CosyVoice 3 还必须传准确逐字稿 `referenceText`，IndexTTS2 可传情绪参考资产或 `instruction`。Qwen3-TTS 的 `preset` 传 `/tts/voices` 返回的 `presetVoiceId`，`design` 传音色与表演描述 `instruction`；两者均可传 `language` 且无需参考资产。当前不提供 Qwen 参考音频克隆。

精确停顿只接受 `<pause ms="N"/>`，整数范围 100–10000ms；连续标签累计且总计不得超过 10000ms，首尾标签允许，纯停顿拒绝。平台不会把标签发送给模型，而是在同一外层本机重型计算租约内严格串行生成 speech 段、按最终 WAV 采样率插入 PCM 静音并无损拼接。成功只产生一个正式 audio asset；`inputSnapshot.segments/execution.concat` 是计划、格式和实际静音帧的审计事实。取消前读 `capabilities.cancel`；TTS 的 `safe-segment-boundary` 表示当前 speech 片段结束后停止，不会发布已生成的中间片段。

画布连线和 formValues 是创作状态；提交后端 Run 时仍需准备实际入参，后端不会自动执行整张画布 DAG。

ComfyUI：读选定 `/workflows/<workflowId>` 的 `apiJson`、`inputConfig`。`/comfyui/workflows/<workflowId>/schema` 只查询节点定义（可命中服务端有效缓存），不会启动或切换 Provider；离线且没有有效缓存时会失败。对已确认有效的模板、明确字段和值，可直接提交正常 Run，让后端取得计算租约后完成动态 schema 校验；缺少必要参数证据时报告具体缺失，不猜字段或模型，也不要求打开 Desktop 来读取 schema。复制 apiJson，在 `apiJson[comfyNodeId].inputs[param]` 写实际值；调用方仍需解析上游文字与媒体输入。提交一次：

```js
const result = await s.write('POST', '/comfyui/runs', {
  canvasId: s.canvasId, nodeId, workflowId, apiJson,
  inputAssetIds, idempotencyKey: stableKey,
}, { timeoutMs: 180000, providerRun: true });
const runId = result.persistentRun?.id || result.run?.runId;
const run = await s.waitRun(runId);
if (run.status !== 'succeeded') throw new Error(`Run ${runId}: ${run.status}`);
```

服务端顺序为：离线基础校验 → 持久 Run → FIFO 计算租约 → 调度器切换/启动 ComfyUI 并等待健康检查 → `/object_info` 与动态参数准备 → 保存最终 `inputSnapshot` → `/prompt`。`requestSnapshot` 用于原始请求幂等比较，不能用准备后的 `inputSnapshot` 替换新 Run 重放的原始请求。提交前失败会记录 failed Run 并释放计算租约；生成已提交后，租约持续到完成回调。健康 ComfyUI 可在同 Provider 任务之间驻留，切换 Provider 时退出，不要求每次任务完成都立即关闭。

示例超时涵盖常规冷启动，FIFO 排队仍可能超过此时间。请求超时后先按画布历史和幂等键核对已有 Run，不能换键重复提交；等待期间保持 session 生命周期。`COMFYUI_LAUNCH_NOT_CONFIGURED` 表示缺少托管启动配置，路径失效则按实际启动错误报告，不自动修改全局配置或要求“先开 Desktop 再接管”。只有实际 `COMFYUI_TAKEOVER_REQUIRED` 才按实时 Registry 请求一次性确认令牌、展示当前外部进程快照，并在用户明确授权该次接管后执行；没有外部进程时无需接管确认。不要自行结束外部进程，也不要以空任务或无关生成来预热服务。

`providerRun:true` 仅用于真实 provider 提交：接到交接时不用等同步生成 HTTP 返回才释放。图修改绝不能使用此选项。生成完成后先检查 `s.state === 'active'` 再决定下游写入；交接后保留结果在服务器，禁止自行重新 acquire。

Codex2API：使用 `/codex2api/chat/completions`（`stream:false, model, messages`）、`/codex2api/images/generations`（model/prompt 等实时服务支持参数）。同样传 canvasId/nodeId/inputAssetIds/幂等键，用 `s.write(...,{timeoutMs:660000,providerRun:true})`；返回 `runId`，之后读取持久 Run。图片编辑为 multipart `image` 文件数组，不能把本地路径塞进 JSON；按 `referenceImageOrder` 依次 append 最多 16 个 `image` Blob，并 set canvasId/nodeId/model、编译后的 `prompt`、原始 token 提示词 `originalPrompt`、JSON 字符串 `imageReferenceMap`（每项含 referenceId、position、displayName、token）和同序 `inputAssetIds`，再经同一 `s.write` 提交 `/codex2api/images/edits`。图像理解同样按此顺序构造消息图片并保存映射；内部映射字段用于 Run 审计，不转发 provider。

运行成功不保证 canonical graph 中 lastAssets 已更新：按真实 `/runs/<id>` 的 `outputAssetIds`、`outputText`、`outputParts` 生成 `update_node`，媒体类型优先取提交结果的产物信息，或请求 `/assets/<id>` 检查 Content-Type（这是二进制流，不是元数据 JSON）；URL 为 `/api/assets/<assetId>`。更新 `lastAssets` 或 `lastText/lastTextParts` 前读当前节点，保留无关配置。若已交接，由新持有者完成图同步。

媒体导入：`s.uploadMedia` 在画布上下文中只保存平台资产，不依赖 ComfyUI 在线。`s.write('POST','/comfyui/upload/asset',{canvasId:s.canvasId,assetId})` 是在线回灌接口，不申请生成租约、不启动或切换 Provider；离线时会失败。须校验画布归属，依据返回 file.name/subfolder 和已确认的字段类型填入 API JSON；不复用其他画布的 assetId。`inputAssetIds` 只记录血缘，不会在 Run 中自动上传文件。如果本次生成必须回灌新素材且 ComfyUI 离线，保留平台资产并明确报告“当前 Run 接口尚未支持租约内自动回灌”，不能宣称冷启动生成已具备这一能力，也不能让用户手动打开 Desktop 来掩盖缺口。视频归一化和大小限制以当前接口为准。

接手前 `GET /runs?canvasId=<id>` 读全部分页与交接记录，已有待接手 Run 使用 `s.write('POST','/runs/<id>/adopt',{})`。它保留平台/provider Run ID，不触发新生成。`run.retry` 可能仅创建重试记录，不等于已重新提交 provider，先看实际响应。

候选选择通过实时 Registry 的 choose/choose_text 接口，在 session 内传 canvasId/nodeId 与候选 ID；AI 不能设置 `approve:true` 或伪造 human。已批准资产保护不能通过清空图或删除节点绕过。
