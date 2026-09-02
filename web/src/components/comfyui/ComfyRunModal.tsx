/**
 * CarrotCanvas 设置页「运行工作流」面板（C4 抽取）。
 * 完整 Modal：左栏参数表单（自动表单 / JSON 切换）+ 右栏进度与结果。
 * 组合 useComfyRun + ComfySchemaForm；画布生成节点（C5/C6）复用同样的钩子与表单组件。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Col,
  Empty,
  Input,
  Modal,
  Progress,
  Row,
  Segmented,
  Space,
  Tag,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  DownloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { request } from 'umi';
import { ComfySchemaForm } from './ComfySchemaForm';
import { ComfyUIAPI, RunMode, RunOutputFile, RunStateData } from './types';
import { useComfyRun } from './useComfyRun';

export interface ComfyRunModalProps {
  open: boolean;
  workflow: ComfyUIAPI | null;
  onClose: () => void;
  /** 封面（作为封面）变化后回调，用于刷新列表 */
  onCoverSaved?: () => void;
}

/** 运行状态 → Tag（画布节点亦可复用） */
export const runStatusTag = (status: string) => {
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

/** 运行进度条（画布节点亦可复用） */
export const runProgress = (run: RunStateData) => {
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

export default function ComfyRunModal({ open, workflow, onClose, onCoverSaved }: ComfyRunModalProps) {
  const run = useComfyRun({ workflow });
  // 正在设置封面的图片 url（用于按钮 loading）
  const [settingCoverUrl, setSettingCoverUrl] = useState<string | null>(null);

  // 每次打开（或切换工作流）时重置并重新初始化表单
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current && workflow) {
      void run.init(workflow);
    }
    prevOpen.current = open;
    // run.init 为稳定引用，这里仅需响应 open / workflow 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflow?.id]);

  const handleClose = () => {
    run.reset();
    onClose();
  };

  const handleRunSubmit = async () => {
    const ok = await run.submit();
    if (!ok) {
      message.error(`参数解析失败：${run.formError || 'JSON 格式错误'}`);
    }
  };

  const handleInterrupt = async () => {
    try {
      await run.interrupt();
      message.info('已发送中断请求');
    } catch (e: any) {
      message.error(`中断失败：${e?.response?.data?.message || '未知错误'}`);
    }
  };

  /** 把某张结果图设为该工作流的卡片封面 */
  const setAsCover = async (o: RunOutputFile) => {
    if (!workflow) return;
    setSettingCoverUrl(o.url);
    try {
      await request(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        data: { thumbnailPath: o.url },
      });
      message.success('已设为封面');
      onCoverSaved?.();
    } catch (e: any) {
      message.error(`设置封面失败：${e?.response?.data?.message || '未知错误'}`);
    } finally {
      setSettingCoverUrl(null);
    }
  };

  const handleDownload = async (o: RunOutputFile) => {
    try {
      await run.downloadOutput(o);
    } catch (e: any) {
      message.error(`下载失败：${e?.message || '未知错误'}`);
    }
  };

  const running = !!run.runState && ['pending', 'running'].includes(run.runState.status);

  return (
    <Modal
      title={
        <Space>
          <PlayCircleOutlined />
          运行工作流{workflow ? `：${workflow.name}` : ''}
          {run.runState ? runStatusTag(run.runState.status) : null}
        </Space>
      }
      open={open}
      onCancel={handleClose}
      footer={() => (
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleRunSubmit}
            disabled={run.schemaLoading || running}
            loading={running}
          >
            {run.runState && !running ? '重新运行' : '提交运行'}
          </Button>
          {running && (
            <Button icon={<StopOutlined />} danger onClick={handleInterrupt}>
              中断运行
            </Button>
          )}
          <Button onClick={handleClose}>关闭</Button>
        </Space>
      )}
      width={1080}
    >
      <Row gutter={20}>
        {/* 左栏：参数表单（始终展示，运行中禁用） */}
        <Col span={13} style={{ borderRight: '1px solid #f0f0f0' }}>
          <Space style={{ marginBottom: 12 }} wrap>
            <Segmented
              value={run.mode}
              disabled={running}
              onChange={(v) => run.setMode(v as RunMode)}
              options={[
                { value: 'form', label: '自动表单' },
                { value: 'json', label: 'JSON 模式' },
              ]}
            />
            {run.schema && (
              <span style={{ color: '#888', fontSize: 12 }}>
                可编辑参数 {run.schema.editableCount} 项 / {run.schema.nodeCount} 节点
              </span>
            )}
          </Space>

          {run.formError && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={run.formError} />
          )}
          {run.schema?.warnings?.length ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="部分节点未解析"
              description={run.schema.warnings.join('；')}
            />
          ) : null}

          {run.mode === 'form' ? (
            <ComfySchemaForm
              schema={run.schema}
              schemaLoading={run.schemaLoading}
              values={run.formValues}
              onChange={run.handleFormChange}
              disabled={running}
              exposure={workflow?.exposureConfig ?? null}
              onUploadImage={run.uploadImage}
              uploading={run.uploading}
              maxHeight="58vh"
            />
          ) : (
            <Input.TextArea
              rows={18}
              value={run.jsonText}
              disabled={running}
              onChange={(e) => run.setJsonText(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          )}
        </Col>

        {/* 右栏：进度 + 结果预览 */}
        <Col span={11}>
          {!run.runState ? (
            <Empty
              style={{ marginTop: 80 }}
              description="点击“提交运行”后，这里会显示进度与结果"
            />
          ) : (
            <div>
              <Space style={{ marginBottom: 8 }} wrap>
                <span style={{ color: '#555' }}>
                  当前节点：
                  <b>
                    {run.runState.currentNodeTitle ||
                      (run.runState.currentNode && run.runState.nodeTitles?.[run.runState.currentNode]) ||
                      run.runState.currentNode ||
                      '—'}
                  </b>
                </span>
                {run.runState.currentNode && (
                  <span style={{ color: '#999', fontSize: 12 }}>（{run.runState.currentNode}）</span>
                )}
              </Space>
              <div style={{ marginBottom: 16 }}>{runProgress(run.runState)}</div>

              {run.runState.error && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="运行失败"
                  description={
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
                      {run.runState.error}
                    </pre>
                  }
                />
              )}

              {run.runState.status === 'success' && !run.runState.outputs?.length && (
                <Alert type="success" showIcon style={{ marginBottom: 16 }} message="运行完成，但没有可预览的输出" />
              )}

              {run.runState.outputs?.length > 0 && (
                <div style={{ maxHeight: '58vh', overflow: 'auto', paddingRight: 4 }}>
                  <div style={{ marginBottom: 8, fontWeight: 500 }}>输出结果：</div>
                  <Row gutter={[12, 12]}>
                    {run.runState.outputs.map((o, i) => (
                      <Col span={12} key={`${o.url}-${i}`}>
                        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 6 }}>
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
                          <div style={{ fontSize: 11, color: '#888', margin: '4px 0', wordBreak: 'break-all' }}>
                            {o.filename}
                          </div>
                          <Space size={4} wrap>
                            <Button size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(o)}>
                              保存图片
                            </Button>
                            {o.kind === 'image' && (
                              <Button
                                size="small"
                                icon={<AppstoreOutlined />}
                                loading={settingCoverUrl === o.url}
                                onClick={() => setAsCover(o)}
                              >
                                作为封面
                              </Button>
                            )}
                          </Space>
                        </div>
                      </Col>
                    ))}
                  </Row>
                </div>
              )}
            </div>
          )}
        </Col>
      </Row>
    </Modal>
  );
}
