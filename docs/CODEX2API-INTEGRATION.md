# Codex2API 集成

> 创建：2026-09-04

## 定位

Codex2API 是独立于 ComfyUI 工作流的通用能力提供方。CarrotCanvas 通过统一的“AI 能力”工具箱提供文生文、文生图、图生图和图像理解，并在画布右键菜单中提供对应能力节点。后续接入其他 HTTP API 能力时，应沿用“能力提供方 + 独立能力项”的结构，不混入 ComfyUI 工作流库。

## 入口与配置

- 一级菜单 `/capabilities`：四种能力的可运行工具箱。
- 画布空白处右键或移动端长按：`AI 能力（Codex2API）` 下创建能力节点。
- 默认地址 `http://localhost:3010`，API Key 可选；密钥保存在后端设置表，前端只读取 `hasApiKey`，不读取明文。

## 调用架构

浏览器只访问 `/api/codex2api/*`，由 CarrotCanvas 后端转发到用户配置的服务地址，以规避跨域限制并集中注入 Bearer Key、超时与错误处理。multipart 请求由浏览器和 Node fetch 自动生成 boundary，不手写 `Content-Type`。

- `POST /api/codex2api/chat/completions`：透传 JSON 或 SSE。
- `POST /api/codex2api/images/generations`：文生图。
- `POST /api/codex2api/images/edits`：图生图 multipart。
- `POST /api/codex2api/images/analyze`：图像理解 multipart。
- `GET /api/codex2api/health`、`GET /api/codex2api/models`：状态和模型。

画布内文生图/图生图会把 URL 或 Base64 结果捕获到现有画布资产库，节点只持久化资产引用。工具箱结果保持 Codex2API 原始 URL/Base64 表现形式。

## 画布文本连线

- 文生文、图像理解的结果通过 `text` 输出句柄提供给下游。
- 四类能力卡片的提示词均提供 `text` 输入句柄；连接后使用上游最后一次完整的 `lastText` 覆盖本地提示词，断开后恢复本地值。
- 每个提示词输入只允许一个来源，新连线替换旧连线；画布禁止自连和形成环路。
- 上游尚未运行或未返回文本时，下游不可运行；流式生成过程中的临时文本不会作为输入，只有完成后持久化的结果可供下游使用。
- 把 `text` 输出拖到画布空白处，可直接创建任一 Codex2API 能力卡片并自动连接其提示词；把 `image` 输出拖到空白处，可创建图生图或图像理解卡片并自动连接图片输入。
- `text` 输出也可连接到已在导入/编辑阶段标记为“允许文本连线”的 ComfyUI STRING 字段，或拖到空白处创建首个兼容工作流节点。
- 画布内 Codex2API 与 ComfyUI 文本框使用 IME 组合输入保护：中文拼音组合完成后再回写节点状态，避免移动端受控重渲染造成重复或乱码。

## 当前限制

- 画布节点本地上传的图片只保留在当前页面会话；刷新后需重新选择，连接上游画布资产不受影响。
- Codex2API OpenAPI 当前未描述细粒度进度事件，图片类请求只能展示“处理中”状态，不能显示真实百分比。
