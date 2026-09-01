import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Upload,
  Tabs,
  Popconfirm,
  message,
  Typography,
  Alert,
  Descriptions,
  Card,
  Tooltip,
  Segmented,
  Empty,
  Row,
  Col,
  Progress,
  InputNumber,
  Switch,
  Divider,
  Checkbox,
  Collapse,
} from 'antd';
import type { UploadFile, UploadProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  UploadOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  SaveOutlined,
  ApiOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  PlayCircleOutlined,
  DownloadOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { request } from 'umi';

interface ExposedField {
  nodeId: string;
  param: string;
}

interface ExposureConfig {
  version: number;
  fields: ExposedField[];
}

export interface ComfyUIAPI {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  tags: string[] | null;
  apiJson: unknown;
  thumbnailPath: string | null;
  exposureConfig: ExposureConfig | null;
  createdAt: string;
  updatedAt: string;
}

interface CategoryOption {
  value: string;
  label: string;
}

interface ImportFormValues {
  name?: string;
  category?: string;
  description?: string;
  tags?: string[];
}

interface ComfyUIWorkflowFile {
  filename: string;
  size?: number;
  modified?: number;
  created?: number;
}

interface WorkflowPreview {
  filename: string;
  derivedName: string;
  suggestedCategory: string;
  apiJson: unknown;
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  format: string;
  schema: SchemaAnalysis | null;
  suggestedExposure: ExposureConfig;
}

interface RunOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  kind: 'image' | 'video' | 'audio' | 'other';
}

interface RunStateData {
  promptId: string;
  workflowId?: string;
  title: string;
  status: string;
  queuedAt: number;
  currentNode?: string | null;
  currentNodeTitle?: string;
  progress?: { value: number; max: number };
  nodes: Record<string, { value: number; max: number; state: string }>;
  nodeTitles: Record<string, string>;
  outputs: RunOutputFile[];
  error?: string;
  nodeErrors: Record<string, unknown>;
}

interface SchemaField {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  param: string;
  label: string;
  control: 'input_number' | 'slider' | 'textarea' | 'input' | 'select' | 'switch' | 'upload' | 'hidden';
  valueType: string;
  current: unknown;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: (string | number)[];
  multiline?: boolean;
  imageUpload?: boolean;
}

interface SchemaNodeGroup {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  fields: SchemaField[];
}

interface SchemaAnalysis {
  ok: boolean;
  source: string;
  groups: SchemaNodeGroup[];
  warnings: string[];
  error?: string;
  nodeCount: number;
  editableCount: number;
  totalFieldCount: number;
}

const { Paragraph } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  txt2img: 'blue',
  img2img: 'green',
  txt2vid: 'purple',
  img2vid: 'cyan',
  vid2vid: 'orange',
  reference: 'gold',
};

let onView: (w: ComfyUIAPI) => void = () => {};
let onEdit: (w: ComfyUIAPI) => void = () => {};
let onDelete: (id: string) => void = () => {};

export default function ComfyUIAPIManager() {
  const [list, setList] = useState<ComfyUIAPI[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<ComfyUIAPI | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ComfyUIAPI | null>(null);
  const [editForm] = Form.useForm();
  // 编辑弹窗：暴露字段配置
  const [editSchema, setEditSchema] = useState<SchemaAnalysis | null>(null);
  const [editSchemaLoading, setEditSchemaLoading] = useState(false);
  const [editExposureKeys, setEditExposureKeys] = useState<Set<string>>(new Set());
  const [importForm] = Form.useForm();
  const [activeTab, setActiveTab] = useState('file');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [comfyuiUrl, setComfyuiUrl] = useState('http://localhost:8188');
  const [savingUrl, setSavingUrl] = useState(false);
  const [testing, setTesting] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // 从 ComfyUI 导入
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteFiles, setRemoteFiles] = useState<ComfyUIWorkflowFile[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<string>('');
  const [remotePreview, setRemotePreview] = useState<WorkflowPreview | null>(null);
  const [remotePreviewLoading, setRemotePreviewLoading] = useState(false);
  const [remoteImporting, setRemoteImporting] = useState(false);
  const [remoteForm] = Form.useForm();
  // 导入弹窗：已勾选暴露字段（key=`${nodeId}::${param}`）
  const [exposureKeys, setExposureKeys] = useState<Set<string>>(new Set());

  // 运行面板
  const [runOpen, setRunOpen] = useState(false);
  const [runWorkflow, setRunWorkflow] = useState<ComfyUIAPI | null>(null);
  const [runState, setRunState] = useState<RunStateData | null>(null);
  const [runPolling, setRunPolling] = useState(false);
  const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 运行面板（步骤④⑤⑥：schema 动态表单 + JSON 切换 + 图片上传）
  const [runMode, setRunMode] = useState<'form' | 'json'>('form');
  const [runSchema, setRunSchema] = useState<SchemaAnalysis | null>(null);
  const [runSchemaLoading, setRunSchemaLoading] = useState(false);
  const [runFormValues, setRunFormValues] = useState<Record<string, unknown>>({});
  const [runJsonText, setRunJsonText] = useState('');
  const [runFormError, setRunFormError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<ComfyUIAPI[]>('/api/workflows');
      setList(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    const data = await request<CategoryOption[]>('/api/workflows/categories');
    setCategories(data);
  }, []);

  useEffect(() => {
    load();
    loadCategories();
    loadComfyuiUrl();
  }, [load, loadCategories]);

  const loadComfyuiUrl = useCallback(async () => {
    try {
      const data = await request<{ key: string; value: string | null }>('/api/settings/comfyui-url');
      if (data.value) {
        setComfyuiUrl(data.value);
      }
    } catch {
      // settings table may not exist yet, use default
    }
  }, []);

  const saveComfyuiUrl = async () => {
    setSavingUrl(true);
    try {
      await request('/api/settings/comfyui-url', {
        method: 'PUT',
        data: { value: comfyuiUrl },
      });
      message.success('ComfyUI 地址已保存');
    } catch (e: any) {
      message.error('保存失败');
    } finally {
      setSavingUrl(false);
    }
  };

  const testComfyuiConnection = async () => {
    setTesting(true);
    try {
      const result = await request<{ ok: boolean; error?: string }>('/api/settings/test-connection', {
        method: 'POST',
        data: { url: comfyuiUrl },
      });
      if (result.ok) {
        message.success('连接成功');
      } else {
        message.warning(`连接失败：${result.error || '未知错误'}`);
      }
    } catch (e) {
      message.error('连接失败：无法访问 ComfyUI 服务');
    } finally {
      setTesting(false);
    }
  };

  const columns: ColumnsType<ComfyUIAPI> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
    },
    {
      title: '类型',
      dataIndex: 'categoryLabel',
      key: 'category',
      width: 100,
      render: (label: string, record) => (
        <Tag color={CATEGORY_COLORS[record.category] || 'default'}>{label}</Tag>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      render: (tags: string[] | null) =>
        tags?.length ? tags.map((t) => <Tag key={t}>{t}</Tag>) : '-',
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_, record) => (
        <Space>
          <Tooltip title="运行">
            <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => startRun(record)} />
          </Tooltip>
          <Tooltip title="查看">
            <Button size="small" icon={<EyeOutlined />} onClick={() => onView(record)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="确认删除该 ComfyUI API？"
            onConfirm={() => onDelete(record.id)}
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="删除">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  onView = (w) => {
    setDetail(w);
    setDetailOpen(true);
  };
  onEdit = (w) => {
    setEditing(w);
    editForm.setFieldsValue({
      name: w.name,
      category: w.category,
      description: w.description ?? '',
      tags: w.tags ?? [],
    });
    // 载入当前暴露配置（无则空集）
    setEditExposureKeys(
      new Set((w.exposureConfig?.fields ?? []).map((f) => `${f.nodeId}::${f.param}`)),
    );
    setEditSchema(null);
    setEditSchemaLoading(true);
    setEditOpen(true);
    request<{ schema: SchemaAnalysis }>(`/api/comfyui/workflows/${w.id}/schema`)
      .then((data) => setEditSchema(data.schema))
      .catch(() => setEditSchema(null))
      .finally(() => setEditSchemaLoading(false));
  };
  onDelete = async (id) => {
    await request(`/api/workflows/${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  };

  const handleImport = async () => {
    const values = (await importForm.validateFields()) as ImportFormValues;
    setImporting(true);
    try {
      const jsonInput = importForm.getFieldValue('jsonText');
      await request('/api/workflows', {
        method: 'POST',
        data: {
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
          content: jsonInput,
        },
      });
      message.success('导入成功');
      setImportOpen(false);
      importForm.resetFields();
      setFileList([]);
      load();
    } catch (e: any) {
      if (e?.response?.data?.message) {
        const msg = Array.isArray(e.response.data.message)
          ? e.response.data.message.join('；')
          : e.response.data.message;
        message.error(msg);
      } else {
        throw e;
      }
    } finally {
      setImporting(false);
    }
  };

  const handleFile: UploadProps['beforeUpload'] = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      importForm.setFieldValue('jsonText', String(reader.result));
      message.success('已读取文件内容');
    };
    reader.readAsText(file);
    setFileList([file as unknown as UploadFile]);
    return false;
  };

  const handleEditSave = async () => {
    if (!editing) return;
    const values = await editForm.validateFields();
    try {
      const exposureConfig = {
        version: 1,
        fields: [...editExposureKeys].map((k) => {
          const idx = k.lastIndexOf('::');
          return { nodeId: k.slice(0, idx), param: k.slice(idx + 2) };
        }),
      };
      await request(`/api/workflows/${editing.id}`, {
        method: 'PATCH',
        data: {
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
          exposureConfig,
        },
      });
      message.success('已保存');
      setEditOpen(false);
      load();
    } catch (e: any) {
      if (e?.response?.data?.message) {
        const msg = Array.isArray(e.response.data.message)
          ? e.response.data.message.join('；')
          : e.response.data.message;
        message.error(msg);
      } else {
        throw e;
      }
    }
  };

  // ---------- 从 ComfyUI 导入 ----------

  const openRemoteImport = async () => {
    setRemoteOpen(true);
    setSelectedRemote('');
    setRemotePreview(null);
    remoteForm.resetFields();
    setRemoteLoading(true);
    try {
      const data = await request<{ files: ComfyUIWorkflowFile[] }>('/api/comfyui/workflows');
      setRemoteFiles(data.files ?? []);
    } catch (e: any) {
      message.error(`拉取 ComfyUI 工作流失败：${e?.response?.data?.message || '无法连接 ComfyUI'}`);
      setRemoteFiles([]);
    } finally {
      setRemoteLoading(false);
    }
  };

  const previewRemoteWorkflow = async (filename: string) => {
    setSelectedRemote(filename);
    setRemotePreview(null);
    setRemotePreviewLoading(true);
    try {
      const data = await request<WorkflowPreview>('/api/comfyui/workflows/preview', {
        method: 'POST',
        data: { filename },
      });
      setRemotePreview(data);
      remoteForm.setFieldsValue({
        name: data.derivedName,
        category: data.suggestedCategory,
      });
      // 智能预勾：后端建议的字段默认选中
      const preset = new Set(
        (data.suggestedExposure?.fields ?? []).map((f) => `${f.nodeId}::${f.param}`),
      );
      setExposureKeys(preset);
    } catch (e: any) {
      message.error(`转换失败：${e?.response?.data?.message || '未知错误'}`);
    } finally {
      setRemotePreviewLoading(false);
    }
  };

  const handleRemoteImport = async () => {
    if (!selectedRemote) {
      message.warning('请先选择要导入的工作流');
      return;
    }
    const values = (await remoteForm.validateFields()) as ImportFormValues;
    setRemoteImporting(true);
    try {
      const exposure = {
        version: 1,
        fields: [...exposureKeys].map((k) => {
          const idx = k.lastIndexOf('::');
          return { nodeId: k.slice(0, idx), param: k.slice(idx + 2) };
        }),
      };
      await request('/api/comfyui/workflows/import', {
        method: 'POST',
        data: {
          filename: selectedRemote,
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
          exposure,
        },
      });
      message.success('导入成功');
      setRemoteOpen(false);
      load();
    } catch (e: any) {
      if (e?.response?.data?.message) {
        message.error(Array.isArray(e.response.data.message) ? e.response.data.message.join('；') : e.response.data.message);
      } else {
        message.error('导入失败');
      }
    } finally {
      setRemoteImporting(false);
    }
  };

  // ---------- 运行面板 ----------

  const clearRunPoll = () => {
    if (runPollRef.current) {
      clearInterval(runPollRef.current);
      runPollRef.current = null;
    }
  };

  const stopPollingIfFinished = (run: RunStateData | null) => {
    if (!run) return;
    if (['success', 'error', 'interrupted', 'unknown'].includes(run.status)) {
      clearRunPoll();
      setRunPolling(false);
    }
  };

  // ---------- 运行面板：schema 动态表单 + JSON 切换 + 图片上传 ----------

  const fileKey = (f: SchemaField) => `${f.nodeId}::${f.param}`;

  /** 把表单值（key=`${nodeId}::${param}`）按值级写入 apiJson 深拷贝 */
  const applyFormValues = (base: unknown, values: Record<string, unknown>): unknown => {
    const json = JSON.parse(JSON.stringify(base)) as Record<string, any>;
    for (const [key, v] of Object.entries(values)) {
      const idx = key.lastIndexOf('::');
      if (idx <= 0) continue;
      const nodeId = key.slice(0, idx);
      const param = key.slice(idx + 2);
      const node = json[nodeId];
      if (node && typeof node.inputs === 'object' && node.inputs !== null) {
        node.inputs[param] = v;
      }
    }
    return json;
  };

  const openRunPanel = async (w: ComfyUIAPI) => {
    setRunWorkflow(w);
    setRunState(null);
    setRunSchema(null);
    setRunSchemaLoading(true);
    setRunFormError(null);
    setRunOpen(true);
    setRunJsonText(JSON.stringify(w.apiJson, null, 2));
    try {
      const data = await request<{ schema: SchemaAnalysis }>(
        `/api/comfyui/workflows/${w.id}/schema`,
      );
      setRunSchema(data.schema);
      const init: Record<string, unknown> = {};
      for (const g of data.schema.groups) {
        for (const f of g.fields) {
          if (f.control === 'hidden') continue;
          init[fileKey(f)] = f.current;
        }
      }
      setRunFormValues(init);
    } catch (e: any) {
      setRunSchema(null);
      setRunFormError(
        `自动表单加载失败：${e?.response?.data?.message || '未知错误'}，已切换为 JSON 模式`,
      );
      setRunMode('json');
    } finally {
      setRunSchemaLoading(false);
    }
  };

  const startRun = async (w: ComfyUIAPI) => {
    void openRunPanel(w);
  };

  const handleRunSubmit = async () => {
    if (!runWorkflow) return;
    let apiJson: unknown;
    try {
      if (runMode === 'json') {
        apiJson = JSON.parse(runJsonText);
      } else {
        apiJson = applyFormValues(runWorkflow.apiJson, runFormValues);
      }
    } catch (e: any) {
      message.error(`参数解析失败：${e?.message || 'JSON 格式错误'}`);
      return;
    }
    setRunState(null);
    setRunPolling(true);
    try {
      const data = await request<{ run: RunStateData }>('/api/comfyui/runs', {
        method: 'POST',
        data: { workflowId: runWorkflow.id, apiJson },
      });
      setRunState(data.run);
      stopPollingIfFinished(data.run);
      if (runPollRef.current) clearInterval(runPollRef.current);
      runPollRef.current = setInterval(async () => {
        try {
          const res = await request<{ run: RunStateData | null }>(`/api/comfyui/runs/${data.run.promptId}`);
          setRunState(res.run);
          stopPollingIfFinished(res.run);
        } catch {
          // 网络抖动，继续轮询
        }
      }, 1500);
    } catch (e: any) {
      setRunPolling(false);
      message.error(`提交运行失败：${e?.response?.data?.message || '未知错误'}`);
    }
  };

  const setFieldValue = (f: SchemaField, v: unknown) => {
    setRunFormValues((prev) => ({ ...prev, [fileKey(f)]: v }));
  };

  /** 上传成功后把新文件名追加进对应字段的 options */
  const appendUploadOption = (f: SchemaField, name: string) => {
    setRunSchema((prev) => {
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
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  /** upload 控件：从已有图片选择 + 上传新图片到 ComfyUI input 目录 */
  const renderUploadField = (f: SchemaField) => {
    const value = runFormValues[fileKey(f)];
    return (
      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
        <Select
          style={{ flex: 1, minWidth: 0 }}
          value={(value as string | number) ?? undefined}
          showSearch
          placeholder="选择已有图片"
          options={(f.options ?? []).map((o) => ({ value: o, label: String(o) }))}
          onChange={(v) => setFieldValue(f, v)}
        />
        <Upload
          accept="image/*"
          showUploadList={false}
          customRequest={async ({ file, onSuccess, onError }) => {
            const rcFile = file as File;
            try {
              const dataBase64 = await fileToBase64(rcFile);
              setUploading(true);
              const res = await request<{ file: { name: string } }>('/api/comfyui/upload/image', {
                method: 'POST',
                data: { filename: rcFile.name, dataBase64 },
              });
              setFieldValue(f, res.file.name);
              appendUploadOption(f, res.file.name);
              message.success(`已上传 ${res.file.name}`);
              onSuccess?.(res);
            } catch (e: any) {
              message.error(`上传失败：${e?.response?.data?.message || '未知错误'}`);
              onError?.(e as Error);
            } finally {
              setUploading(false);
            }
          }}
        >
          <Button icon={<UploadOutlined />} loading={uploading} />
        </Upload>
      </div>
    );
  };

  /** schema 字段 → antd 控件 */
  const renderField = (f: SchemaField) => {
    const value = runFormValues[fileKey(f)];
    switch (f.control) {
      case 'input_number':
        return (
          <InputNumber
            style={{ width: '100%' }}
            value={value as number}
            min={f.min}
            max={f.max}
            step={f.step}
            onChange={(v) => setFieldValue(f, v ?? undefined)}
          />
        );
      case 'textarea':
        return (
          <Input.TextArea
            rows={3}
            value={String(value ?? '')}
            onChange={(e) => setFieldValue(f, e.target.value)}
          />
        );
      case 'input':
        return (
          <Input
            value={String(value ?? '')}
            onChange={(e) => setFieldValue(f, e.target.value)}
          />
        );
      case 'select':
        return (
          <Select
            style={{ width: '100%' }}
            value={(value as string | number) ?? undefined}
            showSearch
            options={(f.options ?? []).map((o) => ({ value: o, label: String(o) }))}
            onChange={(v) => setFieldValue(f, v)}
          />
        );
      case 'switch':
        return <Switch checked={Boolean(value)} onChange={(v) => setFieldValue(f, v)} />;
      case 'upload':
        return renderUploadField(f);
      default:
        return null;
    }
  };

  /** 渲染一组节点分组的表单控件（运行面板用） */
  const renderRunGroups = (groups: SchemaNodeGroup[]) =>
    groups.map((g) => (
      <div key={g.nodeId} style={{ marginBottom: 12 }}>
        <Divider orientation="left" style={{ margin: '8px 0' }}>
          <span style={{ fontSize: 13 }}>
            {g.nodeTitle}
            <span style={{ color: '#999', marginLeft: 8, fontSize: 12 }}>
              {g.classType} · {g.nodeId}
            </span>
          </span>
        </Divider>
        <Row gutter={16}>
          {g.fields.map((f) =>
            f.control === 'hidden' ? null : (
              <Col span={12} key={`${f.nodeId}::${f.param}`} style={{ marginBottom: 4 }}>
                <div style={{ marginBottom: 2, fontSize: 12, color: '#555' }}>{f.label}</div>
                {renderField(f)}
              </Col>
            ),
          )}
        </Row>
      </div>
    ));

  /**
   * 按 exposureConfig 把 schema 分组拆成主区（暴露）与高级区（折叠）。
   * exposureConfig 为空 → 全部归主区（回退为平铺，不破坏老数据）。
   */
  const splitByExposure = (schema: SchemaAnalysis, exposure: ExposureConfig | null) => {
    const exposed = exposure?.fields?.length
      ? new Set(exposure.fields.map((f) => `${f.nodeId}::${f.param}`))
      : null;
    if (!exposed) {
      return { primary: schema.groups, advanced: [] as SchemaNodeGroup[] };
    }
    const primary: SchemaNodeGroup[] = [];
    const advanced: SchemaNodeGroup[] = [];
    for (const g of schema.groups) {
      const p = g.fields.filter((f) => exposed.has(`${f.nodeId}::${f.param}`));
      const a = g.fields.filter((f) => !exposed.has(`${f.nodeId}::${f.param}`));
      if (p.length) primary.push({ ...g, fields: p });
      if (a.length) advanced.push({ ...g, fields: a });
    }
    return { primary, advanced };
  };

  /** 字段值预览（勾选表右侧展示当前值） */
  const previewValue = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v || '(空)';
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
    return String(v);
  };

  /** control → 中文标签 */
  const controlLabel = (c: SchemaField['control']): string => {
    const map: Record<string, string> = {
      input_number: '数值',
      slider: '滑块',
      textarea: '多行文本',
      input: '文本',
      select: '下拉',
      switch: '开关',
      upload: '图片',
    };
    return map[c] ?? c;
  };

  /**
   * 暴露字段勾选表：按节点分组，每个可编辑字段一行 Checkbox + 类型 + 当前值。
   * 供导入弹窗与编辑弹窗复用。
   */
  const renderExposureSelector = (
    schema: SchemaAnalysis | null,
    selected: Set<string>,
    setSelected: (next: Set<string>) => void,
  ) => {
    if (!schema || !schema.ok) {
      return (
        <Alert
          type="warning"
          showIcon
          message="无法解析可编辑字段"
          description="该工作流未能分析出可编辑参数，导入后运行面板将回退为完整参数列表。"
        />
      );
    }
    const editableGroups = schema.groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => f.control !== 'hidden') }))
      .filter((g) => g.fields.length > 0);

    const allKeys = editableGroups.flatMap((g) =>
      g.fields.map((f) => `${f.nodeId}::${f.param}`),
    );
    const allChecked = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

    const toggle = (key: string, checked: boolean) => {
      const next = new Set(selected);
      if (checked) next.add(key);
      else next.delete(key);
      setSelected(next);
    };

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: '#888' }}>
            勾选需要在运行面板直接暴露的字段，未勾选的将收进"高级参数"折叠区。已选 {selected.size} 项
          </span>
          <Space>
            <Button size="small" onClick={() => setSelected(new Set(allKeys))} disabled={allChecked}>
              全选
            </Button>
            <Button size="small" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              全不选
            </Button>
          </Space>
        </div>
        <div style={{ maxHeight: '40vh', overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 8 }}>
          {editableGroups.map((g) => (
            <div key={g.nodeId} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#999', margin: '4px 0' }}>
                {g.nodeTitle}
                <span style={{ marginLeft: 6 }}>
                  {g.classType} · {g.nodeId}
                </span>
              </div>
              {g.fields.map((f) => {
                const key = `${f.nodeId}::${f.param}`;
                return (
                  <div
                    key={key}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 2px 12px' }}
                  >
                    <Checkbox
                      checked={selected.has(key)}
                      onChange={(e) => toggle(key, e.target.checked)}
                    >
                      <span style={{ fontSize: 13 }}>{f.label}</span>
                    </Checkbox>
                    <Tag style={{ fontSize: 11 }}>{controlLabel(f.control)}</Tag>
                    <span style={{ fontSize: 11, color: '#bbb', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {previewValue(f.current)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const interruptRun = async () => {
    if (!runState) return;
    try {
      await request(`/api/comfyui/runs/${runState.promptId}/interrupt`, { method: 'POST' });
      message.info('已发送中断请求');
    } catch (e: any) {
      message.error(`中断失败：${e?.response?.data?.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    return () => clearRunPoll();
  }, []);

  const runStatusTag = (status: string) => {
    const map: Record<string, { color: string; text: string }> = {
      pending: { color: 'default', text: '排队中' },
      running: { color: 'processing', text: '运行中' },
      success: { color: 'success', text: '成功' },
      error: { color: 'error', text: '失败' },
      interrupted: { color: 'warning', text: '已中断' },
      unknown: { color: 'default', text: '未知' },
    };
    const m = map[status] ?? { color: 'default', text: status };
    return <Tag color={m.color}>{m.text}</Tag>;
  };

  const runProgress = (run: RunStateData) => {
    if (run.status === 'running' && run.currentNode) {
      const node = run.nodes?.[run.currentNode];
      if (node && node.max > 0) {
        const pct = Math.round((node.value / node.max) * 100);
        return <Progress percent={pct} size="small" />;
      }
    }
    if (run.status === 'success') return <Progress percent={100} size="small" status="success" />;
    if (run.status === 'error') return <Progress percent={0} size="small" status="exception" />;
    return <Progress percent={0} size="small" />;
  };

  const preview = (w: ComfyUIAPI) => (
    <Descriptions column={1} size="small" bordered>
      <Descriptions.Item label="名称">{w.name}</Descriptions.Item>
      <Descriptions.Item label="类型">
        <Tag color={CATEGORY_COLORS[w.category] || 'default'}>{w.categoryLabel}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="描述">{w.description || '-'}</Descriptions.Item>
      <Descriptions.Item label="标签">
        {w.tags?.length ? w.tags.map((t) => <Tag key={t}>{t}</Tag>) : '-'}
      </Descriptions.Item>
      <Descriptions.Item label="创建时间">
        {new Date(w.createdAt).toLocaleString()}
      </Descriptions.Item>
      <Descriptions.Item label="更新时间">
        {new Date(w.updatedAt).toLocaleString()}
      </Descriptions.Item>
      <Descriptions.Item label="JSON 内容">
        <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 12 }}>
          {JSON.stringify(w.apiJson, null, 2)}
        </pre>
      </Descriptions.Item>
    </Descriptions>
  );

  const filteredList = categoryFilter === 'all'
    ? list
    : list.filter((w) => w.category === categoryFilter);

  const renderCard = (w: ComfyUIAPI) => (
    <Card
      key={w.id}
      size="small"
      hoverable
      style={{ marginBottom: 16 }}
      onClick={() => onView(w)}
      cover={
        w.thumbnailPath ? (
          <img
            src={w.thumbnailPath}
            alt={w.name}
            style={{ height: 160, objectFit: 'cover', display: 'block' }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div
            style={{
              height: 160,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fafafa',
              color: '#bbb',
              fontSize: 12,
            }}
          >
            暂无预览图
          </div>
        )
      }
      actions={[
        <Tooltip title="查看" key="view">
          <EyeOutlined />
        </Tooltip>,
        <Tooltip title="编辑" key="edit">
          <EditOutlined onClick={(e) => { e.stopPropagation(); onEdit(w); }} />
        </Tooltip>,
        <Tooltip title="运行" key="run">
          <PlayCircleOutlined onClick={(e) => { e.stopPropagation(); startRun(w); }} />
        </Tooltip>,
        <Popconfirm
          title="确认删除该 ComfyUI API？"
          onConfirm={() => onDelete(w.id)}
          okButtonProps={{ danger: true }}
          key="delete"
        >
          <Tooltip title="删除">
            <DeleteOutlined onClick={(e) => e.stopPropagation()} />
          </Tooltip>
        </Popconfirm>,
      ]}
    >
      <Card.Meta
        title={w.name}
        description={
          <div>
            <div style={{ minHeight: 40, color: '#555', fontSize: 12, marginBottom: 8 }}>
              {w.description || '暂无描述'}
            </div>
            <Space size={[0, 4]} wrap>
              <Tag color={CATEGORY_COLORS[w.category] || 'default'} style={{ fontSize: 11 }}>
                {w.categoryLabel}
              </Tag>
              {w.tags?.length
                ? w.tags.map((t) => <Tag key={t} style={{ fontSize: 11 }}>{t}</Tag>)
                : null}
            </Space>
          </div>
        }
      />
    </Card>
  );

  return (
    <div>
      <Card
        size="small"
        title={<><ApiOutlined /> ComfyUI 服务地址</>}
        style={{ marginBottom: 16 }}
      >
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={comfyuiUrl}
            onChange={(e) => setComfyuiUrl(e.target.value)}
            placeholder="http://localhost:8188"
            addonBefore="地址"
          />
          <Button onClick={testComfyuiConnection} loading={testing}>
            测试连接
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={saveComfyuiUrl} loading={savingUrl}>
            保存
          </Button>
        </Space.Compact>
      </Card>

      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
          导入 ComfyUI API
        </Button>
        <Button icon={<DownloadOutlined />} onClick={openRemoteImport}>
          从 ComfyUI 导入
        </Button>
        <Button onClick={load}>刷新</Button>
        <Select
          value={categoryFilter}
          onChange={setCategoryFilter}
          style={{ width: 160 }}
          placeholder="按类型筛选"
        >
          <Select.Option value="all">全部类型</Select.Option>
          {categories.map((c) => (
            <Select.Option key={c.value} value={c.value}>{c.label}</Select.Option>
          ))}
        </Select>
        <Segmented
          value={viewMode}
          onChange={(v) => setViewMode(v as 'card' | 'list')}
          options={[
            { value: 'card', label: '卡片', icon: <AppstoreOutlined /> },
            { value: 'list', label: '列表', icon: <UnorderedListOutlined /> },
          ]}
        />
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="支持两种导入方式：从 ComfyUI 已保存工作流直接导入（自动转换 UI 格式为 API 格式）；或导入 ComfyUI 导出的 API（Save (API Format)）JSON。保存时仅校验格式，实际与 ComfyUI 的连接在运行时检测。"
      />

      {viewMode === 'card' ? (
        filteredList.length ? (
          <Row gutter={[16, 16]}>
            {filteredList.map((w) => (
              <Col xs={24} sm={12} md={8} lg={6} key={w.id}>
                {renderCard(w)}
              </Col>
            ))}
          </Row>
        ) : (
          <Empty description={loading ? '加载中…' : '暂无 ComfyUI API，点击上方“导入”添加'} />
        )
      ) : (
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={filteredList}
          pagination={{ pageSize: 10 }}
        />
      )}

      <Modal
        title="导入 ComfyUI API"
        open={importOpen}
        onCancel={() => { setImportOpen(false); setFileList([]); }}
        onOk={handleImport}
        confirmLoading={importing}
        okText="导入并保存"
        width={640}
      >
        <Form form={importForm} layout="vertical" initialValues={{ name: '', tags: [] }}>
          <Form.Item
            label="API 名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="例如：文生图基础流程" />
          </Form.Item>
          <Form.Item
            label="API 类型"
            name="category"
            rules={[{ required: true, message: '请选择类型' }]}
          >
            <Select placeholder="选择 API 类型">
              {categories.map((c) => (
                <Select.Option key={c.value} value={c.value}>
                  {c.label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Select
              mode="tags"
              placeholder="输入后回车添加标签"
              tokenSeparators={[',', '，']}
            />
          </Form.Item>
          <Form.Item
            label="ComfyUI API JSON"
            name="jsonText"
            rules={[{ required: true, message: '请上传文件或粘贴 JSON 内容' }]}
          >
            <Tabs activeKey={activeTab} onChange={setActiveTab}>
              <Tabs.TabPane key="file" tab="上传文件" forceRender>
                <Upload.Dragger
                  beforeUpload={handleFile}
                  fileList={fileList}
                  onChange={({ fileList: newFileList }) => setFileList(newFileList)}
                  maxCount={1}
                  onRemove={() => {
                    setFileList([]);
                    importForm.setFieldValue('jsonText', '');
                  }}
                >
                  <p className="ant-upload-drag-icon">
                    <UploadOutlined />
                  </p>
                  <p className="ant-upload-text">点击或拖拽 JSON 文件到此处</p>
                  <p className="ant-upload-hint">仅支持 ComfyUI 导出的 API 格式</p>
                </Upload.Dragger>
              </Tabs.TabPane>
              <Tabs.TabPane key="paste" tab="粘贴 JSON" forceRender>
                <Input.TextArea
                  rows={8}
                  placeholder='粘贴 ComfyUI API 格式 JSON，例如 {"3":{"class_type":"KSampler","inputs":{...}}}'
                  onChange={(e) => importForm.setFieldValue('jsonText', e.target.value)}
                />
              </Tabs.TabPane>
            </Tabs>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="ComfyUI API 详情"
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width={720}
      >
        {detail && preview(detail)}
      </Modal>

      <Modal
        title="编辑 ComfyUI API"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={handleEditSave}
        okText="保存"
        width={720}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="类型" name="category" rules={[{ required: true, message: '请选择类型' }]}>
            <Select>
              {categories.map((c) => (
                <Select.Option key={c.value} value={c.value}>
                  {c.label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入后回车添加标签" />
          </Form.Item>
        </Form>
        <Divider orientation="left" style={{ margin: '8px 0' }}>
          <span style={{ fontSize: 13 }}>暴露字段配置</span>
        </Divider>
        {editSchemaLoading ? (
          <div style={{ textAlign: 'center', padding: 16 }}>
            <Progress percent={100} size="small" status="active" />
            <div style={{ color: '#888', marginTop: 4 }}>正在分析可编辑参数…</div>
          </div>
        ) : (
          renderExposureSelector(editSchema, editExposureKeys, setEditExposureKeys)
        )}
        <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
          当前 JSON 节点数：{editing ? Object.keys(editing.apiJson as object).length : 0}
        </Paragraph>
      </Modal>
      <Modal
        title={
          <Space>
            <PlayCircleOutlined />
            运行工作流{runWorkflow ? `：${runWorkflow.name}` : ''}
            {runState ? runStatusTag(runState.status) : null}
          </Space>
        }
        open={runOpen}
        onCancel={() => {
          clearRunPoll();
          setRunOpen(false);
        }}
        footer={
          runState && ['pending', 'running'].includes(runState.status) ? (
            <Space>
              <Button icon={<StopOutlined />} danger onClick={interruptRun}>
                中断运行
              </Button>
              <Button onClick={() => setRunOpen(false)}>关闭</Button>
            </Space>
          ) : runState ? (
            <Button type="primary" onClick={() => setRunOpen(false)}>关闭</Button>
          ) : (
            <Space>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={handleRunSubmit}
                disabled={runSchemaLoading}
                loading={runPolling && !runState}
              >
                提交运行
              </Button>
              <Button onClick={() => setRunOpen(false)}>关闭</Button>
            </Space>
          )
        }
        width={860}
      >
        {!runState ? (
          <div>
            <Space style={{ marginBottom: 12 }} wrap>
              <Segmented
                value={runMode}
                onChange={(v) => {
                  const mode = v as 'form' | 'json';
                  if (mode === 'json') {
                    setRunJsonText(
                      JSON.stringify(
                        applyFormValues(runWorkflow?.apiJson, runFormValues),
                        null,
                        2,
                      ),
                    );
                  } else {
                    try {
                      const parsed = JSON.parse(runJsonText) as Record<string, any>;
                      if (runSchema) {
                        const vals: Record<string, unknown> = {};
                        for (const g of runSchema.groups) {
                          for (const f of g.fields) {
                            if (f.control === 'hidden') continue;
                            const node = parsed[f.nodeId];
                            vals[fileKey(f)] = node?.inputs?.[f.param];
                          }
                        }
                        setRunFormValues(vals);
                      }
                    } catch {
                      // JSON 解析失败，保留当前表单值
                    }
                  }
                  setRunMode(mode);
                }}
                options={[
                  { value: 'form', label: '自动表单' },
                  { value: 'json', label: 'JSON 模式' },
                ]}
              />
              {runSchema && (
                <span style={{ color: '#888', fontSize: 12 }}>
                  可编辑参数 {runSchema.editableCount} 项 / {runSchema.nodeCount} 节点
                </span>
              )}
            </Space>

            {runFormError && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={runFormError} />
            )}
            {runSchema?.warnings?.length ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="部分节点未解析"
                description={runSchema.warnings.join('；')}
              />
            ) : null}

            {runMode === 'form' ? (
              runSchemaLoading ? (
                <div style={{ textAlign: 'center', padding: 32 }}>
                  <Progress percent={100} size="small" status="active" />
                  <div style={{ color: '#888', marginTop: 8 }}>正在分析可编辑参数…</div>
                </div>
              ) : runSchema && runSchema.ok ? (
                (() => {
                  const { primary, advanced } = splitByExposure(
                    runSchema,
                    runWorkflow?.exposureConfig ?? null,
                  );
                  const advancedCount = advanced.reduce((n, g) => n + g.fields.length, 0);
                  return (
                    <div style={{ maxHeight: '52vh', overflow: 'auto', paddingRight: 8 }}>
                      {primary.length > 0 ? (
                        renderRunGroups(primary)
                      ) : (
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="该工作流未配置暴露字段，所有参数已收进下方高级参数区。"
                        />
                      )}
                      {advancedCount > 0 && (
                        <Collapse
                          ghost
                          items={[
                            {
                              key: 'advanced',
                              label: `高级参数（${advancedCount} 项）`,
                              children: renderRunGroups(advanced),
                            },
                          ]}
                        />
                      )}
                    </div>
                  );
                })()
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  message="无法生成自动表单"
                  description="该工作流未能解析出可编辑参数，请切换到 JSON 模式直接编辑模板。"
                />
              )
            ) : (
              <Input.TextArea
                rows={16}
                value={runJsonText}
                onChange={(e) => setRunJsonText(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            )}
          </div>
        ) : (
          <div>
            <Space style={{ marginBottom: 8 }}>
              <span style={{ color: '#555' }}>
                当前节点：
                <b>
                  {runState.currentNodeTitle ||
                    (runState.currentNode && runState.nodeTitles?.[runState.currentNode]) ||
                    runState.currentNode ||
                    '—'}
                </b>
              </span>
              {runState.currentNode && (
                <span style={{ color: '#999', fontSize: 12 }}>（{runState.currentNode}）</span>
              )}
            </Space>
            <div style={{ marginBottom: 16 }}>{runProgress(runState)}</div>

            {runState.error && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message="运行失败"
                description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>{runState.error}</pre>}
              />
            )}

            {runState.status === 'success' && (
              <Alert type="success" showIcon style={{ marginBottom: 16 }} message="运行完成" />
            )}

            {runState.outputs?.length > 0 && (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>输出结果：</div>
                <Row gutter={[12, 12]}>
                  {runState.outputs.map((o, i) => (
                    <Col span={8} key={`${o.url}-${i}`}>
                      <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 4 }}>
                        {o.kind === 'image' ? (
                          <img
                            src={o.url}
                            alt={o.filename}
                            style={{ width: '100%', borderRadius: 4, display: 'block' }}
                          />
                        ) : (
                          <div style={{ textAlign: 'center', padding: 16, color: '#888' }}>
                            {o.filename}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: '#888', marginTop: 4, wordBreak: 'break-all' }}>
                          {o.filename}
                        </div>
                      </div>
                    </Col>
                  ))}
                </Row>
              </div>
            )}

            {runState.status === 'success' && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 16 }}
                message="运行结果已作为该工作流的缩略图保存，可在列表中查看。"
              />
            )}
          </div>
        )}
      </Modal>

      <Modal
        title="从 ComfyUI 导入工作流"
        open={remoteOpen}
        onCancel={() => setRemoteOpen(false)}
        onOk={handleRemoteImport}
        confirmLoading={remoteImporting}
        okText="导入并保存"
        width={720}
      >
        <Form form={remoteForm} layout="vertical" initialValues={{ tags: [] }}>
          <Form.Item
            label="ComfyUI 已保存的工作流"
            required
            style={{ marginBottom: 12 }}
          >
            <Select
              style={{ width: '100%' }}
              placeholder="选择要导入的工作流"
              loading={remoteLoading}
              value={selectedRemote || undefined}
              onChange={previewRemoteWorkflow}
              showSearch
              optionFilterProp="label"
              options={remoteFiles.map((f) => ({
                value: f.filename,
                label: f.filename,
              }))}
            />
          </Form.Item>

          {remotePreviewLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Progress percent={100} size="small" status="active" />
              <div style={{ color: '#888' }}>正在从 ComfyUI 转换…</div>
            </div>
          ) : remotePreview ? (
            <>
              {!remotePreview.ok && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="转换失败"
                  description={(remotePreview.errors || []).join('；')}
                />
              )}
              {remotePreview.warnings?.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="转换告警"
                  description={remotePreview.warnings.join('；')}
                />
              )}
              <Descriptions column={3} size="small" style={{ marginBottom: 12 }}>
                <Descriptions.Item label="节点数">{remotePreview.nodeCount}</Descriptions.Item>
                <Descriptions.Item label="格式">
                  {remotePreview.format === 'new' ? '新格式' : remotePreview.format === 'legacy' ? '旧格式' : remotePreview.format}
                </Descriptions.Item>
                <Descriptions.Item label="建议类型">
                  <Tag color={CATEGORY_COLORS[remotePreview.suggestedCategory] || 'default'}>
                    {categories.find((c) => c.value === remotePreview.suggestedCategory)?.label || remotePreview.suggestedCategory}
                  </Tag>
                </Descriptions.Item>
              </Descriptions>
              <Form.Item
                label="名称"
                name="name"
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input placeholder="导入后的工作流名称" />
              </Form.Item>
              <Form.Item
                label="类型"
                name="category"
                rules={[{ required: true, message: '请选择类型' }]}
              >
                <Select placeholder="选择类型">
                  {categories.map((c) => (
                    <Select.Option key={c.value} value={c.value}>{c.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="描述" name="description">
                <Input.TextArea rows={2} placeholder="可选" />
              </Form.Item>
              <Form.Item label="标签" name="tags">
                <Select mode="tags" placeholder="输入后回车添加标签" tokenSeparators={[',', '，']} />
              </Form.Item>
              <Divider orientation="left" style={{ margin: '8px 0' }}>
                <span style={{ fontSize: 13 }}>暴露字段配置</span>
              </Divider>
              {renderExposureSelector(remotePreview.schema, exposureKeys, setExposureKeys)}
            </>
          ) : (
            <Empty description={remoteLoading ? '正在拉取工作流列表…' : '请选择工作流进行预览'} />
          )}
        </Form>
      </Modal>

    </div>
  );
}
