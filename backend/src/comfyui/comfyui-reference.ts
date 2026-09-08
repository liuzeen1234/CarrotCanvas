import { BadRequestException } from '@nestjs/common';
import type { SchemaAnalysis } from './comfyui-schema.service';

/** MiniMax's dynamic sockets are flattened by ComfyUI's API protocol. */
export const REFERENCE_INPUTS = [
  { prefix: 'ref_images.ref_image_', count: 9, kind: 'image', label: '参考图片' },
  { prefix: 'ref_videos.ref_video_', count: 3, kind: 'video', label: '参考视频' },
  { prefix: 'ref_video_audios.ref_video_audio_', count: 3, kind: 'audio', label: '视频配音' },
  { prefix: 'ref_audios.ref_audio_', count: 3, kind: 'audio', label: '独立参考音频' },
] as const;

/** Resolve filename-valued reference sockets before freezing the provider snapshot. */
export function prepareComfyInputs(raw: Record<string, unknown>, schema: SchemaAnalysis): Record<string, unknown> {
  const graph = JSON.parse(JSON.stringify(raw)) as Record<string, any>;
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type !== 'LoadImage' || node.inputs.image) continue;
    const consumers = Object.values(graph).flatMap(n => Object.entries(n.inputs ?? {}).filter(([,v]) => Array.isArray(v) && v[0] === id).map(([key]) => ({n,key})));
    if (consumers.length && consumers.every(({n,key}) => n.class_type === 'MiniMaxH3ReferenceToVideo' && key.startsWith('ref_images.ref_image_'))) {
      for (const {n,key} of consumers) delete n.inputs[key];
      delete graph[id];
    }
  }
  for (const group of schema.groups) for (const f of group.fields) {
    const inputs = graph[f.nodeId]?.inputs;
    if (!inputs || !(f.param in inputs) || f.control === 'hidden' || f.control === 'upload') continue;
    let value = inputs[f.param];
    if (Array.isArray(value)) continue;
    const fail = (reason: string): never => { throw new BadRequestException(`${f.label}：${reason}`); };
    if (f.valueType === 'INT' || f.valueType === 'FLOAT') {
      if (typeof value === 'string' && value.trim()) value = Number(value.trim());
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('请输入有效数字');
      if (f.valueType === 'INT' && !Number.isSafeInteger(value)) fail('请输入安全范围内的整数');
      if (f.min !== undefined && value < f.min || f.max !== undefined && value > f.max) fail('数值超出允许范围');
    } else if (f.valueType === 'BOOLEAN') {
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (['true', '1'].includes(text)) value = true;
        else if (['false', '0'].includes(text)) value = false;
      }
      if (typeof value !== 'boolean') fail('开关只接受 true / false 或 1 / 0');
    } else if (f.control === 'select' && f.options?.length) {
      const option = f.options.find(o => String(o) === String(value).trim());
      if (option === undefined) fail('值不在可选项中');
      value = option;
    }
    inputs[f.param] = value;
  }
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node.class_type !== 'MiniMaxH3ReferenceToVideo') continue;
    for (const spec of REFERENCE_INPUTS) {
      const present = (i: number) => { const v = node.inputs[`${spec.prefix}${i}`]; return v !== undefined && v !== null && v !== ''; };
      for (let i = 0; i < spec.count; i++) if (present(i)) {
        if (spec.prefix.startsWith('ref_video_audios')) {
          if (!node.inputs[`ref_videos.ref_video_${i}`]) throw new BadRequestException(`视频配音 ${i + 1} 需要对应的参考视频`);
        } else if (i > 0 && !present(i - 1)) throw new BadRequestException(`${spec.label}请从第 1 路连续填写，避免提示词参考编号错位`);
      }
    }
    for (const spec of REFERENCE_INPUTS) for (let i = 0; i < spec.count; i++) {
      const param = `${spec.prefix}${i}`;
      const value = node.inputs[param];
      if (Array.isArray(value)) continue;
      if (value === undefined || value === null || value === '') { delete node.inputs[param]; continue; }
      if (typeof value !== 'string' || !value.trim() || /(^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$))/i.test(value)) {
        throw new BadRequestException(`${spec.label} ${i + 1}：需要 ComfyUI input 目录中的文件名`);
      }
      let id = `carrot_ref_${nodeId}_${param.replace(/\W/g, '_')}`;
      while (graph[id] || graph[`${id}_components`]) id += '_';
      const filename = value.trim();
      if (spec.kind === 'video') {
        graph[id] = { class_type: 'LoadVideo', inputs: { file: filename } };
        graph[`${id}_components`] = { class_type: 'GetVideoComponents', inputs: { video: [id, 0] } };
        node.inputs[param] = [`${id}_components`, 0];
      } else {
        graph[id] = spec.kind === 'image'
          ? { class_type: 'LoadImage', inputs: { image: filename } }
          : { class_type: 'LoadAudio', inputs: { audio: filename } };
        node.inputs[param] = [id, 0];
      }
    }
  }
  return graph;
}
