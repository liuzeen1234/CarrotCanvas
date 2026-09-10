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
- Codex2API 节点 `type: 'codex-capability'`；data 含 `capability: text|image|edit|analyze, prompt, model`，可有 `outputMode` 和 `lastAssets/lastText/lastTextParts`。模型从 `/codex2api/models` 发现。
- AI 配音卡 `type: 'tts'`；data 为 `{provider:'cosyvoice3'|'indextts2'|'qwen3tts', voiceMode:'preset'|'custom'|'design', presetVoiceId?, language?, text, referenceText, instruction, speed, lastAssets?}`。`custom` 的 `audio-target` 是音色参考，`emotion-audio-target` 是 IndexTTS2 可选情绪参考，`text-target` 是可选上游配音文本，输出为 `audio-source`。Qwen3-TTS 支持无需参考音频的 `preset` 与 `design`；预设列表实时读取 `/tts/voices`，文字设计音色必须填写 `instruction`。不得把本地音频路径直接写进节点，自定义参考需先用 `s.uploadMedia` 得到当前画布 audio asset。
- 输入/结果卡 `type: 'result'`；data 含 `kind: text|image|video|audio`，输入模式 `inputMode:true`，文字放 `lastText`，媒体放 `lastAssets:[{assetId,url,kind,filename?}]`；媒体引用用平台资产而非其他项目本地路径。
- 每个正式媒体产物以 `assetId` 唯一标识。节点 `lastAssets`、Run 的 `outputAssetIds`、候选组选择和下载命令必须使用同一个完整 `assetId`；不要用文件名、数组序号或卡片名称代替。向用户交付或请求选择时明确列出 `assetId`，界面会在当前产物、结果、输入资产、节点历史和生成流水附近展示并允许复制。
- 常规 source 为 `text-source`、`image-source`、`video-source`、`audio-source`；正负提示词为 `text-positive-source` / `text-negative-source`。Codex 输入为 `text-target`，edit/analyze 可接 `image-target`。
- 工作流 target 从实时 `inputConfig.fields` 构造：image 为 `input:${nodeId}:${param}`，其余为 `input:${kind}:${nodeId}:${param}`。不要按固定冒号段数拆 ID。媒体类型必须匹配，单个输入最多一条边，不允许有向环路。

## 运行与媒体

ComfyUI、CosyVoice 3、IndexTTS2、Qwen3-TTS 的平台运行都经过同一持久化 FIFO 本机重型计算租约。开始真实生成前读取 `GET /local-compute-scheduler/status`；`blocked` 非空时停止继续提交并原样报告。Agent 只提交正常的 `/comfyui/runs` 或 `/tts/runs`，不得直调 worker 或自行结束 Provider 进程。

TTS 提交使用 `POST /tts/runs`，在 session 内传 `provider`、`voiceMode`、`text`、canvas/node/proof 和稳定幂等键。只有 `custom` 必须传当前画布的 `referenceAssetId`；CosyVoice 3 还必须传准确逐字稿 `referenceText`，IndexTTS2 可传情绪参考资产或 `instruction`。Qwen3-TTS 的 `preset` 传 `/tts/voices` 返回的 `presetVoiceId`，`design` 传音色与表演描述 `instruction`；两者均可传 `language` 且无需参考资产。当前不提供 Qwen 参考音频克隆。

精确停顿只接受 `<pause ms="N"/>`，整数范围 100–10000ms；连续标签累计且总计不得超过 10000ms，首尾标签允许，纯停顿拒绝。平台不会把标签发送给模型，而是在同一外层本机重型计算租约内严格串行生成 speech 段、按最终 WAV 采样率插入 PCM 静音并无损拼接。成功只产生一个正式 audio asset；`inputSnapshot.segments/execution.concat` 是计划、格式和实际静音帧的审计事实。取消前读 `capabilities.cancel`；TTS 的 `safe-segment-boundary` 表示当前 speech 片段结束后停止，不会发布已生成的中间片段。

画布连线和 formValues 是创作状态；提交后端 Run 时仍需准备实际入参，后端不会自动执行整张画布 DAG。

ComfyUI：读选定 `/workflows/<workflowId>` 的 `apiJson`、`inputConfig`，并读 `/comfyui/workflows/<workflowId>/schema`。复制 apiJson，在 `apiJson[comfyNodeId].inputs[param]` 写实际值；解析上游文字/资产并匹配 schema 类型。提交一次：

```js
const result = await s.write('POST', '/comfyui/runs', {
  canvasId: s.canvasId, nodeId, workflowId, apiJson,
  inputAssetIds, idempotencyKey: stableKey,
}, { timeoutMs: 60000, providerRun: true });
const runId = result.persistentRun?.id || result.run?.runId;
const run = await s.waitRun(runId);
if (run.status !== 'succeeded') throw new Error(`Run ${runId}: ${run.status}`);
```

`providerRun:true` 仅用于真实 provider 提交：接到交接时不用等同步生成 HTTP 返回才释放。图修改绝不能使用此选项。生成完成后先检查 `s.state === 'active'` 再决定下游写入；交接后保留结果在服务器，禁止自行重新 acquire。

Codex2API：使用 `/codex2api/chat/completions`（`stream:false, model, messages`）、`/codex2api/images/generations`（model/prompt 等实时服务支持参数）。同样传 canvasId/nodeId/inputAssetIds/幂等键，用 `s.write(...,{timeoutMs:660000,providerRun:true})`；返回 `runId`，之后读取持久 Run。图片编辑为 multipart `image` 文件数组，不能把本地路径塞进 JSON；构造 FormData，append 多个 `image` Blob，set canvasId/nodeId/model/prompt 和 JSON 字符串 inputAssetIds，再经同一 `s.write` 提交 `/codex2api/images/edits`。

运行成功不保证 canonical graph 中 lastAssets 已更新：按真实 `/runs/<id>` 的 `outputAssetIds`、`outputText`、`outputParts` 生成 `update_node`，媒体类型优先取提交结果的产物信息，或请求 `/assets/<id>` 检查 Content-Type（这是二进制流，不是元数据 JSON）；URL 为 `/api/assets/<assetId>`。更新 `lastAssets` 或 `lastText/lastTextParts` 前读当前节点，保留无关配置。若已交接，由新持有者完成图同步。

媒体导入：用 `s.uploadMedia` 导入平台资产；已有平台资产用 `s.write('POST','/comfyui/upload/asset',{canvasId:s.canvasId,assetId})` 回灌 provider 输入。须校验画布归属，依据返回 file.name/subfolder 和字段 schema 填入 API JSON；不复用其他画布的 assetId。视频归一化和大小限制以当前接口为准。

接手前 `GET /runs?canvasId=<id>` 读全部分页与交接记录，已有待接手 Run 使用 `s.write('POST','/runs/<id>/adopt',{})`。它保留平台/provider Run ID，不触发新生成。`run.retry` 可能仅创建重试记录，不等于已重新提交 provider，先看实际响应。

候选选择通过实时 Registry 的 choose/choose_text 接口，在 session 内传 canvasId/nodeId 与候选 ID；AI 不能设置 `approve:true` 或伪造 human。已批准资产保护不能通过清空图或删除节点绕过。
