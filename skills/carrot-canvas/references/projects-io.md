# 项目与画布输入输出

项目只是多对多画布集合，没有输入区，不是控制权或引用边界。加入/移出项目不修改画布 lease/revision。项目成果是关联画布输出的独立文件快照，只供浏览下载，不能作为输入。包含画布的项目不能删除。

GET `/projects`、GET `/projects/:id` 返回集合与成果历史。创建用 POST `/projects` `{name,description}`。修改用 POST `/projects/:id/command` `{expectedRevision,idempotencyKey,command,payload}`，命令为 edit、canvas.add/remove（payload.canvasId）、canvas.create（payload.name）、results.capture/restore。项目操作不需要画布 Session，使用 client.request；相同幂等键必须重放相同原请求，冲突先刷新并重新计算。删除仍遵守明确授权合同，需要项目 expectedRevision。

GET `/canvas/:id/io` 返回 inputs、outputs 和 removedInputs 保留历史；agent-view 返回 canvas.io、projects 查询标签、IO URLs 及 ioSummary（当前输入项、输出身份/版本、工作区旧副本状态）。removedInputs 不是可选输入列表。旧画布无 IO 按空状态处理。输出只有用户明确发布的内容，生成或候选切换不会自动更新它。

画布 IO 写入必须处于现有 Session 生命周期，优先使用 `session.io(command,payload,idempotencyKey?)`，也可使用 `session.write('POST', '/canvas/<id>/io/command', {command,payload,idempotencyKey})`，不要直接写 CanvasDoc.io 或伪造绑定节点。session 自动补 proof，返回 resultRevision 自动更新会话 revision。

- `input.capture`：`{sourceCanvasId,sourceOutputsVersion?}`。任意其他画布当前输出整组独立复制；不允许自身或项目来源。
- `input.update`：先 GET `/canvas/<id>/io/inputs/<groupId>/update-preview`；确认差异后 `{groupId,sourceOutputsVersion}`。来源版本变化拒绝提交，需要重新预览；无变化 no-op。
- `input.restore`：`{groupId,snapshotId}`；`input.edit`：`{groupId,name,note}`；`input.remove`：`{groupId}`，无需先删工作区节点；输入组归档，工作区本地副本、连线和历史保留，节点标记 group_removed，不再检查来源更新。
- `input.bind`：`{groupId,itemKey,position:{x,y}}`，创建本画布快照适配节点，返回画布中的新增 nodeId，再用正常 connect 连接 `${kind}-source` 到合法目标 typed handle。默认卡片宽300，position 不自动避让（Web UI 的避让是客户端行为）；AI 根据 agent-view 位置与尺寸选空位，可选现有节点最大右边界 +24px 的空白列，防止竖图或长文本撑高后重叠。同身份同类型更新保留连线；删除或类型变化允许更新，使用中的节点保留旧快照并标记；Run 记录节点实际版本。
- `output.publish`：`{assetId,name?,note?}`、`{nodeId,assetId?}`、`{nodeId,textPart:'positive'|'negative'}`、`{runId,assetId?,textPart?}` 或 `{text,name?,note?}`。只接受本画布已有文件或真实节点/成功 Run 的文字，文字也保存 Asset。优先提供 nodeId 或 runId 以保留卡片身份，并使用卡片语义名称。生成、切换候选仅改变工作区，不改变已发布输出；明确再次发布同一卡片同类型/文字端口会替换对应输出，itemKey 保持稳定（撤下重发也保留），assetId 随内容变化。combined/positive/negative 是三个独立文字输出端口，combined 用不带 textPart 的请求。
- 批量发布：`output.publish` 的 `{items:[上述单项payload,...]}`，1–100项，一个事务、一个输出版本和一次 revision；同一卡片同端口只能选择一个产物，且当前输出中同 assetId 只能出现一次（OUTPUT_SLOT_CONFLICT / OUTPUT_ASSET_ALREADY_PUBLISHED）；任一项失败则整批回滚，原请求原幂等键重放不会重复发布。
- `output.replace`：同发布字段再加 `itemKey`；`output.edit`：`{itemKey,name,note}`；`output.remove`：`{itemKey}`；`output.reorder`：`{order:[全部itemKey恰好一次]}`。均产生新完整输出版本，旧版保留。

本地文件：优先 `await session.importInputs([文件绝对路径,...], {name?,idempotencyKey?})`；导入的是输入面板资源，不等同于 uploadMedia 的普通上传资产。也可用 FormData 多个 files（File/Blob 带原始文件名），使用 `session.write('POST','/canvas/<id>/io/files',form,{timeoutMs:120000})`；客户端自动补 multipart proof。最多30文件、单文件256MB，UTF-8 txt/md/json≤5MB；媒体按文件签名校验。不启动 Provider，不用 ComfyUI 上传入口。Session 内正常续租，不阻塞事件循环。

`results.capture` 的 payload：`{name,note,selections:[{canvasId,itemKey,outputsVersion,name?,note?}]}`；仅当前关联画布，最多100项，每项独立复制到项目。`results.restore`：`{snapshotId}`，设置活动成果但不删除历史。

快照不会自动同步或重跑。明确更新才切换当前输入，旧 Run 保存 inputLineage 和提交时输入，不受影响。来源画布被删除后副本仍可用，只失去继续更新的能力。项目关联变更不影响快照或后续更新能力。下载仍走 `/assets/:assetId/download`。Checkpoint/undo 覆盖 IO，恢复输出形成单调递增的新版本。不要把项目成果的 assetId 塞进画布运行参数绕过不可引用规则。


工作区身份是 inputGroupId + inputItemKey + 实际 inputSnapshotId。检查输入更新后，同身份同类型绑定随明确更新切到新版；来源撤下或类型变化时旧节点继续使用旧快照，分别标记 removed / kind_changed。不要为了对齐输入列表删除旧节点、断线或更改提示词绑定；Run inputLineage 记录实际使用的旧版本。来源同一 assetId 撤下重发仅修正标题时，后端按 sourceAssetId + 类型兼容接续绑定。不要直接篡改 inputMode 节点 lastAssets/lastText、快照字段或 CanvasDoc.io。

## 多画布接力示例

先读取来源 agent-view 的 ioSummary.outputsVersion，使用目标画布 Session：

```js
export default async function (s) {
  const sourceId = '来源画布ID';
  const source = await s.get(`/canvas/${sourceId}/agent-view`);
  await s.io('input.capture', { sourceCanvasId: sourceId, sourceOutputsVersion: source.ioSummary.outputsVersion });
  const group = s.canvas.io.inputs.at(-1);
  const active = group.snapshots.find(v => v.id === group.activeSnapshotId);
  const item = active.items[0];
  const previous = new Set(s.canvas.graph.nodes.map(n => n.id));
  const right = Math.max(56, ...s.canvas.graph.nodes.map(n => n.position.x + (Number(n.style?.width) || 300)));
  await s.io('input.bind', { groupId: group.id, itemKey: item.itemKey, position: { x: right + 24, y: 80 } });
  const inputNode = s.canvas.graph.nodes.find(n => !previous.has(n.id));
  // 下一步用 inputNode.id 连接合法 typed handles，再经平台生成。
  return { groupId: group.id, nodeId: inputNode.id, localAssetId: item.assetId };
}
```

上游完成生成后需在上游 Session 内 `s.io('output.publish',{nodeId,assetId,name})` 明确发布，下游才能引入。更新下游必须先预览再决定，不因发现新版本就自动更新。项目最终交付通过 results.capture 另存项目快照，不能把它作为新画布来源。

维护验收：`node <Skill目录>/scripts/verify-io.mjs` 创建独立验收画布/项目，验证 IO 接力与客户端方法，不调用 Provider，完成后清理本次对象。不要用用户画布做验收。
