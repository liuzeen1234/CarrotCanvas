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
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  UploadOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { request } from 'umi';

export interface Workflow {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  tags: string[] | null;
  apiJson: unknown;
  thumbnailPath: string | null;
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

const { Paragraph } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  txt2img: 'blue',
  img2img: 'green',
  txt2vid: 'purple',
  img2vid: 'cyan',
  vid2vid: 'orange',
  reference: 'gold',
};

let onView: (w: Workflow) => void = () => {};
let onEdit: (w: Workflow) => void = () => {};
let onDelete: (id: string) => void = () => {};

export default function WorkflowManager() {
  const [list, setList] = useState<Workflow[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<Workflow | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [editForm] = Form.useForm();
  const [importForm] = Form.useForm();
  const [activeTab, setActiveTab] = useState('file');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<Workflow[]>('/api/workflows');
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
  }, [load, loadCategories]);

  const columns: ColumnsType<Workflow> = [
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
      width: 200,
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => onView(record)}>
            查看
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该工作流？"
            onConfirm={() => onDelete(record.id)}
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
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
    setEditOpen(true);
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

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      importForm.setFieldValue('jsonText', String(reader.result));
      message.success('已读取文件内容');
    };
    reader.readAsText(file);
    return false;
  };

  const handleEditSave = async () => {
    if (!editing) return;
    const values = await editForm.validateFields();
    try {
      await request(`/api/workflows/${editing.id}`, {
        method: 'PATCH',
        data: {
          name: values.name,
          category: values.category,
          description: values.description,
          tags: values.tags,
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

  const preview = (w: Workflow) => (
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

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
          导入工作流
        </Button>
        <Button onClick={load}>刷新</Button>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="从 ComfyUI 导出的 API（Save (API Format)）JSON 可直接导入保存。保存时仅校验格式，实际与 ComfyUI 的连接在运行时检测。"
      />

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={list}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="导入工作流"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={handleImport}
        confirmLoading={importing}
        okText="导入并保存"
        width={640}
      >
        <Form form={importForm} layout="vertical" initialValues={{ name: '', tags: [] }}>
          <Form.Item
            label="工作流名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="例如：文生图基础流程" />
          </Form.Item>
          <Form.Item
            label="工作流类型"
            name="category"
            rules={[{ required: true, message: '请选择类型' }]}
          >
            <Select placeholder="选择工作流类型">
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
                <Upload.Dragger beforeUpload={handleFile} showUploadList={false} maxCount={1}>
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
        title="工作流详情"
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width={720}
      >
        {detail && preview(detail)}
      </Modal>

      <Modal
        title="编辑工作流"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={handleEditSave}
        okText="保存"
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
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          当前 JSON 节点数：{editing ? Object.keys(editing.apiJson as object).length : 0}
        </Paragraph>
      </Modal>
    </div>
  );
}
