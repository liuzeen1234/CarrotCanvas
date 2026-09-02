import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ArrowRightOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import { history, request } from 'umi';

const { Title, Text } = Typography;

/** 画布列表项（后端只回元信息，不回大 graph） */
interface CanvasListItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  assetSize: number;
}

/** 字节数格式化：B / KB / MB */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** ISO 时间 → YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CanvasListPage() {
  const [list, setList] = useState<CanvasListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // 重命名弹窗状态
  const [renameTarget, setRenameTarget] = useState<CanvasListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<CanvasListItem[]>('/api/canvas');
      setList(data ?? []);
    } catch (e: any) {
      message.error(`加载画布列表失败：${e?.response?.data?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 新建画布 → 打开编辑器 */
  const handleCreate = async () => {
    setCreating(true);
    try {
      const doc = await request<{ id: string }>('/api/canvas', {
        method: 'POST',
        data: {},
      });
      message.success('已新建画布');
      history.push(`/canvas/${doc.id}`);
    } catch (e: any) {
      message.error(`新建画布失败：${e?.response?.data?.message || '未知错误'}`);
    } finally {
      setCreating(false);
    }
  };

  /** 打开重命名弹窗 */
  const openRename = (item: CanvasListItem) => {
    setRenameTarget(item);
    setRenameValue(item.name);
  };

  /** 提交重命名 */
  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      message.warning('画布名不能为空');
      return;
    }
    setRenaming(true);
    try {
      await request(`/api/canvas/${renameTarget.id}`, {
        method: 'PATCH',
        data: { name },
      });
      message.success('已重命名');
      setRenameTarget(null);
      load();
    } catch (e: any) {
      message.error(`重命名失败：${e?.response?.data?.message || '未知错误'}`);
    } finally {
      setRenaming(false);
    }
  };

  /** 删除画布（级联清理资产） */
  const handleDelete = async (item: CanvasListItem) => {
    try {
      await request(`/api/canvas/${item.id}`, { method: 'DELETE' });
      message.success(`已删除「${item.name}」`);
      load();
    } catch (e: any) {
      message.error(`删除失败：${e?.response?.data?.message || '未知错误'}`);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            画布工作台
          </Title>
          <Text type="secondary">多张独立画布 · 流程节点编排 · 资产按画布分区自包含</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={handleCreate}>
          新建画布
        </Button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <Empty description="还没有画布，创建一张开始编排吧">
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} loading={creating}>
              新建画布
            </Button>
          </Empty>
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {list.map((item) => (
            <Card
              key={item.id}
              hoverable
              onClick={() => history.push(`/canvas/${item.id}`)}
              actions={[
                <span
                  key="open"
                  onClick={(e) => {
                    e.stopPropagation();
                    history.push(`/canvas/${item.id}`);
                  }}
                >
                  <ArrowRightOutlined /> 打开
                </span>,
                <span
                  key="rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    openRename(item);
                  }}
                >
                  <EditOutlined /> 重命名
                </span>,
                <span key="delete" onClick={(e) => e.stopPropagation()}>
                  <Popconfirm
                    title={`删除画布「${item.name}」？`}
                    description="将同时删除该画布的全部资产文件与记录，且不可恢复。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => handleDelete(item)}
                  >
                    <span style={{ color: '#ff4d4f' }}>
                      <DeleteOutlined /> 删除
                    </span>
                  </Popconfirm>
                </span>,
              ]}
            >
              <Card.Meta
                avatar={<FolderOpenOutlined style={{ fontSize: 28, color: '#fa8c16' }} />}
                title={<span style={{ fontSize: 16 }}>{item.name}</span>}
                description={
                  <div>
                    <div>
                      <Tag color="blue">{item.nodeCount} 个节点</Tag>
                      <Tag color="green">资产 {formatBytes(item.assetSize)}</Tag>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                      更新于 {formatTime(item.updatedAt)}
                    </div>
                  </div>
                }
              />
            </Card>
          ))}
        </div>
      )}

      {/* 重命名弹窗 */}
      <Modal
        title="重命名画布"
        open={renameTarget !== null}
        onOk={submitRename}
        onCancel={() => setRenameTarget(null)}
        confirmLoading={renaming}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="画布名称"
          maxLength={60}
          onPressEnter={submitRename}
          autoFocus
        />
      </Modal>
    </div>
  );
}
