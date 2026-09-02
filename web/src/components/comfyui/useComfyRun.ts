/**
 * CarrotCanvas 共享 ComfyUI 运行状态机钩子（C4 抽取）。
 * 封装：schema 加载（按 workflowId 缓存）、表单值初始化、form/json 切换、
 * 提交 + 轮询 + 中断、图片上传、输出下载。
 * 设置页运行面板（ComfyRunModal）与画布生成节点（C5/C6）共用同一份。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from 'umi';
import {
  ComfyUIAPI,
  RunMode,
  RunStateData,
  SchemaAnalysis,
  SchemaField,
  TERMINAL_RUN_STATUS,
  applyFormValues,
  fileKey,
} from './types';

/** schema 按 workflowId 缓存，避免重复请求 /object_info 分析；编辑/导入变更后调用 clearSchemaCache 失效 */
const schemaCache = new Map<string, SchemaAnalysis>();

export const clearSchemaCache = (workflowId?: string) => {
  if (workflowId) schemaCache.delete(workflowId);
  else schemaCache.clear();
};

export interface UseComfyRunArgs {
  /** 当前绑定的工作流；为 null 时保持空闲。提交以最新传入值为准 */
  workflow: ComfyUIAPI | null;
  /** 画布运行上下文（可选）：画布节点发起时携带，运行成功触发资产捕获；工具箱运行不传 */
  canvas?: { canvasId?: string; nodeId?: string };
  /** schema 初始化完成后回调（画布节点用于恢复持久化表单值） */
  onSchemaReady?: (schema: SchemaAnalysis, setValues: (v: Record<string, unknown>) => void) => void;
  /** 提交成功（拿到 promptId，可能仍在排队/运行）后回调 */
  onRunStarted?: (run: RunStateData) => void;
  /** 运行进入终态（success/error/interrupted/unknown）后回调 */
  onRunFinished?: (run: RunStateData) => void;
}

export function useComfyRun(args: UseComfyRunArgs) {
  const { workflow, canvas } = args;

  // 回调最新值（避免轮询闭包持有过期回调）
  const onSchemaReadyRef = useRef(args.onSchemaReady);
  onSchemaReadyRef.current = args.onSchemaReady;
  const onRunStartedRef = useRef(args.onRunStarted);
  onRunStartedRef.current = args.onRunStarted;
  const onRunFinishedRef = useRef(args.onRunFinished);
  onRunFinishedRef.current = args.onRunFinished;

  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  const [schema, setSchema] = useState<SchemaAnalysis | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [mode, setModeState] = useState<RunMode>('form');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunStateData | null>(null);
  const [runPolling, setRunPolling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** init 序号，防止并发 init 的旧响应覆盖新状态 */
  const initSeq = useRef(0);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setRunPolling(false);
  }, []);

  const stopPollingIfFinished = useCallback(
    (run: RunStateData | null) => {
      if (!run) return;
      if ((TERMINAL_RUN_STATUS as readonly string[]).includes(run.status)) {
        clearPoll();
        onRunFinishedRef.current?.(run);
      }
    },
    [clearPoll],
  );

  /** 加载（或命中缓存）工作流 schema 并初始化表单值。由使用方在“打开/绑定”时显式调用。 */
  const init = useCallback(
    async (w: ComfyUIAPI, initialValues?: Record<string, unknown>) => {
      const seq = ++initSeq.current;
      clearPoll();
      setRunState(null);
      setSubmitting(false);
      setSchema(null);
      setSchemaError(null);
      setFormError(null);
      setModeState('form');
      setJsonText(JSON.stringify(w.apiJson, null, 2));
      setSchemaLoading(true);
      try {
        const cached = schemaCache.get(w.id);
        const data = cached
          ? { schema: cached }
          : await request<{ schema: SchemaAnalysis }>(`/api/comfyui/workflows/${w.id}/schema`);
        if (!cached) schemaCache.set(w.id, data.schema);
        if (seq !== initSeq.current) return; // 已被更新的 init 覆盖
        setSchema(data.schema);
        const initVals: Record<string, unknown> = {};
        for (const g of data.schema.groups) {
          for (const f of g.fields) {
            if (f.control === 'hidden') continue;
            initVals[fileKey(f)] = f.current;
          }
        }
        const merged = initialValues ? { ...initVals, ...initialValues } : initVals;
        setFormValues(merged);
        onSchemaReadyRef.current?.(data.schema, setFormValues);
      } catch (e: any) {
        if (seq !== initSeq.current) return;
        setSchema(null);
        setSchemaError(`自动表单加载失败：${e?.response?.data?.message || '未知错误'}`);
        setModeState('json');
      } finally {
        if (seq === initSeq.current) setSchemaLoading(false);
      }
    },
    [clearPoll],
  );

  // 卸载时清理轮询
  useEffect(() => () => clearPoll(), [clearPoll]);

  const setFieldValue = useCallback((f: SchemaField, v: unknown) => {
    setFormValues((prev) => ({ ...prev, [fileKey(f)]: v }));
  }, []);

  /** 通用表单值写入（key=`${nodeId}::${param}`），ComfySchemaForm 用 */
  const handleFormChange = useCallback((key: string, value: unknown) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const appendUploadOption = useCallback((f: SchemaField, name: string) => {
    setSchema((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        groups: prev.groups.map((g) => ({
          ...g,
          fields: g.fields.map((field) =>
            field.nodeId === f.nodeId && field.param === f.param
              ? { ...field, options: [...(field.options ?? []), name] }
              : field,
          ),
        })),
      };
    });
  }, []);

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  /** 上传图片到 ComfyUI input 目录，成功后写回字段值并加入下拉选项，返回上传后的文件名 */
  const uploadImage = useCallback(
    async (f: SchemaField, file: File): Promise<string> => {
      const dataBase64 = await fileToBase64(file);
      setUploading(true);
      try {
        const res = await request<{ file: { name: string } }>('/api/comfyui/upload/image', {
          method: 'POST',
          data: { filename: file.name, dataBase64 },
        });
        setFieldValue(f, res.file.name);
        appendUploadOption(f, res.file.name);
        return res.file.name;
      } finally {
        setUploading(false);
      }
    },
    [appendUploadOption, setFieldValue],
  );

  /** 切换 表单/JSON 模式，保持两边内容一致 */
  const setMode = (m: RunMode) => {
    const w = workflowRef.current;
    if (m === 'json') {
      setJsonText(JSON.stringify(applyFormValues(w?.apiJson, formValues), null, 2));
    } else {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, any>;
        if (schema) {
          const vals: Record<string, unknown> = {};
          for (const g of schema.groups) {
            for (const f of g.fields) {
              if (f.control === 'hidden') continue;
              const node = parsed[f.nodeId];
              vals[fileKey(f)] = node?.inputs?.[f.param];
            }
          }
          setFormValues(vals);
        }
      } catch {
        // JSON 解析失败，保留当前表单值
      }
    }
    setModeState(m);
  };

  /**
   * 提交运行。
   * - 传入 apiJsonOverride 时直接使用（画布节点可在其内注入提示词连线值）；
   * - 否则按当前模式（form 值级写回 / JSON 文本）组装。
   * 返回 false 表示参数解析失败（formError 已设置），否则提交成功（异常时 throw）。
   */
  const submit = async (apiJsonOverride?: unknown): Promise<boolean> => {
    const w = workflowRef.current;
    if (!w) return false;
    let apiJson: unknown;
    try {
      if (apiJsonOverride !== undefined) {
        apiJson = apiJsonOverride;
      } else if (mode === 'json') {
        apiJson = JSON.parse(jsonText);
      } else {
        apiJson = applyFormValues(w.apiJson, formValues);
      }
    } catch (e: any) {
      setFormError(e?.message || 'JSON 格式错误');
      return false;
    }
    clearPoll();
    setRunState(null);
    setSubmitting(true);
    try {
      const data = await request<{ run: RunStateData }>('/api/comfyui/runs', {
        method: 'POST',
        data: {
          workflowId: w.id,
          apiJson,
          canvasId: canvasRef.current?.canvasId,
          nodeId: canvasRef.current?.nodeId,
        },
      });
      setRunState(data.run);
      onRunStartedRef.current?.(data.run);
      if ((TERMINAL_RUN_STATUS as readonly string[]).includes(data.run.status)) {
        clearPoll();
        onRunFinishedRef.current?.(data.run);
        return true;
      }
      setRunPolling(true);
      pollRef.current = setInterval(async () => {
        try {
          const res = await request<{ run: RunStateData | null }>(
            `/api/comfyui/runs/${data.run.promptId}`,
          );
          setRunState(res.run);
          if (!res.run) return;
          if ((TERMINAL_RUN_STATUS as readonly string[]).includes(res.run.status)) {
            clearPoll();
            onRunFinishedRef.current?.(res.run);
          }
        } catch {
          // 网络抖动，继续轮询
        }
      }, 1500);
      return true;
    } catch (e) {
      setSubmitting(false);
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const interrupt = async () => {
    const run = runState;
    if (!run) return;
    await request(`/api/comfyui/runs/${run.promptId}/interrupt`, { method: 'POST' });
  };

  /** 重置运行态（关闭面板 / 节点卸载时调用） */
  const reset = useCallback(() => {
    initSeq.current += 1;
    clearPoll();
    setRunState(null);
    setSubmitting(false);
  }, [clearPoll]);

  /** 下载输出文件到本地 */
  const downloadOutput = async (o: RunStateData['outputs'][number]) => {
    try {
      const resp = await fetch(o.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = o.filename || 'output';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e: any) {
      throw e;
    }
  };

  const running = !!runState && ['pending', 'running'].includes(runState.status);

  return {
    schema,
    schemaLoading,
    schemaError,
    mode,
    setMode,
    formValues,
    setFormValues,
    setFieldValue,
    handleFormChange,
    jsonText,
    setJsonText,
    formError,
    runState,
    runPolling,
    submitting,
    running,
    uploading,
    submit,
    interrupt,
    reset,
    init,
    uploadImage,
    downloadOutput,
  };
}

export type UseComfyRunReturn = ReturnType<typeof useComfyRun>;
