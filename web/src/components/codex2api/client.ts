export interface CodexImageItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  assetId?: string;
  downloadUrl?: string;
}

export interface CodexImageResponse {
  created?: number;
  data: CodexImageItem[];
}

export const imageSource = (item: CodexImageItem) =>
  item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');

export async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    return payload?.message || payload?.error?.message || `请求失败（HTTP ${response.status}）`;
  } catch {
    return text || `请求失败（HTTP ${response.status}）`;
  }
}

/** 按 SSE 事件边界增量解析 data 行；支持任意网络分片以及 [DONE]。 */
export async function streamChat(
  body: { model: string; messages: { role: string; content: string }[] },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) {
  const response = await fetch('/api/codex2api/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error('浏览器未收到流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const consume = (event: string) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { done = true; return; }
    let payload: any;
    try { payload = JSON.parse(data); }
    catch { throw new Error('收到无法解析的 SSE 数据'); }
    if (payload?.error) throw new Error(payload.error.message || 'Codex2API 流式响应出错');
    const delta = payload?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') onDelta(delta);
  };
  while (!done) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) consume(event);
    if (chunk.done) { if (buffer.trim()) consume(buffer); break; }
  }
  await reader.cancel().catch(() => undefined);
}

export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || '后端返回错误');
  return payload as T;
}

export async function postForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  // 不设置 Content-Type；浏览器会自动附加 multipart boundary。
  const response = await fetch(path, { method: 'POST', body: form, signal });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || '后端返回错误');
  return payload as T;
}

export const errorMessage = (error: unknown) => {
  if ((error as Error)?.name === 'AbortError') return '请求已取消或超时';
  return (error as Error)?.message || '网络请求失败';
};
