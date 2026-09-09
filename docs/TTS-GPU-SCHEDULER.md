# 本地 TTS 与 ComfyUI 统一 GPU 调度

## 目标

在同一张 NVIDIA GPU 上统一调度 `comfyui`、`cosyvoice3`、`indextts2` 三个 Provider。画布仍是唯一运行入口；任一时刻只允许一个 Provider 进程在线并持有 GPU 模型，避免已卸载模型仍以 Python 进程、RAM 或页面文件形式残留。

对应需求：[GitHub Issue #11](https://github.com/liuzeen1234/CarrotCanvas/issues/11)。

## 已拍板设计

- CosyVoice 3 与 IndexTTS2 使用各自独立的 Python 3.10 环境，worker 由调度器按需启动，切出时退出整个进程，不只调用模型 `/unload`。
- TTS 进程退出最多尝试 3 次：先请求优雅关闭，再升级到结束进程；每次记录 PID、端口、RSS 与 CUDA reserved。只有端口消失且原 PID 不存在才算释放成功。
- ComfyUI 运行也必须先取得相同的持久化 FIFO 租约。调度器托管的 ComfyUI 切出时等待队列清空，再按进程树退出，并在每次尝试前后记录端口所有者、working set/private bytes、Comfy allocator 与 `nvidia-smi` 整卡显存。
- 8188 若属于非调度器 PID，或检测到 ComfyUI Desktop，返回 `COMFYUI_TAKEOVER_REQUIRED` 并锁住后续队列。页面必须由用户确认后才关闭 Desktop/相关进程、保存启动参数并改由调度器启动纯后端；未知外部进程以后仍会再次询问。
- 连续运行同一 Provider 时允许模型驻留，避免重复加载；切换 Provider 时严格串行执行 `release(old) → prepare(new)`。
- 租约写入 SQLite `gpu_resource_leases`。后端重启时把未完成租约标记为 `abandoned`，不把陈旧状态当作仍在占用。
- 两个 TTS worker 内部对 load、infer、unload 加互斥锁，平台之外的误调用也不会在同一 worker 内并发改动模型。
- 任一旧 Provider 连续 3 次仍未完全退出，调度器进入 fail-closed 锁定态，持久化原因与三次观测，拒绝继续启动下一个 Provider。

## 本地目录与模型来源

运行时文件均位于被 Git 忽略的 `backend/data/` 下：

| 内容 | 本地位置 | 来源 |
|---|---|---|
| CosyVoice 源码 | `backend/data/tts-runtime/CosyVoice` | FunAudioLLM/CosyVoice 官方仓库 |
| IndexTTS 源码 | `backend/data/tts-runtime/index-tts` | index-tts/index-tts 官方仓库 |
| CosyVoice 3 权重 | `backend/data/tts-models/Fun-CosyVoice3-0.5B-2512` | ModelScope `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` |
| IndexTTS2 权重 | `backend/data/tts-models/IndexTTS-2` | ModelScope `IndexTeam/IndexTTS-2` |

主模型及可用的辅助权重固定优先使用 ModelScope。IndexTTS2 所需的 `nvidia/bigvgan_v2_22khz_80band_256x` 在 ModelScope 主站和备用站均不存在，官方加载器收到 404 后仅对该约 449 MB 辅助声码器回退到 hf-mirror；其余权重均来自 ModelScope。不要把模型、Python 环境或运行日志提交进 Git。

## 接口与画布节点

- `GET /api/gpu-scheduler/status`：当前租约、驻留 Provider 与等待队列。
- `GET /api/tts/providers`：两个 worker 的在线及模型加载状态。
- `GET /api/comfyui/process-status`：8188 所有者、Desktop 进程、进程内存及显存观测。
- `POST /api/comfyui/takeover/confirmation`：针对当前端口所有者和 Desktop 进程集合签发 5 分钟有效、一次性使用的确认令牌，并返回供页面或 AI 对话展示的快照。
- `POST /api/comfyui/takeover`：只接受显式 `confirm=true` 与有效确认令牌；执行前重新核验进程快照，关闭 Desktop 后保存并启动调度器托管的 ComfyUI 后端，同时解除因该冲突产生的队列锁。
- `POST /api/tts/runs`：受 canvas lease/revision 保护的配音运行；结果保存为画布 audio asset 和持久化 GenerationRun。
- 画布 `tts` 节点支持切换 CosyVoice 3 / IndexTTS2，接收文本、音色参考音频和可选情绪参考音频，输出可预览和下载的音频候选。

CosyVoice 3 零样本克隆必须填写参考音频的逐字稿；IndexTTS2 可额外使用情绪参考音频或情绪文字指令。

## 故障边界

- ComfyUI 队列 120 秒内没有清空时拒绝切换，不会强杀现有生成。
- Provider 进程连续 3 次未退出时中断切换，不继续处理排队任务；错误记录包含各次 PID/端口/RAM/VRAM 证据。
- 调度器无法证明 8188 进程是自己启动时绝不自动结束；只有确认接管接口能关闭 Desktop。
- 接管令牌缺失、伪造、过期、重复使用或绑定的 PID/路径/进程集合发生变化时，在结束任何进程前拒绝；AI 对话中的一般功能确认不等于对某一快照的接管确认。
- 保存资产或写 Run 记录失败时，GPU 租约仍在 `finally` 中释放。
- TTS 推理失败会记录 failed Run，并卸载失败 Provider，后续队列仍可继续。

## 验收

- [x] 调度器并发与同/跨 Provider 切换单元测试。
- [x] TTS 画布图结构、输入约束、资产保存和运行记录测试。
- [x] 后端完整测试与 TypeScript 构建。
- [x] 前端生产构建。
- [x] CosyVoice 3 使用真实参考音频生成 WAV。
- [x] IndexTTS2 使用真实参考音频生成 WAV，并确认切换后 CosyVoice 已卸载。
- [x] 从 TTS 切回真实 ComfyUI 工作流，确认 IndexTTS2 已卸载且结果可用。
- [x] 浏览器中完成节点创建、Provider 切换、音频播放与下游结果回看。
- [x] 后端重启清理遗留 TTS worker，确认 50000/50001 端口及原 PID 均消失。
- [x] 真实 ComfyUI Desktop 冲突返回 409、持久 Run 失败原因和调度器锁定状态；浏览器显示 PID/路径/内存及显式接管按钮，取消后 Desktop 保持运行。
- [x] 页面与 AI 对话共用一次性确认协议；无令牌、伪造、过期、重放和进程快照变化测试均确认不会结束进程。

2026-09-09 实机证据：CosyVoice Run `509ad963-42ee-4da3-a2e2-844bc9076ea5` 生成 24 kHz 单声道 4.160 秒 WAV；IndexTTS2 Run `0240d1a5-b6ae-4bdb-b33c-1539cb42afa0` 生成 22.05 kHz 单声道 3.727 秒 WAV。随后 Z-Image Run `10de6a46-ef2d-471c-83fc-d0646042a0ea` 成功输出 512×512 图片；提交时两个 TTS worker 均为 `loaded=false`，调度器唯一活动租约为 `comfyui`。验收画布 `55961864-3618-4923-bc88-49c5fb782332` 保留参考音频、配音节点、下游音频结果与生成流水；浏览器内三个 audio 元素均 `readyState=4`。

进程级升级验收：3100 重启后原 CosyVoice PID `21196`、IndexTTS PID `5428` 与 50000/50001 监听全部消失。对仍由 Desktop 启动的 ComfyUI PID `16968` 提交 Z-Image 时返回 `409 COMFYUI_TAKEOVER_REQUIRED`，平台 Run `c058b04d-a92f-400e-956f-53c123502333` 为 `failed` 且保存端口、PID、约 38.99 GB private bytes、allocator 和整卡显存快照；调度器 `blocked` 同步锁定。浏览器确认弹窗正确展示 PID、路径、内存、取消和“关闭 Desktop 并交由调度器托管”，验收选择取消，确认未越权关闭用户 Desktop。完整自动测试为 16 suites / 100 tests，前后端生产构建通过。

对话确认升级验收：真实 Desktop 运行时成功签发绑定当前进程集合的 5 分钟一次性令牌及公开快照指纹；使用伪造令牌调用执行接口返回 `TAKEOVER_CONFIRMATION_INVALID`，8188 所有者与全部 Desktop 进程保持不变。自动测试覆盖缺失、伪造、过期、重放、快照变化和有效令牌路径，共 16 suites / 101 tests；Action Registry 将执行动作声明为 `high-impact + human confirmation`，前后端生产构建通过。本轮未把“确认升级功能”解释成“立即关闭当前 Desktop”。
