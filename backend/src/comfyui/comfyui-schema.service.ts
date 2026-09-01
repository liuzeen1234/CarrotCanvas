import { Injectable } from '@nestjs/common';

/**
 * 步骤④：schema 分析服务。
 *
 * 把已入库工作流的 apiJson 结合 ComfyUI /object_info 的节点定义，
 * 分析每个节点的「可编辑入参」（无上游连接的 widget 参数），
 * 输出表单描述（param / type / default / constraints / control），供前端动态渲染表单。
 *
 * 跳过规则：
 *  - 上游连接输入（值形如 ["nodeId", idx]）→ 不暴露；
 *  - null 值（占位，如 ImageConcatMulti 的 "Update inputs"）→ 不暴露；
 *  - 不在 object_info 中定义的参数（官方前端注入字段，如 LoadImage 的 "upload"）→ 不暴露；
 *  - MODEL / CLIP / LATENT / CONDITIONING 等类型的裸值 → 标记 hidden（正常应由连接提供）。
 */

export type SchemaControl =
  | 'input_number'
  | 'slider'
  | 'textarea'
  | 'input'
  | 'select'
  | 'switch'
  | 'upload'
  | 'hidden';

export interface SchemaField {
  /** 节点 id（apiJson 的 key，可能是 "78:34" 这类子图节点） */
  nodeId: string;
  /** 节点显示名（来自 apiJson 的 _meta.title，缺省为 nodeId） */
  nodeTitle: string;
  classType: string;
  /** 参数名（写入位置：apiJson[nodeId].inputs[param]） */
  param: string;
  label: string;
  control: SchemaControl;
  valueType: string;
  /** 当前 apiJson 中的值（作为表单初值） */
  current: unknown;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** COMBO 选项 */
  options?: (string | number)[];
  multiline?: boolean;
  imageUpload?: boolean;
}

export interface SchemaNodeGroup {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  fields: SchemaField[];
}

export interface SchemaAnalysis {
  ok: boolean;
  source: 'object_info' | 'fallback';
  groups: SchemaNodeGroup[];
  warnings: string[];
  error?: string;
  nodeCount: number;
  editableCount: number;
  totalFieldCount: number;
}

/** object_info 中单个参数定义：[类型或COMBO选项数组, 元信息] */
type InputDef = [unknown, Record<string, unknown>];

@Injectable()
export class ComfyUISchemaService {
  analyze(
    apiJson: Record<string, unknown>,
    objectInfo: Record<string, unknown>,
  ): SchemaAnalysis {
    const warnings: string[] = [];
    const groups: SchemaNodeGroup[] = [];
    let editableCount = 0;
    let totalFieldCount = 0;

    const entries = Object.entries(apiJson);
    for (const [nodeId, node] of entries) {
      const n = node as {
        class_type?: string;
        inputs?: Record<string, unknown>;
        _meta?: { title?: string };
      };
      const classType = n.class_type ?? '';
      const nodeTitle = n._meta?.title ?? nodeId;
      const def = objectInfo?.[classType] as
        | { input?: Record<string, unknown> }
        | undefined;
      if (!def?.input) {
        warnings.push(
          `节点 ${classType || nodeId} 未在 /object_info 中找到定义，其参数不可自动编辑`,
        );
        continue;
      }

      const inputDefs = this.collectInputDefs(def.input);
      const fields: SchemaField[] = [];
      for (const [param, value] of Object.entries(n.inputs ?? {})) {
        if (value === null) continue; // 占位 null，跳过
        if (this.isConnection(value)) continue; // 上游连接，跳过
        const pdef = inputDefs.get(param);
        if (!pdef) continue; // schema 未定义（前端注入字段），静默跳过
        totalFieldCount++;
        const field = this.buildField(
          nodeId,
          nodeTitle,
          classType,
          param,
          value,
          pdef,
        );
        if (field) {
          fields.push(field);
          if (field.control !== 'hidden') editableCount++;
        }
      }

      if (fields.length) {
        groups.push({ nodeId, nodeTitle, classType, fields });
      }
    }

    const ok = groups.length > 0;
    return {
      ok,
      source: 'object_info',
      groups,
      warnings,
      nodeCount: entries.length,
      editableCount,
      totalFieldCount,
      ...(ok
        ? {}
        : {
            error:
              '未能从工作流中解析出可编辑参数，请切换到 JSON 模式直接编辑',
          }),
    };
  }

  /** 汇总 required + optional 的参数定义 */
  private collectInputDefs(input: Record<string, unknown>): Map<string, InputDef> {
    const map = new Map<string, InputDef>();
    for (const section of ['required', 'optional']) {
      const obj = input[section] as Record<string, unknown> | undefined;
      if (!obj) continue;
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && v.length >= 1) {
          const meta =
            v[1] && typeof v[1] === 'object'
              ? (v[1] as Record<string, unknown>)
              : {};
          map.set(k, [v[0], meta]);
        }
      }
    }
    return map;
  }

  /** 连接输入：值形如 ["nodeId", outputIndex] */
  private isConnection(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return (
      value.length >= 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'number'
    );
  }

  private buildField(
    nodeId: string,
    nodeTitle: string,
    classType: string,
    param: string,
    value: unknown,
    def: InputDef,
  ): SchemaField | null {
    const [typeOrCombo, meta] = def;
    const common: Omit<SchemaField, 'control' | 'valueType'> = {
      nodeId,
      nodeTitle,
      classType,
      param,
      label: param,
      current: value,
      default: meta.default,
    };

    if (Array.isArray(typeOrCombo)) {
      // COMBO 枚举
      const options = typeOrCombo as (string | number)[];
      if (meta.image_upload) {
        return {
          ...common,
          control: 'upload',
          valueType: 'COMBO',
          options,
          imageUpload: true,
        };
      }
      return { ...common, control: 'select', valueType: 'COMBO', options };
    }

    const type = String(typeOrCombo);
    switch (type) {
      case 'INT':
      case 'FLOAT': {
        const min = typeof meta.min === 'number' ? meta.min : undefined;
        const max = typeof meta.max === 'number' ? meta.max : undefined;
        const step =
          typeof meta.step === 'number'
            ? meta.step
            : type === 'FLOAT'
              ? 0.01
              : 1;
        return {
          ...common,
          control: 'input_number',
          valueType: type,
          min,
          max,
          step,
        };
      }
      case 'STRING':
        return {
          ...common,
          control: meta.multiline ? 'textarea' : 'input',
          valueType: 'STRING',
          multiline: !!meta.multiline,
        };
      case 'BOOLEAN':
        return { ...common, control: 'switch', valueType: 'BOOLEAN' };
      case 'IMAGE':
        return {
          ...common,
          control: 'upload',
          valueType: 'IMAGE',
          imageUpload: true,
          options: [],
        };
      default:
        // MODEL/CLIP/LATENT/CONDITIONING 等：正常应由上游连接提供，裸值则隐藏
        return { ...common, control: 'hidden', valueType: type };
    }
  }
}
