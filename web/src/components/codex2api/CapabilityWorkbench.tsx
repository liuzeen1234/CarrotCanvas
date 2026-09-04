import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Form, Image, Input, Modal, Progress, Row,
  Segmented, Select, Space, Switch, Tabs, Tag, Typography, Upload, message,
} from 'antd';
import {
  ApiOutlined, CloudSyncOutlined, DownloadOutlined, EditOutlined, EyeOutlined,
  FileImageOutlined, MessageOutlined, PlayCircleOutlined, SettingOutlined, UploadOutlined,
} from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import { request } from 'umi';
import { CodexImageResponse, errorMessage, imageSource, postForm, postJson, streamChat } from './client';

const { Title, Text, Paragraph } = Typography;
const DEFAULT_MODEL = 'codex';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];

function ResultImages({ result }: { result: CodexImageResponse | null }) {
  if (!result?.data?.length) return null;
  return <Image.PreviewGroup><Row gutter={[16, 16]}>{result.data.map((item, index) => {
    const src = imageSource(item);
    return <Col xs={24} md={12} xl={8} key={`${src.slice(0, 60)}-${index}`}>
      <Card className="codex-workbench__result-card" size="small" cover={<Image src={src} alt={`生成图片 ${index + 1}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'contain', background: '#f5f5f5' }} />}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {item.revised_prompt ? <Text type="secondary">{item.revised_prompt}</Text> : null}
          <Button icon={<DownloadOutlined />} href={item.downloadUrl || src} download={`codex-image-${index + 1}.png`} block>下载图片</Button>
        </Space>
      </Card>
    </Col>;
  })}</Row></Image.PreviewGroup>;
}

function Busy({ label }: { label: string }) {
  return <div style={{ padding: '18px 0' }}><Progress percent={55} showInfo={false} status="active" /><Text type="secondary">{label}</Text></div>;
}

function UploadPicker({ files, onChange }: { files: UploadFile[]; onChange: (files: UploadFile[]) => void }) {
  return <Upload
    accept="image/*" listType="picture-card" fileList={files}
    beforeUpload={() => false}
    onChange={({ fileList }) => onChange(fileList.slice(-10))}
    onPreview={(file) => { const src = file.url || file.thumbUrl; if (src) window.open(src, '_blank'); }}
  >{files.length < 10 ? <div><UploadOutlined /><div style={{ marginTop: 8 }}>选择图片</div></div> : null}</Upload>;
}

export default function CapabilityWorkbench() {
  const [configOpen, setConfigOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://localhost:3010');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [health, setHealth] = useState<'unknown' | 'checking' | 'ok' | 'error'>('unknown');
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);

  const refreshStatus = async () => {
    setHealth('checking');
    try {
      const [status, list] = await Promise.all([
        request<{ status: string }>('/api/codex2api/health'),
        request<{ data?: { id: string }[] }>('/api/codex2api/models'),
      ]);
      if (status.status !== 'ok') throw new Error('健康检查返回异常');
      setModels(list.data?.map((item) => item.id) || [DEFAULT_MODEL]);
      setHealth('ok');
    } catch (error) {
      setHealth('error');
      message.error(errorMessage(error));
    }
  };

  useEffect(() => {
    request<{ baseUrl: string; hasApiKey: boolean }>('/api/codex2api/config').then((config) => {
      setBaseUrl(config.baseUrl);
      setHasApiKey(config.hasApiKey);
      void refreshStatus();
    }).catch(() => setHealth('error'));
  }, []);

  const saveConfig = async (clearApiKey = false) => {
    try {
      const config = await request<{ baseUrl: string; hasApiKey: boolean }>('/api/codex2api/config', {
        method: 'PUT', data: { baseUrl, apiKey: apiKey || undefined, clearApiKey },
      });
      setBaseUrl(config.baseUrl); setHasApiKey(config.hasApiKey); setApiKey(''); setConfigOpen(false);
      message.success('Codex2API 配置已保存');
      void refreshStatus();
    } catch (error) { message.error(errorMessage(error)); }
  };

  const modelOptions = useMemo(() => models.map((id) => ({ label: id, value: id })), [models]);

  return <div className="codex-workbench__stack">
    <div className="codex-workbench__header">
      <div><Title level={3} style={{ margin: 0 }}>AI 能力工具箱</Title><Paragraph type="secondary" style={{ margin: '6px 0 0' }}>统一调用 Codex2API 的文本、图像生成与理解能力</Paragraph></div>
      <Space className="codex-workbench__actions" wrap>
        <Tag icon={<CloudSyncOutlined />} color={health === 'ok' ? 'success' : health === 'error' ? 'error' : 'processing'}>{health === 'ok' ? '服务正常' : health === 'error' ? '服务不可用' : '检查中'}</Tag>
        <Button icon={<CloudSyncOutlined />} loading={health === 'checking'} onClick={() => void refreshStatus()}>检查连接</Button>
        <Button icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>服务配置</Button>
      </Space>
    </div>
    <Tabs className="codex-workbench__tabs" size="small" type="card" tabBarGutter={0} destroyInactiveTabPane={false} items={[
      { key: 'text', label: <span><MessageOutlined /> 文生文</span>, children: <TextTool models={modelOptions} /> },
      { key: 'image', label: <span><FileImageOutlined /> 文生图</span>, children: <GenerateTool models={modelOptions} /> },
      { key: 'edit', label: <span><EditOutlined /> 图生图</span>, children: <EditTool models={modelOptions} /> },
      { key: 'analyze', label: <span><EyeOutlined /> 图像理解</span>, children: <AnalyzeTool models={modelOptions} /> },
    ]} />
    <Modal title="Codex2API 服务配置" open={configOpen} onCancel={() => setConfigOpen(false)} onOk={() => void saveConfig()} okText="保存并检查" cancelText="取消">
      <Form layout="vertical">
        <Form.Item label="服务地址"><Input prefix={<ApiOutlined />} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3010" /></Form.Item>
        <Form.Item label="API Key（可选）" extra={hasApiKey ? '已保存 API Key；留空不会覆盖。' : '服务未启用鉴权时可留空。'}><Input.Password value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" /></Form.Item>
        {hasApiKey ? <Button danger onClick={() => void saveConfig(true)}>清除已保存的 API Key</Button> : null}
      </Form>
    </Modal>
  </div>;
}

function TextTool({ models }: { models: { label: string; value: string }[] }) {
  const [prompt, setPrompt] = useState('请用简洁的中文解释：为什么天空通常看起来是蓝色的？');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const run = async () => {
    setBusy(true); setError(''); setOutput('');
    const controller = new AbortController(); abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 300_000);
    try {
      const body = { model, messages: [{ role: 'user', content: prompt }] };
      if (stream) await streamChat(body, (delta) => setOutput((value) => value + delta), controller.signal);
      else {
        const result = await postJson<any>('/api/codex2api/chat/completions', { ...body, stream: false }, controller.signal);
        setOutput(result?.choices?.[0]?.message?.content || '未返回文本内容');
      }
    } catch (e) { setError(errorMessage(e)); } finally { clearTimeout(timer); setBusy(false); abortRef.current = null; }
  };
  return <ToolCard title="文生文" description="支持普通响应与实时流式输出。">
    <Form layout="vertical"><Form.Item label="提示词"><Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Form.Item>
      <Row gutter={16}><Col xs={24} sm={12}><Form.Item label="模型"><Select value={model} options={models} onChange={setModel} /></Form.Item></Col><Col xs={24} sm={12}><Form.Item label="流式响应"><Switch checked={stream} onChange={setStream} checkedChildren="SSE" unCheckedChildren="普通" /></Form.Item></Col></Row>
      <Space><Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!prompt.trim()} onClick={() => void run()}>运行</Button>{busy ? <Button onClick={() => abortRef.current?.abort()}>取消</Button> : null}</Space>
    </Form>{error ? <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} /> : null}{busy && !output ? <Busy label={stream ? '等待首段内容…' : '正在生成文本…'} /> : null}{output ? <Card size="small" title={busy ? '正在输出…' : '生成结果'} style={{ marginTop: 16 }}><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{output}</div></Card> : null}
  </ToolCard>;
}

function GenerateTool({ models }: { models: { label: string; value: string }[] }) {
  const [prompt, setPrompt] = useState('一只戴着护目镜的橙色兔子，在未来感画室里操作发光的绘图台，电影级光影');
  const [model, setModel] = useState(DEFAULT_MODEL); const [size, setSize] = useState('1024x1024'); const [format, setFormat] = useState('url');
  const [result, setResult] = useState<CodexImageResponse | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setError(''); setResult(null); try { setResult(await postJson('/api/codex2api/images/generations', { prompt, model, n: 1, size, response_format: format })); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  return <ToolCard title="文生图" description="从提示词生成图片，支持 URL 与 Base64 返回。"><ImageForm prompt={prompt} setPrompt={setPrompt} model={model} setModel={setModel} models={models} size={size} setSize={setSize} format={format} setFormat={setFormat} busy={busy} run={run} />{busy ? <Busy label="正在生成图片，可能需要几分钟…" /> : null}{error ? <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} /> : null}<ResultImages result={result} /></ToolCard>;
}

function EditTool({ models }: { models: { label: string; value: string }[] }) {
  const [files, setFiles] = useState<UploadFile[]>([]); const [prompt, setPrompt] = useState('保留主体构图，把场景改成温暖的日落海边，写实摄影风格');
  const [model, setModel] = useState(DEFAULT_MODEL); const [size, setSize] = useState('1024x1024'); const [format, setFormat] = useState('url'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<CodexImageResponse | null>(null);
  const run = async () => { if (!files.length) return message.warning('请先选择图片'); const form = new FormData(); files.forEach((file) => file.originFileObj && form.append('image', file.originFileObj)); form.append('prompt', prompt); form.append('model', model); form.append('n', '1'); form.append('size', size); form.append('response_format', format); setBusy(true); setError(''); setResult(null); try { setResult(await postForm('/api/codex2api/images/edits', form)); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  return <ToolCard title="图生图" description="上传一张或多张参考图并描述需要的修改。"><UploadPicker files={files} onChange={setFiles} /><ImageForm prompt={prompt} setPrompt={setPrompt} model={model} setModel={setModel} models={models} size={size} setSize={setSize} format={format} setFormat={setFormat} busy={busy} run={run} disabled={!files.length} />{busy ? <Busy label="正在编辑图片，可能需要几分钟…" /> : null}{error ? <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} /> : null}<ResultImages result={result} /></ToolCard>;
}

function AnalyzeTool({ models }: { models: { label: string; value: string }[] }) {
  const presets: Record<string, string> = { 描述: '请详细描述图片中的内容。', OCR: '请识别并逐行输出图片中的所有文字，尽量保持原有结构。', 构图: '请分析图片的构图、视觉动线、主体层次与画面平衡。', 风格: '请分析图片的艺术风格、色彩、光影、材质与可能使用的创作技法。' };
  const [files, setFiles] = useState<UploadFile[]>([]); const [prompt, setPrompt] = useState(presets.描述); const [model, setModel] = useState(DEFAULT_MODEL); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [text, setText] = useState('');
  const run = async () => { if (!files.length) return message.warning('请先选择图片'); const form = new FormData(); files.forEach((file) => file.originFileObj && form.append('image', file.originFileObj)); form.append('prompt', prompt); form.append('model', model); setBusy(true); setError(''); setText(''); try { const result = await postForm<any>('/api/codex2api/images/analyze', form); setText(result.text || result.data?.[0]?.text || '未返回分析文本'); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  return <ToolCard title="图像理解" description="支持图片描述、OCR、构图与风格分析，也可输入自定义要求。"><UploadPicker files={files} onChange={setFiles} /><Form layout="vertical"><Form.Item label="分析类型"><Segmented block options={Object.keys(presets)} onChange={(key) => setPrompt(presets[String(key)])} /></Form.Item><Form.Item label="分析提示词"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Form.Item><Form.Item label="模型"><Select value={model} options={models} onChange={setModel} /></Form.Item><Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!files.length || !prompt.trim()} onClick={() => void run()}>开始分析</Button></Form>{busy ? <Busy label="正在理解图片…" /> : null}{error ? <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} /> : null}{text ? <Card size="small" title="分析结果" style={{ marginTop: 16 }}><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{text}</div></Card> : null}</ToolCard>;
}

function ToolCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <Card className="codex-workbench__tool-card"><Title level={4}>{title}</Title><Paragraph type="secondary">{description}</Paragraph>{children}</Card>; }

function ImageForm(props: { prompt: string; setPrompt: (v: string) => void; model: string; setModel: (v: string) => void; models: { label: string; value: string }[]; size: string; setSize: (v: string) => void; format: string; setFormat: (v: string) => void; busy: boolean; run: () => void; disabled?: boolean }) {
  return <Form layout="vertical"><Form.Item label="提示词"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} value={props.prompt} onChange={(e) => props.setPrompt(e.target.value)} /></Form.Item><Row gutter={16}><Col xs={24} md={8}><Form.Item label="模型"><Select value={props.model} options={props.models} onChange={props.setModel} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="尺寸"><Select value={props.size} options={sizes.map((value) => ({ value, label: value }))} onChange={props.setSize} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="返回格式"><Select value={props.format} options={[{ value: 'url', label: 'URL' }, { value: 'b64_json', label: 'Base64' }]} onChange={props.setFormat} /></Form.Item></Col></Row><Button type="primary" icon={<PlayCircleOutlined />} loading={props.busy} disabled={props.disabled || !props.prompt.trim()} onClick={props.run}>生成图片</Button></Form>;
}
