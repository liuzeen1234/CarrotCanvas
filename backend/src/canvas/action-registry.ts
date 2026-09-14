export interface RegisteredAction {
  name: string;
  version: number;
  description: string;
  machineDescription: string;
  scope: string;
  method: string;
  path: string;
  requiresLease: boolean;
  permission: 'read' | 'write' | 'high-impact';
  confirmation: 'none' | 'human';
  sideEffects: string[];
  idempotent: boolean;
  reversible: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  available: boolean;
  unavailableReason: string | null;
  errors: Array<{ code: string; status: number; description: string }>;
}

const outputSchema = { type: 'object', description: 'Action-specific JSON response; inspect the endpoint contract for nested provider payloads.' };
const inputFor = (path: string, method: string) => {
  const pathNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  return {
    type: 'object',
    properties: {
      path: { type: 'object', properties: Object.fromEntries(pathNames.map((name) => [name, { type: 'string', minLength: 1 }])), required: pathNames, additionalProperties: false },
      ...(method === 'GET' ? { query: { type: 'object', additionalProperties: true } } : { body: { type: 'object', additionalProperties: true } }),
    },
    required: pathNames.length ? ['path'] : [],
    additionalProperties: false,
  };
};
const standardErrors = [
  { code: 'VALIDATION_ERROR', status: 400, description: '请求参数不合法' },
  { code: 'NOT_FOUND', status: 404, description: '目标资源不存在' },
];
const action = (value: Partial<RegisteredAction> & Pick<RegisteredAction, 'name' | 'description' | 'method' | 'path'>): RegisteredAction => ({
  version: 1, machineDescription: value.description, scope: 'platform', requiresLease: false,
  permission: value.method === 'GET' ? 'read' : 'write', confirmation: 'none', sideEffects: [],
  idempotent: value.method === 'GET', reversible: false, inputSchema: inputFor(value.path, value.method),
  outputSchema, available: true, unavailableReason: null, errors: standardErrors, ...value,
});

const canvasWriteErrors = [
  ...standardErrors,
  { code: 'CANVAS_LOCKED', status: 423, description: '另一写入者持有控制权' },
  { code: 'LEASE_EXPIRED', status: 410, description: '租约不存在或已过期' },
  { code: 'STALE_LEASE', status: 409, description: '租约 epoch 已变化' },
  { code: 'REVISION_CONFLICT', status: 409, description: 'expectedRevision 已过期' },
  { code: 'OPERATION_NOT_ALLOWED', status: 403, description: '令牌无效或权限不足' },
  { code: 'IDEMPOTENCY_CONFLICT', status: 409, description: '幂等键已用于不同请求' },
  { code: 'DUPLICATE_NODE_ID', status: 400, description: '节点 ID 重复' },
  { code: 'DUPLICATE_EDGE_ID', status: 400, description: '连线 ID 重复' },
  { code: 'NODE_NOT_FOUND', status: 400, description: '操作引用的节点不存在' },
  { code: 'EDGE_NODE_NOT_FOUND', status: 400, description: '连线引用的节点不存在' },
  { code: 'HANDLE_NOT_FOUND', status: 400, description: '节点或工作流未声明该句柄' },
  { code: 'MEDIA_TYPE_MISMATCH', status: 400, description: '源和目标端口媒体类型不兼容' },
  { code: 'MAX_INCOMING_EXCEEDED', status: 400, description: '输入端口超过最大入线数' },
  { code: 'CYCLE_NOT_ALLOWED', status: 400, description: '连线会形成禁止的环路' },
  { code: 'UNDO_PRECONDITION_FAILED', status: 409, description: '目标批次之后已有修改，不能安全撤销' },
  { code: 'OPERATION_NOT_REVERSIBLE', status: 409, description: '该批次含不可日常撤销的资产删除' },
];

/** Phase 0A capability fact. Schemas are intentionally discoverable and may grow without changing action names. */
export const ACTION_REGISTRY: RegisteredAction[] = [
  action({ name: 'project.list', description: '列出项目与画布/成果数量', method: 'GET', path: '/api/projects', scope: 'workspace', outputSchema: { type: 'array', items: { type: 'object' } } }),
  action({ name: 'project.get', description: '读取项目、关联画布及只供浏览下载的成果快照历史', method: 'GET', path: '/api/projects/:id', scope: 'project' }),
  action({ name: 'project.create', description: '创建画布集合项目，无输入区；项目不能作为引用来源', method: 'POST', path: '/api/projects', scope: 'workspace' }),
  action({ name: 'project.delete', description: '删除空项目及其成果副本，不删除画布；包含画布则拒绝', method: 'DELETE', path: '/api/projects/:id', scope: 'project', permission: 'high-impact', confirmation: 'human', errors: [...standardErrors, { code: 'PROJECT_NOT_EMPTY', status: 409, description: '请先移出所有画布' }, { code: 'REVISION_CONFLICT', status: 409, description: '项目版本变化' }], inputSchema: commandSchema(false, undefined, { expectedRevision: { type: 'integer' } }, ['expectedRevision']) }),
  ...['edit', 'canvas.add', 'canvas.remove', 'canvas.create', 'results.capture', 'results.restore'].map(command => action({ name: `project.${command}`, description: `项目命令 ${command}；多对多关联不修改画布 revision；成果保存独立副本，不能被引用`, method: 'POST', path: '/api/projects/:id/command', scope: 'project', idempotent: true, reversible: command === 'results.restore' || command.startsWith('canvas.'), sideEffects: ['project_revision', ...(command === 'results.capture' ? ['project_snapshot_files'] : [])], inputSchema: commandSchema(false, command), errors: [...standardErrors, { code: 'REVISION_CONFLICT', status: 409, description: '项目版本变化' }, { code: 'IDEMPOTENCY_CONFLICT', status: 409, description: '幂等键冲突' }, { code: 'SOURCE_VERSION_CHANGED', status: 409, description: '请重新选择成果版本' }] })),
  action({ name: 'canvas.io.get', description: '读取画布输入组/快照历史、输出版本；输出仅明确发布后可引入', method: 'GET', path: '/api/canvas/:id/io', scope: 'canvas' }),
  action({ name: 'canvas.input.check_update', description: '只读比较上游当前输出与固定输入快照，不更新内容', method: 'GET', path: '/api/canvas/:id/io/inputs/:groupId/update-preview', scope: 'canvas' }),
  action({ name: 'canvas.input.import', description: 'multipart files（1–30 个，单文件 ≤256 MB，UTF-8 文本 ≤5 MB）；复制原文件，不启动 Provider', method: 'POST', path: '/api/canvas/:id/io/files', scope: 'canvas', requiresLease: true, idempotent: true, sideEffects: ['canvas_revision','input_snapshot_files'], errors: canvasWriteErrors, inputSchema: { type: 'object', required: ['path','multipart'], properties: { path: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, multipart: { type: 'object', required: ['files','leaseToken','leaseEpoch','expectedRevision','idempotencyKey'], properties: { files: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', format: 'binary' } }, leaseToken: { type: 'string' }, leaseEpoch: { type: 'integer' }, expectedRevision: { type: 'integer' }, idempotencyKey: { type: 'string' }, name: { type: 'string' } } } } } }),
  ...['input.capture','input.update','input.restore','input.remove','input.edit','input.bind','output.publish','output.replace','output.edit','output.remove','output.reorder'].map(command => action({ name: `canvas.${command}`, description: `画布 IO 命令 ${command}；固定版本，复制本地素材，只有主动更新才变化；既有 Run 不变`, method: 'POST', path: '/api/canvas/:id/io/command', scope: 'canvas', requiresLease: true, idempotent: true, reversible: true, sideEffects: ['canvas_revision','operation_log', ...(command === 'input.capture' || command === 'input.update' ? ['input_snapshot_files'] : [])], inputSchema: commandSchema(true, command), errors: [...canvasWriteErrors, { code: 'INPUT_ITEM_IN_USE', status: 400, description: '请先解除工作区使用或保留旧快照' }, { code: 'INPUT_KIND_CHANGED', status: 400, description: '新版输入类型改变' }, { code: 'SOURCE_VERSION_CHANGED', status: 409, description: '来源版本变化，请重新预览' }, { code: 'SOURCE_HAS_NO_OUTPUTS', status: 400, description: '来源没有已发布输出' }] })),
  action({ name: 'run.recovery_suggestion', description: '只读查找补录原因与来源关联，优先自动填入',
    method: 'GET', path: '/api/runs/:id/recovery-suggestion', scope: 'run',
    machineDescription: 'Read-only recovery draft from source error, current node output, matching provider task ID and attributed node notes. Optional assetId; otherwise use current output. Does not invoke providers or register recovery. Empty evidence means insufficient linkage and requires operator input. Current output and notes do not prove same upstream invocation.',
    errors: [...standardErrors, { code: 'RUN_NOT_RECOVERABLE', status: 409, description: '该 Run 不支持补录' }, { code: 'RECOVERY_ASSET_MISMATCH', status: 400, description: '资产归属或类型不匹配' }] }),
  action({ name: 'run.recover', description: '补录已有产物为独立恢复历史，保留原失败 Run',
    machineDescription: 'Register one existing same-canvas/node asset for a failed/cancelled/needs_attention run. No provider invocation. The new succeeded record represents successful recovery registration and has explicit recovery metadata and parentRunId. Preserve current/approved selections and canonical graph revision. Deterministically idempotent per source run + asset; evidence is an operator statement, not automatic proof.',
    method: 'POST', path: '/api/runs/:id/recover', scope: 'run', requiresLease: true, idempotent: true,
    sideEffects: ['recovery_record', 'candidate_append'], errors: [...canvasWriteErrors,
      { code: 'RUN_NOT_RECOVERABLE', status: 409, description: '原 Run 状态或上下文不支持补录' },
      { code: 'RECOVERY_ASSET_MISMATCH', status: 400, description: '跨画布、节点或错误类型的资产/输入参考素材' },
      { code: 'ASSET_ALREADY_RECORDED', status: 409, description: '资产已登记成功输出，不能重复归因' },
      { code: 'RECOVERY_HANDOFF_PENDING', status: 409, description: '正在交接，禁止新的补录' }],
    inputSchema: { type: 'object', required: ['path', 'body'], properties: {
      path: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } }, additionalProperties: false },
      body: { type: 'object', required: ['leaseToken', 'leaseEpoch', 'expectedRevision', 'assetId', 'reason', 'evidence'], properties: {
        leaseToken: { type: 'string', minLength: 1 }, leaseEpoch: { type: 'integer' }, expectedRevision: { type: 'integer' },
        assetId: { type: 'string', minLength: 1, maxLength: 100 }, reason: { type: 'string', minLength: 1, maxLength: 2000 }, evidence: { type: 'string', minLength: 1, maxLength: 4000 },
      }, additionalProperties: false },
    }, additionalProperties: false } }),
  action({ name: 'canvas.list', description: '列出画布', method: 'GET', path: '/api/canvas', scope: 'workspace' }),
  action({ name: 'canvas.create', description: '创建画布', method: 'POST', path: '/api/canvas', scope: 'workspace', idempotent: false }),
  action({ name: 'canvas.get', description: '读取画布', method: 'GET', path: '/api/canvas/:id', scope: 'canvas' }),
  action({ name: 'canvas.agent_view', description: '读取适合 Agent 的画布、控制权和可用操作视图', method: 'GET', path: '/api/canvas/:id/agent-view', scope: 'canvas' }),
  action({ name: 'canvas.operations', description: '原子提交画布语义操作', method: 'POST', path: '/api/canvas/:id/operations', scope: 'canvas', requiresLease: true, idempotent: true, reversible: true, sideEffects: ['canvas_revision', 'operation_log'], errors: canvasWriteErrors, inputSchema: { type: 'object', required: ['path', 'body'], properties: { path: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false }, body: { type: 'object', required: ['leaseToken', 'leaseEpoch', 'expectedRevision', 'idempotencyKey', 'operations'], properties: { leaseToken: { type: 'string' }, leaseEpoch: { type: 'integer' }, expectedRevision: { type: 'integer' }, idempotencyKey: { type: 'string' }, intent: { type: 'string' }, operations: { type: 'array', minItems: 1, items: { type: 'object', required: ['type'], properties: { type: { enum: ['replace_graph', 'rename_canvas', 'set_brief', 'create_node', 'update_node', 'move_nodes', 'delete_node', 'connect', 'disconnect'] } }, additionalProperties: true } } }, additionalProperties: true } }, additionalProperties: false } }),
  action({ name: 'canvas.operation_log.list', description: '读取画布操作审计记录', method: 'GET', path: '/api/canvas/:id/operation-log', scope: 'canvas' }),
  action({ name: 'canvas.operation_log.undo', description: '在无后续修改时安全撤销一个操作批次', method: 'POST', path: '/api/canvas/:id/operation-log/:logId/undo', scope: 'canvas', requiresLease: true, idempotent: true, reversible: true, sideEffects: ['canvas_revision', 'operation_log'], errors: canvasWriteErrors }),
  action({ name: 'canvas.checkpoint.list', description: '列出画布恢复点', method: 'GET', path: '/api/canvas/:id/checkpoints', scope: 'canvas' }),
  action({ name: 'canvas.checkpoint.create', description: '创建完整画布恢复点', method: 'POST', path: '/api/canvas/:id/checkpoints', scope: 'canvas', requiresLease: true, idempotent: false, sideEffects: ['checkpoint'], errors: canvasWriteErrors }),
  action({ name: 'canvas.checkpoint.restore', description: '覆盖式恢复画布恢复点', method: 'POST', path: '/api/canvas/:id/checkpoints/:checkpointId/restore', scope: 'canvas', requiresLease: true, permission: 'high-impact', confirmation: 'human', idempotent: true, sideEffects: ['canvas_revision', 'operation_log'], errors: canvasWriteErrors }),
  action({ name: 'canvas.update', description: '受控更新画布（兼容入口）', method: 'PATCH', path: '/api/canvas/:id', scope: 'canvas', requiresLease: true, idempotent: true, sideEffects: ['canvas_revision'], errors: canvasWriteErrors }),
  action({ name: 'canvas.delete', description: '删除画布及其资产', method: 'DELETE', path: '/api/canvas/:id', scope: 'canvas', requiresLease: true, permission: 'high-impact', confirmation: 'human', sideEffects: ['canvas', 'assets'], errors: canvasWriteErrors }),
  action({ name: 'run.handoff', description: '保存现有 Run 的交接快照并主动释放画布控制权；不会取消或重新提交 provider 任务', method: 'POST', path: '/api/runs/:id/handoff', scope: 'run', requiresLease: true, idempotent: false, sideEffects: ['run_handoff', 'canvas_lease'], errors: canvasWriteErrors }),
  action({ name: 'run.adopt', description: '使用新画布租约接手已有 Run；保持平台 runId 和 providerRunId 不变', method: 'POST', path: '/api/runs/:id/adopt', scope: 'run', requiresLease: true, idempotent: true, sideEffects: ['run_handoff'], errors: canvasWriteErrors }),
  action({ name: 'run.cancel', description: '请求取消 Run；TTS 在语音片段边界取消', machineDescription: 'Inspect run.capabilities.cancel first. TTS stops at a speech-segment boundary. Completed outputs remain preserved.', method: 'POST', path: '/api/runs/:id/cancel', scope: 'run', idempotent: true, errors: [...standardErrors, { code: 'CANCEL_NOT_PRECISE', status: 409, description: '提供方不支持安全的 run 级精确取消' }] }),
  action({ name: 'gpu_scheduler.status', description: '已弃用的兼容入口；新客户端使用 local_compute_scheduler.status', machineDescription: 'Deprecated compatibility route. Do not use for new integrations.', method: 'GET', path: '/api/gpu-scheduler/status', scope: 'platform' }),
  action({ name: 'comfyui.takeover.inspect', description: '读取外部 ComfyUI/Desktop 进程及资源快照', method: 'GET', path: '/api/comfyui/process-status', permission: 'read' }),
  action({ name: 'comfyui.takeover.request_confirmation', description: '为当前外部 ComfyUI/Desktop 快照签发五分钟一次性确认令牌', method: 'POST', path: '/api/comfyui/takeover/confirmation', idempotent: false }),
  action({ name: 'comfyui.takeover.execute', description: '消费用户在当前交互中明确确认的一次性令牌，关闭外部 Desktop/相关进程并启动托管 ComfyUI', machineDescription: 'Only call after the user explicitly confirms the exact snapshot in the current conversation. Process changes invalidate the token.', method: 'POST', path: '/api/comfyui/takeover', permission: 'high-impact', confirmation: 'human', idempotent: false, sideEffects: ['external_processes', 'comfyui_process', 'local_compute_scheduler'], errors: [
    ...standardErrors,
    { code: 'TAKEOVER_CONFIRMATION_REQUIRED', status: 400, description: '缺少一次性确认令牌' },
    { code: 'TAKEOVER_CONFIRMATION_INVALID', status: 400, description: '令牌无效或已使用' },
    { code: 'TAKEOVER_CONFIRMATION_EXPIRED', status: 410, description: '确认已过期' },
    { code: 'TAKEOVER_CONFIRMATION_STALE', status: 409, description: '进程快照已变化，必须重新确认' },
  ] }),
  ...['status', 'acquire', 'renew', 'release', 'request-handoff', 'force-takeover'].map((part) => action({
    name: `canvas.lease.${part.replace('-', '_')}`, description: `画布控制权 ${part}`, method: part === 'status' ? 'GET' : 'POST',
    path: `/api/canvas/:id/control/${part}`, scope: 'canvas', idempotent: part !== 'acquire' && part !== 'force-takeover',
    permission: part === 'force-takeover' ? 'high-impact' : part === 'status' ? 'read' : 'write',
    confirmation: part === 'force-takeover' ? 'human' : 'none', sideEffects: part === 'status' ? [] : ['canvas_lease'],
  })),
  ...[
    ['workflow.categories','GET','/api/workflows/categories'], ['workflow.list','GET','/api/workflows'], ['workflow.get','GET','/api/workflows/:id'], ['workflow.create','POST','/api/workflows'], ['workflow.update','PATCH','/api/workflows/:id'], ['workflow.delete','DELETE','/api/workflows/:id'],
    ['asset.get','GET','/api/assets/:id'], ['asset.download','GET','/api/assets/:id/download'], ['asset.delete_generated_by_node','DELETE','/api/assets/generated/by-node'],
    ['run.list','GET','/api/runs'], ['run.get','GET','/api/runs/:id'], ['run.wait','GET','/api/runs/:id/wait'], ['run.lineage','GET','/api/runs/:id/lineage'], ['run.retry','POST','/api/runs/:id/retry'], ['run.candidates.get','GET','/api/runs/candidates/group'], ['run.candidates.choose','PATCH','/api/runs/candidates/group'], ['run.candidates.choose_text','PATCH','/api/runs/candidates/text'],
    ['settings.get','GET','/api/settings/:key'], ['settings.set','PUT','/api/settings/:key'], ['settings.test_connection','POST','/api/settings/test-connection'],
    ['system.resources','GET','/api/system/resources'],
    ['local_compute_scheduler.status','GET','/api/local-compute-scheduler/status'],
    ['tts.providers','GET','/api/tts/providers'], ['tts.voices','GET','/api/tts/voices'],
    ['comfyui.workflow.list','GET','/api/comfyui/workflows'], ['comfyui.workflow.preview','POST','/api/comfyui/workflows/preview'], ['comfyui.workflow.import','POST','/api/comfyui/workflows/import'], ['comfyui.schema','GET','/api/comfyui/workflows/:id/schema'], ['comfyui.run.submit','POST','/api/comfyui/runs'], ['comfyui.run.get','GET','/api/comfyui/runs/:id'], ['comfyui.run.list','GET','/api/comfyui/runs'], ['comfyui.run.interrupt','POST','/api/comfyui/runs/:id/interrupt'], ['comfyui.view','GET','/api/comfyui/view'], ['comfyui.upload_image','POST','/api/comfyui/upload/image'], ['comfyui.upload_media','POST','/api/comfyui/upload/media'], ['comfyui.upload_asset','POST','/api/comfyui/upload/asset'],
    ['codex2api.config','GET','/api/codex2api/config'], ['codex2api.config_update','PUT','/api/codex2api/config'], ['codex2api.health','GET','/api/codex2api/health'], ['codex2api.models','GET','/api/codex2api/models'], ['codex2api.image','GET','/api/codex2api/image'], ['codex2api.chat','POST','/api/codex2api/chat/completions'], ['codex2api.image_generate','POST','/api/codex2api/images/generations'], ['codex2api.image_edit','POST','/api/codex2api/images/edits'], ['codex2api.image_analyze','POST','/api/codex2api/images/analyze'],
  ].map(([name, method, path]) => action({ name, description: name, method, path })),
  action({ name: 'tts.run.submit', description: '用 CosyVoice 3、IndexTTS2 或 Qwen3-TTS 按 pause plan 严格串行生成语音片段、插入精确 PCM 静音并保存一条最终音频', machineDescription: 'Qwen3-TTS supports official CustomVoice speakers and prompt-only VoiceDesign. Supports only <pause ms="N"/> with N=100..10000. Holds one outer local-compute lease through synthesis, concatenation and final persistence.', method: 'POST', path: '/api/tts/runs', scope: 'run', requiresLease: true, idempotent: true, sideEffects: ['generation_run', 'local_compute_lease', 'audio_asset'], errors: canvasWriteErrors }),
];

function commandSchema(lease: boolean, command?: string, fields?: Record<string, unknown>, requiredFields?: string[]) {
  const string = { type: 'string' }; const payload: Record<string, unknown> = {
    groupId: string, itemKey: string, snapshotId: string, sourceCanvasId: string, sourceOutputsVersion: { type: 'integer' },
    canvasId: string, name: { type: 'string', maxLength: 200 }, note: { type: 'string', maxLength: 2000 }, description: { type: 'string', maxLength: 2000 },
    nodeId: string, runId: string, assetId: string, text: { type: 'string' }, textPart: { enum: ['positive','negative'] },
    position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x','y'] },
    order: { type: 'array', uniqueItems: true, items: string },
    items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { assetId: string, nodeId: string, runId: string, text: string, textPart: { enum: ['positive', 'negative'] }, name: string, note: string } } },
    selections: { type: 'array', maxItems: 100, items: { type: 'object', required: ['canvasId','itemKey','outputsVersion'], properties: { canvasId: string, itemKey: string, outputsVersion: { type: 'integer' }, name: string, note: string } } },
  };
  return { type: 'object', required: ['path','body'], properties: {
    path: { type: 'object', required: ['id'], properties: { id: string } },
    body: { type: 'object', required: requiredFields ?? ['expectedRevision','idempotencyKey','command', ...(lease ? ['leaseToken','leaseEpoch'] : [])], properties: fields ?? {
      expectedRevision: { type: 'integer' }, idempotencyKey: string, command: { const: command }, actorId: string, actorType: { enum: ['human','agent'] },
      ...(lease ? { leaseToken: string, leaseEpoch: { type: 'integer' } } : {}), payload: { type: 'object', properties: payload, additionalProperties: false },
    }, additionalProperties: false },
  } };
}
