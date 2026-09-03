import { useCallback, useEffect, useState } from 'react';
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
  Divider,
  Checkbox,
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
} from '@ant-design/icons';
import { request } from 'umi';
import ComfyRunModal from '@/components/comfyui/ComfyRunModal';
import {
  ComfyUIAPI,
  ExposureConfig,
  WorkflowInputConfig,
  WorkflowFieldConfig,
  SchemaAnalysis,
  SchemaField,
} from '@/components/comfyui/types';
import { clearSchemaCache } from '@/components/comfyui/useComfyRun';

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
  suggestedInputConfig: WorkflowInputConfig;
  suggestedFieldConfig: WorkflowFieldConfig;
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
  const [editInputKeys, setEditInputKeys] = useState<Set<string>>(new Set());
  const [editFieldMeta, setEditFieldMeta] = useState<Record<string, { label: string; description: string }>>({});
  const [editGroupLabels, setEditGroupLabels] = useState<Record<string, string>>({});
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
  const [inputKeys, setInputKeys] = useState<Set<string>>(new Set());
  const [fieldMeta, setFieldMeta] = useState<Record<string, { label: string; description: string }>>({});
  const [groupLabels, setGroupLabels] = useState<Record<string, string>>({});

  // 运行面板：由共享组件 ComfyRunModal 承接，这里只保留开关状态
  const [runOpen, setRunOpen] = useState(false);
  const [runWorkflow, setRunWorkflow] = useState<ComfyUIAPI | null>(null);

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
    setEditInputKeys(new Set((w.inputConfig?.fields ?? []).map((f) => `${f.nodeId}::${f.param}`)));
    setEditFieldMeta(Object.fromEntries((w.fieldConfig?.fields ?? []).map((f) => [`${f.nodeId}::${f.param}`, { label: f.label ?? '', description: f.description ?? '' }])));
    setEditGroupLabels(Object.fromEntries((w.fieldConfig?.groups ?? []).map((g) => [g.nodeId, g.label])));
    setEditSchema(null);
    setEditSchemaLoading(true);
    setEditOpen(true);
    request<{ schema: SchemaAnalysis }>(`/api/comfyui/workflows/${w.id}/schema`)
      .then((data) => {
        setEditSchema(data.schema);
        if (!(w.fieldConfig?.fields?.length)) {
          setEditFieldMeta(Object.fromEntries(data.schema.groups.flatMap((g) => g.fields).map((f) => [`${f.nodeId}::${f.param}`, { label: f.label ?? '', description: f.description ?? '' }])));
        }
        if (!(w.fieldConfig?.groups?.length)) setEditGroupLabels(Object.fromEntries(data.schema.groups.map((g) => [g.nodeId, g.nodeTitle])));
      })
      .catch(() => setEditSchema(null))
      .finally(() => setEditSchemaLoading(false));
  };
  onDelete = async (id) => {
    setDetailOpen(false);
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

  const buildFieldConfig = (metadata: Record<string, { label: string; description: string }>, groups: Record<string, string>): WorkflowFieldConfig => ({
    version: 1,
    groups: Object.entries(groups).flatMap(([nodeId, label]) => label.trim() ? [{ nodeId, label: label.trim() }] : []),
    fields: Object.entries(metadata).flatMap(([key, value]) => {
      const idx = key.lastIndexOf('::');
      const label = value.label.trim();
      const description = value.description.trim();
      if (idx <= 0 || (!label && !description)) return [];
      return [{ nodeId: key.slice(0, idx), param: key.slice(idx + 2), ...(label ? { label } : {}), ...(description ? { description } : {}) }];
    }),
  });

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
      const fieldByKey = new Map(editSchema?.groups.flatMap((g) => g.fields).map((f) => [`${f.nodeId}::${f.param}`, f]) ?? []);
      const inputConfig = { version: 1, fields: [...editInputKeys].map((k) => {
        const idx = k.lastIndexOf('::'); const f = fieldByKey.get(k);
        return { nodeId: k.slice(0, idx), param: k.slice(idx + 2), kind: f?.control === 'upload' || f?.valueType === 'IMAGE' ? 'image' : 'text' };
      }) };
      const fieldConfig = buildFieldConfig(editFieldMeta, editGroupLabels);
      await request(`/api/workflows/${editing.id}`, {
        method: 'PATCH',
        data: {
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
          exposureConfig,
          inputConfig,
          fieldConfig,
        },
      });
      message.success('已保存');
      // 工作流定义可能变化，失效其 schema 缓存，下次打开运行面板重新分析
      clearSchemaCache(editing.id);
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
      setInputKeys(new Set((data.suggestedInputConfig?.fields ?? []).map((f) => `${f.nodeId}::${f.param}`)));
      setFieldMeta(Object.fromEntries((data.suggestedFieldConfig?.fields ?? []).map((f) => [`${f.nodeId}::${f.param}`, { label: f.label ?? '', description: f.description ?? '' }])));
      setGroupLabels(Object.fromEntries((data.suggestedFieldConfig?.groups ?? []).map((g) => [g.nodeId, g.label])));
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
      const fieldByKey = new Map(remotePreview?.schema?.groups.flatMap((g) => g.fields).map((f) => [`${f.nodeId}::${f.param}`, f]) ?? []);
      const inputConfig = { version: 1, fields: [...inputKeys].map((k) => {
        const idx = k.lastIndexOf('::'); const f = fieldByKey.get(k);
        return { nodeId: k.slice(0, idx), param: k.slice(idx + 2), kind: f?.control === 'upload' || f?.valueType === 'IMAGE' ? 'image' : 'text' };
      }) };
      const fieldConfig = buildFieldConfig(fieldMeta, groupLabels);
      await request('/api/comfyui/workflows/import', {
        method: 'POST',
        data: {
          filename: selectedRemote,
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
          exposure,
          inputConfig,
          fieldConfig,
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

  const startRun = (w: ComfyUIAPI) => {
    setRunWorkflow(w);
    setRunOpen(true);
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
    connectSelected?: Set<string>,
    setConnectSelected?: (next: Set<string>) => void,
    metadata: Record<string, { label: string; description: string }> = {},
    setMetadata?: (next: Record<string, { label: string; description: string }>) => void,
    groups: Record<string, string> = {},
    setGroups?: (next: Record<string, string>) => void,
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
                <Input size="small" style={{ width: 220 }} value={groups[g.nodeId] ?? g.nodeTitle} placeholder="分组名称" onChange={(e) => setGroups?.({ ...groups, [g.nodeId]: e.target.value })} />
                <span title={`${g.classType} · ${g.nodeId}`} style={{ fontSize: 11, color: '#aaa', cursor: 'help' }}>
                  技术节点：{g.classType}
                </span>
              </div>
              {g.fields.map((f) => {
                const key = `${f.nodeId}::${f.param}`;
                const connectable = f.control === 'upload' || f.valueType === 'IMAGE';
                const meta = metadata[key] ?? { label: '', description: '' };
                const updateMeta = (patch: Partial<typeof meta>) => setMetadata?.({ ...metadata, [key]: { ...meta, ...patch } });
                return (
                  <div
                    key={key}
                    style={{ padding: '6px 8px', marginLeft: 8, marginBottom: 6, border: '1px solid #f0f0f0', borderRadius: 6 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <Checkbox checked={selected.has(key)} onChange={(e) => toggle(key, e.target.checked)}>
                        <span style={{ fontSize: 13 }}>{f.param}</span>
                      </Checkbox>
                      <Tag style={{ fontSize: 11 }}>{controlLabel(f.control)}</Tag>
                      {connectable && connectSelected && setConnectSelected ? (
                        <Checkbox checked={connectSelected.has(key)} onChange={(e) => {
                          const next = new Set(connectSelected); if (e.target.checked) next.add(key); else next.delete(key); setConnectSelected(next);
                        }}>允许连线</Checkbox>
                      ) : null}
                      <span title={previewValue(f.current)} style={{ fontSize: 11, color: '#bbb', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>当前值：{previewValue(f.current)}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 0.7fr) minmax(240px, 1.3fr)', gap: 8 }}>
                      <Input size="small" value={meta.label} placeholder="显示名称，例如：重绘强度" onChange={(e) => updateMeta({ label: e.target.value })} />
                      <Input size="small" value={meta.description} placeholder="使用建议，例如：0.3–0.55 保留原图，0.65–0.8 明显重绘" onChange={(e) => updateMeta({ description: e.target.value })} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
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
        <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
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
      onClick={(e) => {
        // 点击操作区（查看/编辑/运行/删除）或删除确认弹层（含 portal 冒泡）时都不打开详情页
        const t = e.target as HTMLElement;
        const actionsEl = (e.currentTarget as HTMLElement).querySelector('.ant-card-actions');
        if (actionsEl && actionsEl.contains(t)) return;
        if (t.closest && t.closest('.ant-popover, .ant-popconfirm')) return;
        onView(w);
      }}
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
        <Button type="primary" icon={<DownloadOutlined />} onClick={openRemoteImport}>
          从 ComfyUI 导入
        </Button>
        <Button icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
          导入 ComfyUI API
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
          scroll={{ x: 'max-content' }}
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
          renderExposureSelector(editSchema, editExposureKeys, setEditExposureKeys, editInputKeys, setEditInputKeys, editFieldMeta, setEditFieldMeta, editGroupLabels, setEditGroupLabels)
        )}
        <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
          当前 JSON 节点数：{editing ? Object.keys(editing.apiJson as object).length : 0}
        </Paragraph>
      </Modal>
      <ComfyRunModal
        open={runOpen}
        workflow={runWorkflow}
        onClose={() => setRunOpen(false)}
        onCoverSaved={load}
      />

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
              {renderExposureSelector(remotePreview.schema, exposureKeys, setExposureKeys, inputKeys, setInputKeys, fieldMeta, setFieldMeta, groupLabels, setGroupLabels)}
            </>
          ) : (
            <Empty description={remoteLoading ? '正在拉取工作流列表…' : '请选择工作流进行预览'} />
          )}
        </Form>
      </Modal>

    </div>
  );
}
