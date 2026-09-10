# 本地 TTS 与 ComfyUI 的本机重型计算调度

## 目标

统一调度 `comfyui`、`cosyvoice3`、`indextts2` 三个 Provider。领域概念已从“GPU 租约”升级为“本机重型计算租约”：任一时刻只允许一个 Provider 占用 GPU、CPU、内存、页面文件、磁盘与重型模型进程的排他执行窗口。

对应需求：[GitHub Issue #11](https://github.com/liuzeen1234/CarrotCanvas/issues/11)。

## 已拍板设计

- CosyVoice 3 与 IndexTTS2 使用各自独立的 Python 3.10 环境，worker 由调度器按需启动，切出时退出整个进程，不只调用模型 `/unload`。
- TTS 进程退出最多尝试 3 次：先请求优雅关闭，再升级到结束进程；每次记录 PID、端口、RSS 与 CUDA reserved。只有端口消失且原 PID 不存在才算释放成功。
- ComfyUI 运行也必须先取得相同的持久化 FIFO 租约。调度器托管的 ComfyUI 切出时等待队列清空，再按进程树退出，并在每次尝试前后记录端口所有者、working set/private bytes、Comfy allocator 与 `nvidia-smi` 整卡显存。
- 8188 若属于非调度器 PID，或检测到 ComfyUI Desktop，返回 `COMFYUI_TAKEOVER_REQUIRED` 并锁住后续队列。页面必须由用户确认后才关闭 Desktop/相关进程、保存启动参数并改由调度器启动纯后端；未知外部进程以后仍会再次询问。
- 连续运行同一 Provider 时允许模型驻留，避免重复加载；切换 Provider 时严格串行执行 `release(old) → prepare(new)`。
- 租约写入 SQLite `local_compute_leases`。启动时旧 `gpu_resource_leases` 历史单向兼容迁移；后端重启时把未完成租约标记为 `abandoned`，不把陈旧状态当作仍在占用。
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

- `GET /api/local-compute-scheduler/status`：当前租约、驻留 Provider 与等待队列；旧 `/api/gpu-scheduler/status` 暂作兼容入口。
- `GET /api/tts/providers`：两个 worker 的在线及模型加载状态。
- `GET /api/comfyui/process-status`：8188 所有者、Desktop 进程、进程内存及显存观测。
- `POST /api/comfyui/takeover/confirmation`：针对当前端口所有者和 Desktop 进程集合签发 5 分钟有效、一次性使用的确认令牌，并返回供页面或 AI 对话展示的快照。
- `POST /api/comfyui/takeover`：只接受显式 `confirm=true` 与有效确认令牌；执行前重新核验进程快照，关闭 Desktop 后保存并启动调度器托管的 ComfyUI 后端，同时解除因该冲突产生的队列锁。
- `POST /api/tts/runs`：受 canvas lease/revision 保护的配音运行；结果保存为画布 audio asset 和持久化 GenerationRun。
- `GET /api/tts/voices`：列出当前本地运行时已安装、且适用于指定 Provider 的预设音色；只返回稳定 ID 和展示元数据，不暴露服务端路径或内部逐字稿。
- 画布 `tts` 节点支持切换 CosyVoice 3 / IndexTTS2，并提供“预设音色 / 自定义音色”两种模式。新节点默认使用预设音色，用户只需输入台词、风格/情绪要求和语速即可生成；自定义模式保留原有参考音频克隆。旧画布未保存 `voiceMode` 时按自定义模式解释，不改变已有运行语义。
- 预设音色由后端白名单解析为参考音频和精确逐字稿，客户端不能提交任意服务端文件路径。预设音频不冒充画布资产，Run 快照记录 `voiceMode` / `presetVoiceId`，`inputAssetIds` 只记录用户自定义音色与情绪资产。

### 精确停顿协议（Issue #17）

- 两个 TTS Provider 共用 `<pause ms="N"/>`，`N` 为 `100–10000` 的整数毫秒。首尾标签允许；连续标签规范化为累计停顿，累计超过 10000ms 拒绝；空白段不推理，纯停顿及未知/未闭合/额外属性标签在提交前和后端均拒绝。
- 后端在 Provider 调用前生成版本化 `pauseSyntaxVersion=1` 计划，只把 speech 段文本逐段、严格串行发送给模型。原始 pause 标签不会进入模型请求。
- 所有片段使用同一 Provider、音色、情绪和有效参数。语音片段保留 Provider 的 PCM/IEEE-float WAV 格式，静音按最终采样率取整到采样帧后直接插入，使用 `carrot-pcm-wav-concat-v1` 无损拼接；格式不一致则整条 Run 失败，不做有损重编码。
- 外层本机重型计算租约覆盖逐段推理、CPU 拼接、正式资产保存和最终 Run 落库。中间片段只存在于内存，不建资产或候选；成功只保存一个最终 audio asset。
- `inputSnapshot` 持久化原文、规范化 segments、`speech-segment-serial-v1` 执行状态、逐段时长/采样率、拼接工具、实际格式、目标及实际静音帧。取消在语音片段边界生效；失败、取消或重启不会把半成品发布为候选，最终资产落库失败会清理刚写入的孤立文件。

CosyVoice 3 零样本克隆必须填写参考音频的逐字稿；IndexTTS2 可额外使用情绪参考音频或情绪文字指令。

## 故障边界

- ComfyUI 队列 120 秒内没有清空时拒绝切换，不会强杀现有生成。
- Provider 进程连续 3 次未退出时中断切换，不继续处理排队任务；错误记录包含各次 PID/端口/RAM/VRAM 证据。
- 调度器无法证明 8188 进程是自己启动时绝不自动结束；只有确认接管接口能关闭 Desktop。
- 接管令牌缺失、伪造、过期、重复使用或绑定的 PID/路径/进程集合发生变化时，在结束任何进程前拒绝；AI 对话中的一般功能确认不等于对某一快照的接管确认。
- 保存资产或写 Run 记录失败时，本机重型计算租约仍在 `finally` 中释放。

- TTS 推理失败会记录 failed Run，并卸载失败 Provider，后续队列仍可继续。

## 验收

- [x] 调度器并发与同/跨 Provider 切换单元测试。
- [x] TTS 画布图结构、输入约束、资产保存和运行记录测试。
- [x] 预设音色列表、无画布参考资产提交、服务端白名单解析与 Run 快照测试。
- [x] 后端完整测试与 TypeScript 构建。
- [x] 前端生产构建。
- [x] CosyVoice 3 使用真实参考音频生成 WAV。
- [x] IndexTTS2 使用真实参考音频生成 WAV，并确认切换后 CosyVoice 已卸载。
- [x] 从 TTS 切回真实 ComfyUI 工作流，确认 IndexTTS2 已卸载且结果可用。
- [x] 浏览器中完成节点创建、Provider 切换、音频播放与下游结果回看。
- [x] 后端重启清理遗留 TTS worker，确认 50000/50001 端口及原 PID 均消失。
- [x] 真实 ComfyUI Desktop 冲突返回 409、持久 Run 失败原因和调度器锁定状态；浏览器显示 PID/路径/内存及显式接管按钮，取消后 Desktop 保持运行。
- [x] 页面与 AI 对话共用一次性确认协议；无令牌、伪造、过期、重放和进程快照变化测试均确认不会结束进程。
- [x] CPU-only 阶段阻塞 ComfyUI/TTS、重启残留状态无法证明时 fail-closed、连续三次清理失败观测均有自动测试。
- [x] Issue #17 的严格 pause 语法、首尾/连续/多标签/中文/边界/非法输入、采样点级拼接、串行/取消/失败安全自动测试。
- [x] CosyVoice 3 与 IndexTTS2 各完成三段中文、800ms + 1500ms 两处停顿真实生成，最终各仅一条正式音频，插入静音误差均为 0ms。

2026-09-09 实机证据：CosyVoice Run `509ad963-42ee-4da3-a2e2-844bc9076ea5` 生成 24 kHz 单声道 4.160 秒 WAV；IndexTTS2 Run `0240d1a5-b6ae-4bdb-b33c-1539cb42afa0` 生成 22.05 kHz 单声道 3.727 秒 WAV。随后 Z-Image Run `10de6a46-ef2d-471c-83fc-d0646042a0ea` 成功输出 512×512 图片；提交时两个 TTS worker 均为 `loaded=false`，调度器唯一活动租约为 `comfyui`。验收画布 `55961864-3618-4923-bc88-49c5fb782332` 保留参考音频、配音节点、下游音频结果与生成流水；浏览器内三个 audio 元素均 `readyState=4`。

进程级升级验收：3100 重启后原 CosyVoice PID `21196`、IndexTTS PID `5428` 与 50000/50001 监听全部消失。对仍由 Desktop 启动的 ComfyUI PID `16968` 提交 Z-Image 时返回 `409 COMFYUI_TAKEOVER_REQUIRED`，平台 Run `c058b04d-a92f-400e-956f-53c123502333` 为 `failed` 且保存端口、PID、约 38.99 GB private bytes、allocator 和整卡显存快照；调度器 `blocked` 同步锁定。浏览器确认弹窗正确展示 PID、路径、内存、取消和“关闭 Desktop 并交由调度器托管”，验收选择取消，确认未越权关闭用户 Desktop。完整自动测试为 16 suites / 100 tests，前后端生产构建通过。

对话确认升级验收：真实 Desktop 运行时成功签发绑定当前进程集合的 5 分钟一次性令牌及公开快照指纹；使用伪造令牌调用执行接口返回 `TAKEOVER_CONFIRMATION_INVALID`，8188 所有者与全部 Desktop 进程保持不变。自动测试覆盖缺失、伪造、过期、重放、快照变化和有效令牌路径，共 16 suites / 101 tests；Action Registry 将执行动作声明为 `high-impact + human confirmation`，前后端生产构建通过。本轮未把“确认升级功能”解释成“立即关闭当前 Desktop”。

Issue #17 精确停顿验收：CosyVoice 3 Run `2da5fa14-35b4-4f9e-86e9-e73def3d7f06` 输出 24 kHz 单声道 float32 WAV（11.380 秒），IndexTTS2 Run `d21d5a24-0d3b-4f2e-97ae-5eab26f140b4` 输出 22.05 kHz 单声道 PCM16 WAV（11.5532 秒）。两者均将 3 个 speech 段严格串行生成后插入 800ms 与 1500ms 静音；按最终采样率分别为 19200/36000 与 17640/33075 帧，目标与实际误差均为 0ms。每条 Run 只产生一个正式资产，Run 快照保留完整计划和拼接审计。

2026-09-10 预设音色增量：新增双模式音色选择与 `tts.voices` Action，首个“清亮女声”复用 CosyVoice 安装随附的官方 zero-shot 示例及其逐字稿，可供两个现有 Provider 使用。新节点默认无参考音频操作，旧节点保持自定义克隆；17 suites / 121 tests 与前后端生产构建通过。
