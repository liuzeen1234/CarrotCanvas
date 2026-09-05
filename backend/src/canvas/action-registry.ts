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
  ...['status', 'acquire', 'renew', 'release', 'request-handoff', 'force-takeover'].map((part) => action({
    name: `canvas.lease.${part.replace('-', '_')}`, description: `画布控制权 ${part}`, method: part === 'status' ? 'GET' : 'POST',
    path: `/api/canvas/:id/control/${part}`, scope: 'canvas', idempotent: part !== 'acquire' && part !== 'force-takeover',
    permission: part === 'force-takeover' ? 'high-impact' : part === 'status' ? 'read' : 'write',
    confirmation: part === 'force-takeover' ? 'human' : 'none', sideEffects: part === 'status' ? [] : ['canvas_lease'],
  })),
  ...[
    ['workflow.categories','GET','/api/workflows/categories'], ['workflow.list','GET','/api/workflows'], ['workflow.get','GET','/api/workflows/:id'], ['workflow.create','POST','/api/workflows'], ['workflow.update','PATCH','/api/workflows/:id'], ['workflow.delete','DELETE','/api/workflows/:id'],
    ['asset.get','GET','/api/assets/:id'], ['asset.download','GET','/api/assets/:id/download'], ['asset.delete_generated_by_node','DELETE','/api/assets/generated/by-node'],
    ['run.list','GET','/api/runs'], ['run.get','GET','/api/runs/:id'], ['run.wait','GET','/api/runs/:id/wait'], ['run.lineage','GET','/api/runs/:id/lineage'], ['run.retry','POST','/api/runs/:id/retry'], ['run.adopt','POST','/api/runs/:id/adopt'], ['run.cancel','POST','/api/runs/:id/cancel'], ['run.candidates.get','GET','/api/runs/candidates/group'], ['run.candidates.choose','PATCH','/api/runs/candidates/group'], ['run.candidates.choose_text','PATCH','/api/runs/candidates/text'],
    ['settings.get','GET','/api/settings/:key'], ['settings.set','PUT','/api/settings/:key'], ['settings.test_connection','POST','/api/settings/test-connection'],
    ['comfyui.workflow.list','GET','/api/comfyui/workflows'], ['comfyui.workflow.preview','POST','/api/comfyui/workflows/preview'], ['comfyui.workflow.import','POST','/api/comfyui/workflows/import'], ['comfyui.schema','GET','/api/comfyui/workflows/:id/schema'], ['comfyui.run.submit','POST','/api/comfyui/runs'], ['comfyui.run.get','GET','/api/comfyui/runs/:id'], ['comfyui.run.list','GET','/api/comfyui/runs'], ['comfyui.run.interrupt','POST','/api/comfyui/runs/:id/interrupt'], ['comfyui.view','GET','/api/comfyui/view'], ['comfyui.upload_image','POST','/api/comfyui/upload/image'], ['comfyui.upload_asset','POST','/api/comfyui/upload/asset'],
    ['codex2api.config','GET','/api/codex2api/config'], ['codex2api.config_update','PUT','/api/codex2api/config'], ['codex2api.health','GET','/api/codex2api/health'], ['codex2api.models','GET','/api/codex2api/models'], ['codex2api.image','GET','/api/codex2api/image'], ['codex2api.chat','POST','/api/codex2api/chat/completions'], ['codex2api.image_generate','POST','/api/codex2api/images/generations'], ['codex2api.image_edit','POST','/api/codex2api/images/edits'], ['codex2api.image_analyze','POST','/api/codex2api/images/analyze'],
  ].map(([name, method, path]) => action({ name, description: name, method, path })),
];
