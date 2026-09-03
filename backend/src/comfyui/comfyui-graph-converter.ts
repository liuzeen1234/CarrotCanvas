import { ComfyUIValidator } from '../workflows/comfyui-validator';

export interface ComfyUINode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ApiWorkflow = Record<string, ComfyUINode>;

export interface ConversionResult {
  ok: boolean;
  apiJson?: ApiWorkflow;
  /** 致命错误（转换失败原因） */
  errors: string[];
  /** 非致命告警（缺失节点类型等） */
  warnings: string[];
  nodeCount: number;
}

interface InnerLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
}

interface SubgraphDef {
  id: string;
  name?: string;
  nodes?: Record<string, unknown>[];
  links?: InnerLink[];
  inputs?: { name?: string; type?: string; linkIds?: number[] }[];
  outputs?: { name?: string; type?: string; linkIds?: number[] }[];
  definitions?: { subgraphs?: SubgraphDef[] };
}

interface ConvertContext {
  objectInfo: Record<string, unknown>;
  /** 主图 nodesById（String id → node） */
  mainNodes: Map<string, Record<string, unknown>>;
  mainLinks: Map<number, number[]>;
  /** 全部子图定义（按 id） */
  subgraphs: Map<string, SubgraphDef>;
  errors: string[];
  warnings: string[];
  /** 已产出的节点（用于清理悬空连接） */
  output: ApiWorkflow;
}

/**
 * 复刻 ComfyUI 官方前端 graphToPrompt() 的 UI→API 转换算法，并额外支持：
 * - Reroute 等虚拟节点穿透到真实上游；
 * - 子图（subgraph）节点展开为内部节点（内部 ID 前缀 `<子图节点id>:`），
 *   与官方前端导出一致（如 "78:5"）。
 *
 * 输入：ComfyUI 保存的 UI 格式工作流 JSON（顶层 nodes/links/definitions）。
 * 输出：可直接提交 /prompt 的 API 格式 { nodeId: { inputs, class_type, _meta } }。
 */
export class ComfyUIGraphConverter {
  private static readonly MODE_NEVER = 2;
  private static readonly MODE_BYPASS = 3;
  /** 仅用于画布展示、不应进入 /prompt 的前端虚拟节点。 */
  private static readonly VIRTUAL_NODE_TYPES = new Set(['Reroute', 'MarkdownNote']);
  private static readonly INPUT_NODE_ID = -10;
  private static readonly OUTPUT_NODE_ID = -20;

  static convert(
    uiJson: unknown,
    objectInfo: Record<string, unknown>,
  ): ConversionResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!uiJson || typeof uiJson !== 'object' || Array.isArray(uiJson)) {
      return { ok: false, errors: ['工作流内容不是有效对象，可能不是 UI 格式'], warnings, nodeCount: 0 };
    }
    const root = uiJson as Record<string, unknown>;
    if (!Array.isArray(root.nodes)) {
      return { ok: false, errors: ['工作流 JSON 缺少 nodes 数组，请确认是 ComfyUI 保存的工作流格式'], warnings, nodeCount: 0 };
    }

    const mainNodes = new Map<string, Record<string, unknown>>();
    for (const node of root.nodes) {
      if (node && typeof node === 'object') {
        const n = node as Record<string, unknown>;
        mainNodes.set(String(n.id), n);
      }
    }

    const mainLinks = new Map<number, number[]>();
    if (Array.isArray(root.links)) {
      for (const link of root.links) {
        if (Array.isArray(link) && link.length >= 5 && typeof link[0] === 'number') {
          mainLinks.set(link[0], link as number[]);
        }
      }
    }

    const subgraphs = new Map<string, SubgraphDef>();
    const collectSubgraphs = (defs: unknown) => {
      if (!defs || typeof defs !== 'object') return;
      const arr = (defs as { subgraphs?: SubgraphDef[] }).subgraphs;
      if (!Array.isArray(arr)) return;
      for (const sg of arr) {
        if (!sg || typeof sg !== 'object') continue;
        subgraphs.set(sg.id, sg);
        collectSubgraphs(sg.definitions);
      }
    };
    collectSubgraphs(root.definitions);

    const ctx: ConvertContext = {
      objectInfo,
      mainNodes,
      mainLinks,
      subgraphs,
      errors,
      warnings,
      output: {},
    };

    for (const node of root.nodes) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      if (n.mode === this.MODE_NEVER || n.mode === this.MODE_BYPASS) continue;

      const classType = typeof n.type === 'string' ? n.type : '';
      const nodeLabel = n.title ?? n.id ?? classType;
      if (!classType) {
        errors.push(`节点 ${nodeLabel} 缺少 type`);
        continue;
      }

      if (this.VIRTUAL_NODE_TYPES.has(classType)) continue;

      const sg = subgraphs.get(classType);
      if (sg) {
        this.flattenSubgraph(n, sg, ctx);
        continue;
      }

      this.convertNode(n, ctx);
    }

    // 清理引用已移除节点的连接
    for (const node of Object.values(ctx.output)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && !ctx.output[String(value[0])]) {
          delete node.inputs[name];
        }
      }
    }

    const nodeCount = Object.keys(ctx.output).length;
    if (nodeCount === 0) {
      return { ok: false, errors: ['没有可转换的节点（全部为空或被跳过）'], warnings, nodeCount };
    }

    const structureErrors = ComfyUIValidator.validate(ctx.output);
    if (structureErrors.length) {
      return { ok: false, errors: structureErrors, warnings, nodeCount };
    }

    return { ok: true, apiJson: ctx.output, errors, warnings, nodeCount };
  }

  // ---------- 普通节点 ----------

  private static convertNode(n: Record<string, unknown>, ctx: ConvertContext): void {
    const classType = typeof n.type === 'string' ? n.type : '';
    const nodeLabel = n.title ?? n.id ?? classType;
    const nodeDef = (ctx.objectInfo[classType] as Record<string, unknown> | undefined) ?? null;
    if (!nodeDef) {
      ctx.warnings.push(`节点“${nodeLabel}”（${classType}）不在 ComfyUI /object_info 中，运行前需确认该自定义节点已加载`);
    }

    const inputs: Record<string, unknown> = {};

    const widgetValues = this.resolveWidgetValues(n, nodeDef);
    for (const [name, value] of Object.entries(widgetValues)) {
      if (value === undefined || value === null) continue;
      inputs[name] = Array.isArray(value) ? { __value__: value } : value;
    }

    const nodeInputs = Array.isArray(n.inputs) ? (n.inputs as Record<string, unknown>[]) : [];
    for (const input of nodeInputs) {
      if (!input || typeof input !== 'object') continue;
      const name = input.name;
      if (typeof name !== 'string' || !name) continue;
      const linkId = input.link;
      if (linkId === null || linkId === undefined) continue;
      const link = ctx.mainLinks.get(Number(linkId));
      if (!link) continue;
      const origin = this.resolveMain(link[1], link[2], ctx);
      if (!origin) continue;
      inputs[name] = [String(origin[0]), Number(origin[1])];
    }

    ctx.output[String(n.id)] = {
      inputs,
      class_type: classType,
      _meta: { title: typeof n.title === 'string' && n.title ? n.title : classType },
    };
  }

  // ---------- 子图展开 ----------

  private static flattenSubgraph(
    subgraphNode: Record<string, unknown>,
    sg: SubgraphDef,
    ctx: ConvertContext,
  ): void {
    const sgNodes = new Map<string, Record<string, unknown>>();
    for (const node of sg.nodes ?? []) {
      if (node && typeof node === 'object') {
        sgNodes.set(String((node as Record<string, unknown>).id), node as Record<string, unknown>);
      }
    }
    const sgLinks = new Map<number, InnerLink>();
    for (const link of sg.links ?? []) {
      if (link && typeof link === 'object' && link.id !== undefined) {
        sgLinks.set(link.id, link);
      }
    }
    const sgInputPorts = sg.inputs ?? [];
    const sgOutputPorts = sg.outputs ?? [];
    const prefix = `${String(subgraphNode.id)}:`;
    const newId = (innerId: number | string) => `${prefix}${innerId}`;

    for (const innerNode of sg.nodes ?? []) {
      if (!innerNode || typeof innerNode !== 'object') continue;
      const node = innerNode as Record<string, unknown>;
      if (node.mode === this.MODE_NEVER || node.mode === this.MODE_BYPASS) continue;

      const classType = typeof node.type === 'string' ? node.type : '';
      const nodeLabel = node.title ?? node.id ?? classType;
      if (!classType) {
        ctx.errors.push(`子图内节点 ${nodeLabel} 缺少 type`);
        continue;
      }
      if (this.VIRTUAL_NODE_TYPES.has(classType)) continue;

      const nodeDef = (ctx.objectInfo[classType] as Record<string, unknown> | undefined) ?? null;
      if (!nodeDef) {
        ctx.warnings.push(`节点“${nodeLabel}”（${classType}）不在 ComfyUI /object_info 中，运行前需确认该自定义节点已加载`);
      }

      const inputs: Record<string, unknown> = {};
      const widgetValues = this.resolveWidgetValues(node, nodeDef);
      for (const [name, value] of Object.entries(widgetValues)) {
        if (value === undefined || value === null) continue;
        inputs[name] = Array.isArray(value) ? { __value__: value } : value;
      }

      const nodeInputs = Array.isArray(node.inputs) ? (node.inputs as Record<string, unknown>[]) : [];
      for (const input of nodeInputs) {
        if (!input || typeof input !== 'object') continue;
        const name = input.name;
        if (typeof name !== 'string' || !name) continue;
        const linkId = input.link;
        if (linkId === null || linkId === undefined) continue;
        const link = sgLinks.get(Number(linkId));
        if (!link) continue;

        const resolved = this.resolveSubgraphOrigin(link, subgraphNode, sg, sgNodes, sgLinks, sgInputPorts, ctx);
        if (!resolved) continue;
        if (resolved.kind === 'widget') {
          inputs[name] = Array.isArray(resolved.value) ? { __value__: resolved.value } : resolved.value;
        } else {
          inputs[name] = [String(resolved.nodeId), Number(resolved.slot)];
        }
      }

      ctx.output[newId(String(node.id))] = {
        inputs,
        class_type: classType,
        _meta: { title: typeof node.title === 'string' && node.title ? node.title : classType },
      };
    }
  }

  /**
   * 解析子图内一条链接的 origin：
   * - 子图 inputNode(-10)：映射到子图节点的外部输入（连接穿透或 widget 值）；
   * - 子图内普通节点/内层 Reroute：在子图层内穿透后返回内部节点 ID（含前缀）。
   */
  private static resolveSubgraphOrigin(
    link: InnerLink,
    subgraphNode: Record<string, unknown>,
    sg: SubgraphDef,
    sgNodes: Map<string, Record<string, unknown>>,
    sgLinks: Map<number, InnerLink>,
    sgInputPorts: { name?: string; type?: string; linkIds?: number[] }[],
    ctx: ConvertContext,
  ):
    | { kind: 'node'; nodeId: string; slot: number }
    | { kind: 'widget'; value: unknown }
    | null {
    let originId = link.origin_id;
    let originSlot = link.origin_slot;
    let guard = 0;
    while (guard++ < 100) {
      if (originId === this.INPUT_NODE_ID) {
        // 子图输入端口 → 子图节点的外部输入
        const port = sgInputPorts[originSlot];
        if (!port?.name) return null;
        const ext = this.findSubgraphExternalInput(subgraphNode, port.name);
        if (!ext) return null;
        if (ext.link !== null && ext.link !== undefined) {
          const mainLink = ctx.mainLinks.get(Number(ext.link));
          if (!mainLink) return null;
          const origin = this.resolveMain(mainLink[1], mainLink[2], ctx);
          if (!origin) return null;
          return { kind: 'node', nodeId: origin[0], slot: origin[1] };
        }
        // 外部 widget 值（如 unet_name/clip_name/...）
        const wv = this.getNamedWidgetValue(subgraphNode, port.name);
        return { kind: 'widget', value: wv };
      }

      const node = sgNodes.get(String(originId));
      if (!node) return null;
      const type = typeof node.type === 'string' ? node.type : '';
      if (!this.VIRTUAL_NODE_TYPES.has(type)) {
        return { kind: 'node', nodeId: `${String(subgraphNode.id)}:${originId}`, slot: originSlot };
      }
      // 内层 Reroute 穿透
      const inputs = Array.isArray(node.inputs) ? (node.inputs as Record<string, unknown>[]) : [];
      const inLinkId = inputs[0]?.link;
      if (inLinkId === null || inLinkId === undefined) return null;
      const inLink = sgLinks.get(Number(inLinkId));
      if (!inLink) return null;
      originId = inLink.origin_id;
      originSlot = inLink.origin_slot;
    }
    return null;
  }

  private static findSubgraphExternalInput(
    subgraphNode: Record<string, unknown>,
    portName: string,
  ): Record<string, unknown> | null {
    const inputs = Array.isArray(subgraphNode.inputs) ? (subgraphNode.inputs as Record<string, unknown>[]) : [];
    const found = inputs.find((i) => i && i.name === portName);
    return found ?? null;
  }

  // ---------- 主图连接解析（Reroute 穿透 + 子图输出跟随） ----------

  /**
   * 解析主图连接 origin：
   * - Reroute 虚拟节点 → 沿输入链接穿透；
   * - 子图节点输出 → 跟随子图输出端口到内部节点。
   */
  private static resolveMain(
    originId: number,
    originSlot: number,
    ctx: ConvertContext,
  ): [string, number] | null {
    let currentId = originId;
    let currentSlot = originSlot;
    let guard = 0;
    while (guard++ < 100) {
      const node = ctx.mainNodes.get(String(currentId));
      if (!node) return null;
      const type = typeof node.type === 'string' ? node.type : '';

      if (this.VIRTUAL_NODE_TYPES.has(type)) {
        const inputs = Array.isArray(node.inputs) ? (node.inputs as Record<string, unknown>[]) : [];
        const inLinkId = inputs[0]?.link;
        if (inLinkId === null || inLinkId === undefined) return null;
        const link = ctx.mainLinks.get(Number(inLinkId));
        if (!link) return null;
        currentId = link[1];
        currentSlot = link[2];
        continue;
      }

      const sg = ctx.subgraphs.get(type);
      if (sg) {
        // 子图节点输出 → 找到输出端口对应内部节点
        const port = (sg.outputs ?? [])[currentSlot];
        if (!port?.linkIds?.length) return null;
        const outLinkId = port.linkIds[0];
        // 查找指向 outputNode(-20) 且 id 匹配的链接
        const innerLink = this.findOutputLink(sg, outLinkId);
        if (!innerLink) return null;
        const innerResolved = this.resolveInnerInSubgraph(
          innerLink.origin_id,
          innerLink.origin_slot,
          sg,
          `${String(currentId)}:`,
        );
        if (!innerResolved) return null;
        return innerResolved;
      }

      return [String(currentId), currentSlot];
    }
    return null;
  }

  /** 在子图内解析 origin（含内层 Reroute 穿透），返回带前缀的最终节点 */
  private static resolveInnerInSubgraph(
    originId: number,
    originSlot: number,
    sg: SubgraphDef,
    prefix: string,
  ): [string, number] | null {
    const sgNodes = new Map<string, Record<string, unknown>>();
    for (const node of sg.nodes ?? []) {
      if (node && typeof node === 'object') {
        sgNodes.set(String((node as Record<string, unknown>).id), node as Record<string, unknown>);
      }
    }
    const sgLinks = new Map<number, InnerLink>();
    for (const link of sg.links ?? []) {
      if (link && typeof link === 'object' && link.id !== undefined) sgLinks.set(link.id, link);
    }
    let currentId = originId;
    let currentSlot = originSlot;
    let guard = 0;
    while (guard++ < 100) {
      if (currentId === this.INPUT_NODE_ID || currentId === this.OUTPUT_NODE_ID) return null;
      const node = sgNodes.get(String(currentId));
      if (!node) return null;
      const type = typeof node.type === 'string' ? node.type : '';
      if (!this.VIRTUAL_NODE_TYPES.has(type)) {
        return [`${prefix}${currentId}`, currentSlot];
      }
      const inputs = Array.isArray(node.inputs) ? (node.inputs as Record<string, unknown>[]) : [];
      const inLinkId = inputs[0]?.link;
      if (inLinkId === null || inLinkId === undefined) return null;
      const link = sgLinks.get(Number(inLinkId));
      if (!link) return null;
      currentId = link.origin_id;
      currentSlot = link.origin_slot;
    }
    return null;
  }

  private static findOutputLink(sg: SubgraphDef, linkId: number): InnerLink | null {
    for (const link of sg.links ?? []) {
      if (link && typeof link === 'object' && link.id === linkId) return link;
    }
    return null;
  }

  // ---------- widget 解析 ----------

  private static resolveWidgetValues(
    node: Record<string, unknown>,
    nodeDef: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const named = node.widgets_values_named;
    if (named && typeof named === 'object' && !Array.isArray(named)) {
      for (const [k, v] of Object.entries(named)) {
        if (this.isSkippedWidgetName(k)) continue;
        out[k] = v;
      }
      return out;
    }

    if (!Array.isArray(node.widgets_values)) return out;
    const values = [...(node.widgets_values as unknown[])];
    const widgetInputs = this.collectWidgetInputs(nodeDef);
    let idx = 0;
    for (const wi of widgetInputs) {
      if (idx >= values.length) break;
      out[wi.name] = values[idx++];
      if (wi.controlAfter) idx++;
    }
    return out;
  }

  private static getNamedWidgetValue(
    node: Record<string, unknown>,
    name: string,
  ): unknown {
    const named = node.widgets_values_named;
    if (named && typeof named === 'object' && !Array.isArray(named) && name in named) {
      return (named as Record<string, unknown>)[name];
    }
    return undefined;
  }

  /** 不进入 API prompt 的 widget 名（control_after_generate 等） */
  private static isSkippedWidgetName(name: string): boolean {
    return name === 'control_after_generate';
  }

  private static collectWidgetInputs(
    nodeDef: Record<string, unknown> | null,
  ): { name: string; controlAfter: boolean }[] {
    const result: { name: string; controlAfter: boolean }[] = [];
    if (!nodeDef) return result;
    const inputDef = nodeDef.input as Record<string, unknown> | undefined;
    if (!inputDef || typeof inputDef !== 'object') return result;

    const collect = (defs: unknown) => {
      if (!defs || typeof defs !== 'object') return;
      for (const [name, spec] of Object.entries(defs as Record<string, unknown>)) {
        if (!Array.isArray(spec) || spec.length === 0) continue;
        const type = spec[0];
        const opts = (spec[1] as Record<string, unknown> | undefined) ?? {};
        if (!this.isWidgetType(type)) continue;
        if (opts.forceInput) continue;
        result.push({ name, controlAfter: !!opts.control_after_generate });
      }
    };

    collect((inputDef.required as unknown) ?? {});
    collect((inputDef.optional as unknown) ?? {});
    return result;
  }

  private static isWidgetType(type: unknown): boolean {
    if (Array.isArray(type)) return true;
    if (typeof type !== 'string') return false;
    const up = type.toUpperCase();
    return (
      up === 'INT' ||
      up === 'FLOAT' ||
      up === 'STRING' ||
      up === 'BOOLEAN' ||
      up.endsWith('_STRING') ||
      up.startsWith('COMBO') ||
      up === 'SEED'
    );
  }
}
