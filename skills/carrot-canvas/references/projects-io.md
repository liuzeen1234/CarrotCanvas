# 项目与画布输入输出

项目只是多对多画布集合，没有输入区，不是控制权或引用边界。加入/移出项目不修改画布 lease/revision。项目成果是关联画布输出的独立文件快照，只供浏览下载，不能作为输入。包含画布的项目不能删除。

GET `/projects`、GET `/projects/:id` 返回集合与成果历史。创建用 POST `/projects` `{name,description}`。修改用 POST `/projects/:id/command` `{expectedRevision,idempotencyKey,command,payload}`，命令为 edit、canvas.add/remove（payload.canvasId）、canvas.create（payload.name）、results.capture/restore。项目操作不需要画布 Session，使用 client.request；相同幂等键必须重放相同原请求，冲突先刷新并重新计算。删除仍遵守明确授权合同，需要项目 expectedRevision。

GET `/canvas/:id/io` 返回 inputs 和 outputs 全部历史；agent-view 返回 canvas.io、projects 查询标签和 IO URLs。旧画布无 IO 按空状态处理。输出只有用户明确发布的内容，生成或候选切换不会自动更新它。

画布 IO 写入必须处于现有 Session 生命周期，使用 `session.write('POST', '/canvas/<id>/io/command', {command,payload,idempotencyKey})`，不要直接写 CanvasDoc.io 或伪造绑定节点。session 自动补 proof，返回 resultRevision 自动更新会话 revision。

- `input.capture`：`{sourceCanvasId,sourceOutputsVersion?}`。任意其他画布当前输出整组独立复制；不允许自身或项目来源。
- `input.update`：先 GET `/canvas/<id>/io/inputs/<groupId>/update-preview`；确认差异后 `{groupId,sourceOutputsVersion}`。来源版本变化拒绝提交，需要重新预览；无变化 no-op。
- `input.restore`：`{groupId,snapshotId}`；`input.edit`：`{groupId,name,note}`；`input.remove`：`{groupId}`。
- `input.bind`：`{groupId,itemKey,position:{x,y}}`，创建本画布快照适配节点，再用正常 connect 连接 typed handles。同身份同类型更新保留连线；删除或类型变化允许更新，使用中的节点保留旧快照并标记；Run 记录节点实际版本。
- `output.publish`：`{assetId,name?,note?}`、`{nodeId,assetId?}`、`{nodeId,textPart:'positive'|'negative'}`、`{runId,assetId?,textPart?}` 或 `{text,name?,note?}`。只接受本画布已有文件或真实节点/成功 Run 的文字，文字也保存 Asset。
- 批量发布：`output.publish` 的 `{items:[上述单项payload,...]}`，1–100项，一个事务、一个输出版本和一次 revision；任一项失败则整批回滚，原请求原幂等键重放不会重复发布。
- `output.replace`：同发布字段再加 `itemKey`；`output.edit`：`{itemKey,name,note}`；`output.remove`：`{itemKey}`；`output.reorder`：`{order:[全部itemKey恰好一次]}`。均产生新完整输出版本，旧版保留。

本地文件：FormData 多个 files（File/Blob 带原始文件名），使用 `session.write('POST','/canvas/<id>/io/files',form,{timeoutMs:120000})`；客户端自动补 multipart proof。最多30文件、单文件256MB，UTF-8 txt/md/json≤5MB；媒体按文件签名校验。不启动 Provider，不用 ComfyUI 上传入口。Session 内正常续租，不阻塞事件循环。

`results.capture` 的 payload：`{name,note,selections:[{canvasId,itemKey,outputsVersion,name?,note?}]}`；仅当前关联画布，最多100项，每项独立复制到项目。`results.restore`：`{snapshotId}`，设置活动成果但不删除历史。

快照不会自动同步或重跑。明确更新才切换当前输入，旧 Run 保存 inputLineage 和提交时输入，不受影响。来源被删除或移出项目后副本仍可用；只失去继续更新的能力。下载仍走 `/assets/:assetId/download`。Checkpoint/undo 覆盖 IO，恢复输出形成单调递增的新版本。不要把项目成果的 assetId 塞进画布运行参数绕过不可引用规则。

- 2026-09-14：生成卡片以 nodeId + 产物类型/文字端口维护稳定输出身份，显式再次发布替换该输出，撤下重发保留 itemKey；assetId 仅标识具体资源。批量发布同一卡片端口限选一个产物，已有历史快照保持原样。无编辑权限禁用检查更新。

- 2026-09-14：input.remove 不要求删除工作区节点，输入组移入 removedInputs 历史，保留实际快照、节点及连线，并显示输入已移除标记。历史不作为可选输入或更新来源。
