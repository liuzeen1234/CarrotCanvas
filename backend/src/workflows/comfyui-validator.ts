export interface ComfyUINode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export interface ApiWorkflow {
  [nodeId: string]: ComfyUINode;
}

export class ComfyUIValidator {
  /**
   * Validate that `value` is a valid ComfyUI API-format workflow JSON.
   * The API format maps node-id strings to { class_type, inputs } objects.
   * Returns an array of human-readable error messages (empty = valid).
   */
  static validate(value: unknown): string[] {
    if (value === null || value === undefined) {
      return ['内容为空'];
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return ['顶层必须是包含节点对象的 JSON 对象'];
    }

    const root = value as Record<string, unknown>;
    const entries = Object.entries(root);

    if (entries.length === 0) {
      return ['未包含任何节点'];
    }

    const errors: string[] = [];

    for (const [nodeId, node] of entries) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        errors.push(`节点“${nodeId}”不是有效对象`);
        continue;
      }
      const n = node as Record<string, unknown>;
      if (typeof n.class_type !== 'string' || n.class_type.length === 0) {
        errors.push(`节点“${nodeId}”缺少有效的 class_type`);
      }
      if (typeof n.inputs !== 'object' || n.inputs === null || Array.isArray(n.inputs)) {
        errors.push(`节点“${nodeId}”缺少有效的 inputs`);
      }
    }

    return errors;
  }

  static parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: `JSON 解析失败：${(e as Error).message}` };
    }
  }
}
