/** C6 文生图节点：schema 表单、提交校验、运行/中断与平台资产回写。 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Popconfirm, Progress, Space, Spin, Tag, Upload, message } from 'antd';
import { AudioOutlined, CloseCircleFilled, DeleteOutlined, DownloadOutlined, PauseCircleOutlined, PlayCircleFilled, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { ComfyUIAPI, RunStateData, SchemaField, applyFormValues, fileKey, splitByExposure } from '@/components/comfyui/types';
import { ComfySchemaForm } from '@/components/comfyui/ComfySchemaForm';
import { useComfyRun } from '@/components/comfyui/useComfyRun';
import { CanvasNodeDataContext } from '../context';
import { Txt2ImgNodeData, resultSourceHandle, workflowInputHandle, workflowOutputKind, workflowReferenceHandle, type WorkflowReferenceGroup } from './types';
import NodeOutputHistory from '../NodeOutputHistory';
import { RunElapsed } from '../RunTiming';
import CanvasMediaPreview, { type CanvasMediaItem } from '../CanvasMediaPreview';
import { AssetIdLabel, NodeCardFields } from './NodeCardFields';
import { ImeSafeMentions } from '../ImeSafeInput';

const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

type MediaKind = 'image' | 'video' | 'audio';
type ReferenceItem = { referenceId: string; edgeId?: string; sourceNodeId?: string; displayName: string; assetId: string; url: string; kind: MediaKind; filename?: string };
type ReferenceGroupConfig = { key: WorkflowReferenceGroup; label: string; kind: MediaKind; max: number; tag: 'Picture' | 'Video' | 'Audio' | null; slots: Array<{ nodeId: string; param: string; kind: MediaKind }> };

function referenceConfig(workflow: ComfyUIAPI | null) {
  if (!workflow) return null;
  const api = workflow.apiJson as Record<string, any>;
  const h3 = Object.entries(api).find(([, node]) => ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageToVideo'].includes(node?.class_type));
  if (h3) {
    const [nodeId, node] = h3;
    const upgradesImageToVideo = node.class_type === 'MiniMaxH3ImageToVideo';
    const findUpstreamField = (value: unknown, kind: MediaKind, visited = new Set<string>()): { nodeId: string; param: string; kind: MediaKind } | null => {
      if (!Array.isArray(value) || typeof value[0] !== 'string' || visited.has(value[0])) return null;
      const sourceId = value[0]; visited.add(sourceId);
      const direct = workflow.inputConfig?.fields.find((field) => field.kind === kind && field.nodeId === sourceId);
      if (direct) return direct as { nodeId: string; param: string; kind: MediaKind };
      const source = api[sourceId];
      for (const upstream of Object.values(source?.inputs || {})) {
        const field = findUpstreamField(upstream, kind, visited);
        if (field) return field;
      }
      return null;
    };
    const specs: Array<Omit<ReferenceGroupConfig, 'slots'>> = [
      { key: 'images', label: '参考图', kind: 'image', max: 9, tag: 'Picture' },
      { key: 'videos', label: '参考视频', kind: 'video', max: 3, tag: 'Video' },
      { key: 'videoAudios', label: '视频配音', kind: 'audio', max: 3, tag: null },
      { key: 'audios', label: '参考音频', kind: 'audio', max: 3, tag: 'Audio' },
    ];
    const prefixes: Record<WorkflowReferenceGroup, string> = { images: 'ref_images.ref_image_', videos: 'ref_videos.ref_video_', videoAudios: 'ref_video_audios.ref_video_audio_', audios: 'ref_audios.ref_audio_' };
    const groups = specs.map((spec) => ({ ...spec, slots: Array.from({ length: spec.max }, (_, index) => {
      const param = `${prefixes[spec.key]}${index}`; const value = upgradesImageToVideo && spec.key === 'images' && index === 0 ? node.inputs?.first_frame : node.inputs?.[param];
      if (Array.isArray(value)) {
        const field = findUpstreamField(value, spec.kind);
        if (field) return field;
      }
      return workflow.inputConfig?.fields.find((field) => field.kind === spec.kind && field.nodeId === nodeId && field.param === param)
        || { nodeId, param, kind: spec.kind };
    }) })) as ReferenceGroupConfig[];
    const promptLink = node.inputs?.prompt;
    const promptField = Array.isArray(promptLink)
      ? findUpstreamField(promptLink, 'text')
      : workflow.inputConfig?.fields.find((field) => field.kind === 'text' && field.nodeId === nodeId && field.param === 'prompt');
    return { groups, promptKey: promptField ? `${promptField.nodeId}::${promptField.param}` : null, upgradeNodeId: upgradesImageToVideo ? nodeId : null };
  }
  if (workflow.category === 'img2img' && /z[- ]?image/i.test(workflow.name)) {
    const slot = workflow.inputConfig?.fields.find((field) => field.kind === 'image');
    return slot ? { groups: [{ key: 'images', label: '参考图', kind: 'image', max: 1, slots: [slot], tag: 'Picture' } as ReferenceGroupConfig], promptKey: null } : null;
  }
  return null;
}

export default function Txt2ImgNode(props: NodeProps) {
  const data = props.data as Txt2ImgNodeData;
  const { canvasId, control, readOnly, updateNodeData, observeNodeData, deleteNode, setNodeRunState, getNodeRunState, getUpstreamAsset, getUpstreamAssets, disconnectEdge, getUpstreamText, generationHistoryVersion } = useContext(CanvasNodeDataContext);
  const [workflow, setWorkflow] = useState<ComfyUIAPI | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [referencePreview, setReferencePreview] = useState<{ group: WorkflowReferenceGroup; index: number } | null>(null);
  const [missingKeys, setMissingKeys] = useState<Set<string>>(new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const initializedRef = useRef(false);
  const nodeId = props.id;

  const onRunStarted = useCallback((state: RunStateData) => setNodeRunState(nodeId, state), [nodeId, setNodeRunState]);
  const onRunFinished = useCallback((state: RunStateData) => {
    setNodeRunState(nodeId, state);
    if (state.status !== 'success') return;
    const assets = state.outputs.filter((o) => o.assetId && o.assetUrl).map((o) => ({ assetId: o.assetId!, url: o.assetUrl!, kind: o.kind, filename: o.filename }));
    if (assets.length) updateNodeData(nodeId, { lastAssets: assets });
    setHistoryVersion((value) => value + 1);
  }, [nodeId, setNodeRunState, updateNodeData]);

  const run = useComfyRun({ workflow, canvas: { canvasId, nodeId, ...control }, onRunStarted, onRunFinished });

  useEffect(() => {
    if (!data.workflowId) return;
    let alive = true;
    initializedRef.current = false;
    setWorkflowLoading(true);
    setLoadError(null);
    request<ComfyUIAPI>(`/api/workflows/${data.workflowId}`)
      .then((loaded) => {
        if (!alive) return;
        setWorkflow(loaded);
        return run.init(loaded, data.formValues ?? {}, data.autoRandomSeedKeys ?? []).then(() => { initializedRef.current = true; });
      })
      .catch((error: any) => {
        if (!alive) return;
        setWorkflow(null);
        setLoadError(error?.response?.data?.message || '绑定的工作流已不存在');
      })
      .finally(() => { if (alive) setWorkflowLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.workflowId]);

  useEffect(() => {
    if (!initializedRef.current) return;
    const timer = setTimeout(() => updateNodeData(nodeId, { formValues: run.formValues }), 300);
    return () => clearTimeout(timer);
  }, [nodeId, run.formValues, updateNodeData]);

  useEffect(() => {
    if (!initializedRef.current) return;
    const timer = setTimeout(() => updateNodeData(nodeId, { autoRandomSeedKeys: [...run.autoRandomSeedKeys] }), 300);
    return () => clearTimeout(timer);
  }, [nodeId, run.autoRandomSeedKeys, updateNodeData]);

  useEffect(() => setNodeRunState(nodeId, run.runState), [nodeId, run.runState, setNodeRunState]);

  const exposedKeys = useMemo(() => {
    if (!run.schema || !workflow) return new Set<string>();
    const { primary } = splitByExposure(run.schema, workflow.exposureConfig);
    return new Set(primary.flatMap((group) => group.fields.map(fileKey)));
  }, [run.schema, workflow]);

  const inputKinds = useMemo(() => new Map(
    (workflow?.inputConfig?.fields ?? []).map((f) => [`${f.nodeId}::${f.param}`, f.kind]),
  ), [workflow]);

  const refConfig = useMemo(() => referenceConfig(workflow), [workflow]);
  const referenceGroups = (refConfig?.groups || []).map((config) => {
    const legacy = config.slots.flatMap((field) => getUpstreamAssets(nodeId, workflowInputHandle(field.nodeId, field.param, config.kind), config.kind));
    const connected = [...legacy, ...getUpstreamAssets(nodeId, workflowReferenceHandle(config.key), config.kind)] as ReferenceItem[];
    const embedded = config.slots.flatMap((field, index): ReferenceItem[] => {
      if (getUpstreamAssets(nodeId, workflowInputHandle(field.nodeId, field.param, config.kind), config.kind).length) return [];
      const key = `${field.nodeId}::${field.param}`; const filename = String(run.formValues[key] ?? data.formValues?.[key] ?? '').trim();
      if (!filename) return [];
      const normalized = filename.replace(/\\/g, '/'); const slash = normalized.lastIndexOf('/');
      const query = new URLSearchParams({ filename: slash >= 0 ? normalized.slice(slash + 1) : normalized, type: 'input' });
      if (slash >= 0) query.set('subfolder', normalized.slice(0, slash));
      return [{ referenceId: `field:${config.key}:${key}`, displayName: normalized.split('/').at(-1) || `${config.label} ${index + 1}`, assetId: '', url: `/api/comfyui/view?${query.toString()}`, kind: config.kind, filename }];
    });
    const legacyUploads = config.key === 'images' ? (data.referenceImages || []) : [];
    const uploaded = [...legacyUploads, ...(data.referenceMedia?.[config.key] || [])] as ReferenceItem[];
    const legacyOrder = config.key === 'images' ? (data.referenceImageOrder || []) : [];
    const order = data.referenceMediaOrder?.[config.key] || legacyOrder;
    const references = [...connected, ...embedded, ...uploaded].filter((item, index, all) => all.findIndex((candidate) => candidate.referenceId === item.referenceId) === index).sort((a, b) => {
      const ai = order.indexOf(a.referenceId), bi = order.indexOf(b.referenceId);
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    });
    return { config, connected, uploaded, order, references };
  });
  const references = referenceGroups.flatMap((group) => group.references);
  const referencePrompt = refConfig?.promptKey ? String(run.formValues[refConfig.promptKey] ?? data.formValues?.[refConfig.promptKey] ?? '') : '';
  const allBindings = [...(data.promptMediaReferences || []), ...(data.promptImageReferences || []).map((binding) => ({ ...binding, group: 'images' as WorkflowReferenceGroup }))];
  const activeBindings = allBindings.filter((binding) => referencePrompt.includes(binding.token));
  const missingBindings = activeBindings.filter((binding) => !references.some((item) => item.referenceId === binding.referenceId));
  const hiddenReferenceKeys = useMemo(() => new Set([
    ...(refConfig?.groups || []).flatMap((group) => group.slots.map((field) => `${field.nodeId}::${field.param}`)),
    ...(refConfig?.promptKey ? [refConfig.promptKey] : []),
  ]), [refConfig]);

  const updateReferencePrompt = (prompt: string) => {
    if (!refConfig?.promptKey) return;
    run.handleFormChange(refConfig.promptKey, prompt);
    updateNodeData(nodeId, { promptMediaReferences: allBindings.filter((binding) => prompt.includes(binding.token)), promptImageReferences: [] });
  };
  const updateGroup = (key: WorkflowReferenceGroup, patch: Record<string, unknown>) => updateNodeData(nodeId, patch);
  const removeReference = (groupKey: WorkflowReferenceGroup, referenceId: string) => {
    const binding = activeBindings.find((item) => item.referenceId === referenceId);
    if (binding) { message.error(`“${binding.displayName}”仍被提示词引用，请先删除 ${binding.token}`); return; }
    const group = referenceGroups.find((item) => item.config.key === groupKey)!; const connected = group.connected.find((item) => item.referenceId === referenceId);
    if (connected?.edgeId) disconnectEdge(connected.edgeId);
    else if (referenceId.startsWith(`field:${groupKey}:`)) run.handleFormChange(referenceId.slice(`field:${groupKey}:`.length), '');
    else updateGroup(groupKey, { referenceMedia: { ...(data.referenceMedia || {}), [groupKey]: group.uploaded.filter((item) => item.referenceId !== referenceId) }, ...(groupKey === 'images' ? { referenceImages: [] } : {}) });
    updateGroup(groupKey, { referenceMediaOrder: { ...(data.referenceMediaOrder || {}), [groupKey]: group.order.filter((id) => id !== referenceId) }, ...(groupKey === 'images' ? { referenceImageOrder: [] } : {}) });
  };
  const moveReference = (groupKey: WorkflowReferenceGroup, fromId: string, toId: string) => {
    const group = referenceGroups.find((item) => item.config.key === groupKey)!; const order = group.references.map((item) => item.referenceId); const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = order.splice(from, 1); order.splice(to, 0, moved); updateGroup(groupKey, { referenceMediaOrder: { ...(data.referenceMediaOrder || {}), [groupKey]: order }, ...(groupKey === 'images' ? { referenceImageOrder: [] } : {}) });
  };
  const uploadReference = async (groupKey: WorkflowReferenceGroup, file: File) => {
    if (!canvasId || !control || !refConfig) { message.error('当前画布不可写'); return false; }
    const group = referenceGroups.find((item) => item.config.key === groupKey)!;
    if (group.references.length >= group.config.max) { message.error(`${group.config.label}最多 ${group.config.max} 个`); return false; }
    const form = new FormData(); form.append('file', file); form.append('kind', group.config.kind); form.append('canvasId', canvasId); form.append('nodeId', nodeId);
    form.append('leaseToken', control.leaseToken); form.append('leaseEpoch', String(control.leaseEpoch)); form.append('expectedRevision', String(control.expectedRevision));
    try {
      const response = await fetch('/api/comfyui/upload/media', { method: 'POST', body: form });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || '上传失败');
      const { asset } = await response.json(); const referenceId = `asset:${asset.assetId}`;
      updateGroup(groupKey, { referenceMedia: { ...(data.referenceMedia || {}), [groupKey]: [...group.uploaded, { referenceId, ...asset, kind: group.config.kind, displayName: asset.filename || file.name }] }, referenceMediaOrder: { ...(data.referenceMediaOrder || {}), [groupKey]: [...group.order.filter((id) => group.references.some((item) => item.referenceId === id)), referenceId] }, ...(groupKey === 'images' ? { referenceImages: [], referenceImageOrder: [] } : {}) });
    } catch (error: any) { message.error(error?.message || '上传失败'); }
    return false;
  };

  const upstreamAssetFor = useCallback((field: { nodeId: string; param: string }) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    return kind && kind !== 'text' ? getUpstreamAsset(nodeId, workflowInputHandle(field.nodeId, field.param, kind), kind) : null;
  }, [getUpstreamAsset, inputKinds, nodeId]);

  const upstreamTextFor = useCallback((field: { nodeId: string; param: string }) => {
    const key = `${field.nodeId}::${field.param}`;
    if (inputKinds.get(key) !== 'text') return { connected: false, text: '' };
    return getUpstreamText(nodeId, workflowInputHandle(field.nodeId, field.param, 'text'));
  }, [getUpstreamText, inputKinds, nodeId]);

  const handleRun = async () => {
    if (readOnly) { message.warning('当前为只读，需取得画布控制权后才能运行'); return; }
    if (!run.schema || !workflow) return;
    const missing = new Set<string>();
    for (const group of run.schema.groups) for (const field of group.fields) {
      const key = fileKey(field);
      if (!exposedKeys.has(key) || field.control === 'hidden' || hiddenReferenceKeys.has(key)) continue;
      const upstreamText = upstreamTextFor(field);
      const effectiveValue = upstreamText.connected ? upstreamText.text : run.formValues[key];
      if (field.required && isEmpty(effectiveValue) && !upstreamAssetFor(field)) missing.add(key);
    }
    setMissingKeys(missing);
    if (missing.size) { message.warning(`请先填写 ${missing.size} 个必填参数`); return; }
    if (refConfig && references.length === 0) { message.warning('请先添加至少一个参考素材'); return; }
    if (missingBindings.length) { message.error('提示词中存在已缺失的素材引用，请先解除或重新连接'); return; }
    const videoCount = referenceGroups.find((group) => group.config.key === 'videos')?.references.length || 0;
    const videoAudioCount = referenceGroups.find((group) => group.config.key === 'videoAudios')?.references.length || 0;
    if (videoAudioCount > videoCount) { message.error(`第 ${videoCount + 1} 路视频配音缺少对应的参考视频`); return; }
    try {
      const resolvedValues = { ...run.formValues };
      const inputAssetIds = new Set<string>();
      if (refConfig) {
        for (const group of referenceGroups) {
          for (const slot of group.config.slots) resolvedValues[`${slot.nodeId}::${slot.param}`] = '';
          for (const [index, reference] of group.references.entries()) {
            const slot = group.config.slots[index];
            if (!slot) throw new Error(`${group.config.label}超过工作流上限 ${group.config.max} 个`);
            if (reference.assetId) {
              const uploaded = await request<{ file: { name: string } }>('/api/comfyui/upload/asset', { method: 'POST', data: { canvasId, assetId: reference.assetId } });
              resolvedValues[`${slot.nodeId}::${slot.param}`] = uploaded.file.name;
              inputAssetIds.add(reference.assetId);
            } else resolvedValues[`${slot.nodeId}::${slot.param}`] = reference.filename || '';
          }
        }
        if (refConfig.promptKey) {
          let compiled = referencePrompt;
          for (const binding of activeBindings) {
            const group = referenceGroups.find((item) => item.config.key === binding.group); const index = group?.references.findIndex((item) => item.referenceId === binding.referenceId) ?? -1;
            if (group?.config.tag && index >= 0) compiled = compiled.split(binding.token).join(`<${group.config.tag} ${index + 1}>`);
          }
          resolvedValues[refConfig.promptKey] = compiled;
        }
      }
      for (const input of workflow.inputConfig?.fields ?? []) {
        if (hiddenReferenceKeys.has(`${input.nodeId}::${input.param}`)) continue;
        if (input.kind === 'text') {
          const upstreamText = upstreamTextFor(input);
          if (upstreamText.connected) {
            if (isEmpty(upstreamText.text)) throw new Error('上游文本节点尚未输出内容');
            resolvedValues[`${input.nodeId}::${input.param}`] = upstreamText.text;
          }
          continue;
        }
        const asset = upstreamAssetFor(input);
        if (!asset) {
          if (getUpstreamText(nodeId, workflowInputHandle(input.nodeId, input.param, input.kind)).connected) throw new Error('上游媒体节点尚未上传或生成内容');
          continue;
        }
        inputAssetIds.add(asset.assetId);
        const uploaded = await request<{ file: { name: string } }>('/api/comfyui/upload/asset', {
          method: 'POST', data: { canvasId, assetId: asset.assetId },
        });
        resolvedValues[`${input.nodeId}::${input.param}`] = uploaded.file.name;
      }
      const compiledApi = applyFormValues(workflow.apiJson, resolvedValues) as Record<string, any>;
      if (refConfig?.upgradeNodeId) {
        const h3Node = compiledApi[refConfig.upgradeNodeId];
        h3Node.class_type = 'MiniMaxH3ReferenceToVideo';
        h3Node.inputs['ref_images.ref_image_0'] = h3Node.inputs.first_frame;
        delete h3Node.inputs.first_frame;
        h3Node.inputs.ref_image_size ??= 'match';
      }
      await run.submit(compiledApi, new Set((workflow.inputConfig?.fields ?? []).filter(f => f.kind === 'text' && upstreamTextFor(f).connected).map(fileKey)), [...inputAssetIds], refConfig ? {
        originalPrompt: referencePrompt,
        imageReferenceMap: referenceGroups.find((group) => group.config.key === 'images')?.references.map((item, index) => ({ referenceId: item.referenceId, assetId: item.assetId || null, position: index + 1, displayName: item.displayName, token: activeBindings.find((binding) => binding.referenceId === item.referenceId)?.token || null })) || [],
        referenceMaps: Object.fromEntries(referenceGroups.map((group) => [group.config.key, group.references.map((item, index) => ({ referenceId: item.referenceId, assetId: item.assetId || null, position: index + 1, displayName: item.displayName, token: activeBindings.find((binding) => binding.referenceId === item.referenceId)?.token || null }))])),
      } : undefined);
    }
    catch (error: any) { message.error(error?.response?.data?.message || error?.message || '提交运行失败'); }
  };

  const renderInputConnector = useCallback((field: SchemaField) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    if (!kind) return null;
    const connected = kind === 'text' ? upstreamTextFor(field).connected : !!upstreamAssetFor(field);
    return <Handle type="target" position={Position.Left} id={workflowInputHandle(field.nodeId, field.param, kind)}
      className={`canvas-handle--${kind}`} style={{ left: -15, top: 18, background: connected ? '#52c41a' : undefined }}
      title={`${field.label} · ${kind} 输入${connected ? '（已连接）' : ''}`} />;
  }, [inputKinds, upstreamAssetFor, upstreamTextFor]);

  const getConnectedImage = useCallback((field: SchemaField) => {
    const asset = upstreamAssetFor(field);
    if (!asset) return null;
    return { url: asset.url, label: asset.filename || '上游媒体' };
  }, [upstreamAssetFor]);

  const getConnectedText = useCallback((field: SchemaField) => {
    const upstream = upstreamTextFor(field);
    return upstream.connected ? { text: upstream.text } : null;
  }, [upstreamTextFor]);

  const visibleRunState = run.runState ?? getNodeRunState(nodeId);
  const outputKind = workflowOutputKind(workflow?.category);
  const visibleRunning = visibleRunState?.status === 'pending' || visibleRunState?.status === 'running';
  const progress = visibleRunState?.progress;
  const percent = progress?.max ? Math.round((progress.value / progress.max) * 100) : undefined;
  const statusLabel: Record<string, string> = { pending: '排队中', running: visibleRunState?.currentNodeTitle || '生成中', success: '生成完成', error: '运行失败', interrupted: '已中断', unknown: '状态未知' };

  return <div className={`canvas-node canvas-node--txt2img${props.selected ? ' selected' : ''}${missingBindings.length ? ' canvas-node--reference-error' : ''}`}>
    <div className="canvas-node__header">
      <span className="canvas-node__type" style={{ background: workflow?.category === 'img2img' ? '#52c41a' : '#1677ff' }}>{refConfig?.groups.length === 4 ? '图生视频' : workflow?.categoryLabel || '工作流'}</span>
      <span className="canvas-node__bind" title={data.cardName || data.workflowName}>{data.cardName || data.workflowName || '未绑定工作流'}</span>
      <RunElapsed status={visibleRunState?.status} queuedAt={visibleRunState?.queuedAt} startedAt={visibleRunState?.startedAt} />
      {run.running
        ? <Button size="small" type="text" danger disabled={readOnly} icon={<PauseCircleOutlined />} className="nodrag canvas-node__run-action" aria-label="中断运行" onClick={() => void run.interrupt()} />
        : <Popconfirm title="确认运行该节点？" description="运行可能消耗 API 额度并需要一定时间。" okText="确认运行" cancelText="取消" onConfirm={() => void handleRun()}>
            <Button size="small" type="text" icon={<PlayCircleOutlined />} className="nodrag canvas-node__run-action" aria-label="运行节点" disabled={readOnly || !workflow || !!loadError || workflowLoading} loading={run.submitting} />
          </Popconfirm>}
      <Popconfirm title="删除该节点？" description="将同时移除连线及该节点生成的资产，不可撤销。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => deleteNode(nodeId)}>
        <Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" aria-label="删除节点" />
      </Popconfirm>
    </div>
    <div className="canvas-node__body canvas-node__form-body nodrag">
      <NodeCardFields name={data.cardName} note={data.note} readOnly={readOnly} onChange={(patch) => updateNodeData(nodeId, patch)} />
      {refConfig ? <>
        {referenceGroups.map(({ config, references: groupReferences }) => <div key={config.key} className="canvas-reference-group">
          <div className="canvas-reference-summary" style={{ position: 'relative' }}>
            <Handle type="target" position={Position.Left} id={workflowReferenceHandle(config.key)} className={`canvas-handle--${config.kind}`} style={{ left: -15 }} title={`${config.label}输入（最多 ${config.max} 个）`} />
            <strong>{config.label} {groupReferences.length} / {config.max}</strong>
            <Upload disabled={readOnly || groupReferences.length >= config.max} accept={`${config.kind}/*`} multiple showUploadList={false} beforeUpload={(file) => uploadReference(config.key, file)}><Button size="small" disabled={readOnly || groupReferences.length >= config.max} icon={<UploadOutlined />}>添加</Button></Upload>
          </div>
          <div className="canvas-reference-grid">{groupReferences.map((item, index) => <div key={item.referenceId} className="canvas-reference-thumb" draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData('text/reference-id', item.referenceId)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); moveReference(config.key, event.dataTransfer.getData('text/reference-id'), item.referenceId); }}>
            <button type="button" className="canvas-reference-thumb__preview" onClick={() => setReferencePreview({ group: config.key, index })} aria-label={`${config.label}第 ${index + 1} 个`}>{item.kind === 'video' ? <video src={item.url} muted playsInline preload="metadata" /> : item.kind === 'image' ? <img src={item.url} alt={item.displayName} /> : <AudioOutlined />}<span>{index + 1}</span></button>
            <button type="button" className="canvas-reference-thumb__remove" disabled={readOnly} onClick={() => removeReference(config.key, item.referenceId)} aria-label={`移除${item.displayName}`}><CloseCircleFilled /></button>
            <div title={item.displayName}>{item.displayName}</div>
          </div>)}</div>
        </div>)}
        {refConfig.promptKey ? <ImeSafeMentions autoSize={{ minRows: 3, maxRows: 8 }} value={referencePrompt} onChange={updateReferencePrompt} disabled={readOnly} placeholder="输入提示词；键入 @ 引用图片、视频或独立音频" options={referenceGroups.filter(({ config }) => !!config.tag).flatMap(({ config, references: groupReferences }) => groupReferences.map((item) => ({ key: `${config.key}:${item.referenceId}`, value: `${item.displayName.replace(/\s+/g, '_')}·${item.referenceId.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`, label: <span>{config.label} · {item.displayName}</span>, reference: item, group: config.key })))} onSelect={(option: any) => {
          const reference = option.reference; const token = `@${option.value}`;
          if (!reference || allBindings.some((item) => item.token === token)) return;
          updateNodeData(nodeId, { promptMediaReferences: [...allBindings, { referenceId: reference.referenceId, group: option.group, sourceNodeId: reference.sourceNodeId, edgeId: reference.edgeId, token, displayName: reference.displayName }], promptImageReferences: [] });
        }} /> : null}
        {missingBindings.length ? <Alert type="error" showIcon message={`缺少 ${missingBindings.length} 个提示词引用`} description={missingBindings.map((item) => item.token).join('、')} /> : null}
      </> : null}
      {!data.workflowId ? <Alert type="warning" showIcon message="未绑定工作流" />
        : workflowLoading || run.schemaLoading ? <div style={{ textAlign: 'center', padding: '16px 0' }}><Spin size="small" /><div style={{ color: '#999', marginTop: 6 }}>加载入参表单…</div></div>
        : loadError || run.schemaError ? <Alert type="warning" showIcon message={loadError || run.schemaError} description={data.lastAssets?.length ? '历史结果仍可在结果节点查看。' : undefined} />
        : <ComfySchemaForm schema={run.schema} values={run.formValues} onChange={(key, value) => { run.handleFormChange(key, value); setMissingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; }); }} disabled={readOnly || run.running} exposure={workflow?.exposureConfig ?? null} onUploadImage={readOnly ? undefined : run.uploadImage} uploading={run.uploading} scroll={false} singleColumn invalidKeys={missingKeys} renderInputConnector={renderInputConnector} getConnectedImage={getConnectedImage} getConnectedText={getConnectedText} autoRandomSeedKeys={run.autoRandomSeedKeys} onAutoRandomSeedChange={run.setAutoRandomSeed} onRandomizeSeed={run.randomizeSeed} hiddenFieldKeys={hiddenReferenceKeys} />}
      {missingKeys.size > 0 && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`还有 ${missingKeys.size} 个必填参数未填写`} />}
      {visibleRunState && <div style={{ marginTop: 8 }}>
        {visibleRunning ? <Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /> : null}
        <Tag color={visibleRunState.status === 'success' ? 'success' : visibleRunState.status === 'error' ? 'error' : visibleRunState.status === 'interrupted' ? 'warning' : 'processing'}>{statusLabel[visibleRunState.status] || visibleRunState.status}</Tag>
        {visibleRunState.error ? <div style={{ color: '#ff4d4f', marginTop: 4, wordBreak: 'break-word' }}>{visibleRunState.error}</div> : null}
      </div>}
      {(data.lastAssets ?? []).length ? <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>{(data.lastAssets ?? []).map((asset, assetIndex) => <div key={asset.assetId}><button type="button" className="canvas-media-trigger" onClick={() => setPreviewIndex(assetIndex)} aria-label={`放大预览${asset.kind === 'video' ? '视频' : '图片'}`}>{asset.kind === 'video' ? <><video src={asset.url} muted playsInline preload="metadata" /><PlayCircleFilled className="canvas-media-trigger__play" /></> : <img src={asset.url} alt={asset.filename || '生成图片'} />}</button><AssetIdLabel assetId={asset.assetId} /><Button size="small" block icon={<DownloadOutlined />} href={`/api/assets/${asset.assetId}/download`} download>下载</Button></div>)}</Space> : null}
      <NodeOutputHistory canvasId={canvasId} nodeId={nodeId} kind={outputKind} readOnly={readOnly} control={control} refreshKey={`${historyVersion}:${generationHistoryVersion}`} onSelectAsset={(asset) => updateNodeData(nodeId, { lastAssets: [asset] })} onObserveAsset={(asset) => observeNodeData(nodeId, { lastAssets: [asset] })} onRestoreSeeds={(values) => run.setFormValues((previous) => ({ ...previous, ...values }))} />
    </div>
    <CanvasMediaPreview open={previewIndex !== null} items={(data.lastAssets ?? []).filter((asset): asset is CanvasMediaItem => asset.kind === 'image' || asset.kind === 'video')} index={previewIndex ?? 0} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
    <CanvasMediaPreview open={referencePreview !== null} items={(referenceGroups.find((group) => group.config.key === referencePreview?.group)?.references || []).map((item): CanvasMediaItem => ({ assetId: item.assetId, url: item.url, kind: item.kind, filename: item.filename }))} index={referencePreview?.index ?? 0} onIndexChange={(index) => setReferencePreview((current) => current ? { ...current, index } : null)} onClose={() => setReferencePreview(null)} />
    <Handle type="source" position={Position.Right} id={resultSourceHandle(outputKind)} className={`canvas-handle--${outputKind}`} title={`${outputKind === 'video' ? '视频' : '图片'}输出`} />
  </div>;
}
