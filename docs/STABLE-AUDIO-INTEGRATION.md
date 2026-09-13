# Stable Audio 3 Medium 本地音效

2026-09-12。接入现有 ComfyUI 工作流注册、`txt2img` 通用工作流节点、FIFO 本机重型计算调度、GenerationRun / 画布资产 / 候选历史；没有云端 API、数据库迁移或全局依赖升级。

## 来源与文件

- [Comfy-Org 官方普通 Medium 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_3_medium.json)，Git blob `e329d9256895a233c3fa625eb2e0ddb426fcac54`，原文件 SHA256 `6f94ab911dbf1d3c7cfebff1bd25c041988fba493bdc3116d431eb853eb2dcb1`。
- 原模板不改动保存在 ComfyUI `user/default/workflows/audio_stable_audio_3_medium.json`；本地默认副本为同目录 `audio_stable_audio_3_medium_lossless.json`。绝对目录：`D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/user/default/workflows/`。通过官方 `/userdata` 接口保存，保留已有同名文件。
- 仓库证据、副本、模型来源清单、实际请求和音频：`artifacts/stable-audio-3/`；可复用验证脚本：`scripts/stable-audio/`。
- 模型来自 ModelScope `Comfy-Org/stable-audio-3` / `Comfy-Org/Qwen3.5`，逐文件与 hf-mirror 上官方仓库的 size / LFS SHA256 交叉核对。未用 Hugging Face 直连，没有下载 Base / Small 或其他同名替代模型。

| 模型目录（`D:/Comfy-Desktop/ComfyUI-Shared/models/` 下） | 用途 | 大小 / SHA256 |
|---|---|---|
| `checkpoints/stable_audio_3_medium.safetensors` | 普通 Medium，包括模型与音频 VAE | 9,222,116,660 bytes / `48d9c65e290e7bcd5194e0633bfc2424a59ee9683f5c2d58762d997b7d8ce0b5` |
| `text_encoders/t5gemma_b_b_ul2.safetensors` | 官方文本编码器 | 1,187,264,003 bytes / `1e1eba25be8872edb0d3c6335c6658fd6388e7b14b60da6e454e404cfcd8150e` |
| `text_encoders/qwen3.5_2b_bf16.safetensors` | 官方模板可选、本地提示词扩写 | 4,548,221,488 bytes / `aa33250c4fc64891ddfaba3a314fd9542ea371843c387178b425fbcc5ed680b1` |

模型权重遵循其 Stability Community License，不能把 ComfyUI 代码许可证当作权重许可证。下载未出现必须用户登录或接受许可的技术门槛；商用使用仍应自行核对许可证条件。

## 画布使用

画布空白处右键 → **音效生成（本地）** → **Stable Audio 3 Medium · 本地音效**，填写英文提示词、时长、固定 seed；短动作先保持自动扩写关闭。工作流 ID `33d28c8e-0156-41b2-8650-cd61000de867`。验收画布：`da1993e3-12d0-41c6-a335-22cb96072dab`。

类别 Music / Instrument / SFX / One-shot 是官方 **扩写预设**，不是独立音频模型参数；只有开启扩写时才通过本地 Qwen 影响生成提示词。关闭时直接使用原提示词。原模板独立 `PreviewAny` 是输出节点，会强制执行扩写分支，所以无损副本将该预览禁用，保留可选扩写功能和原模板。没有伪造额外的模型类别开关。

默认 8 steps / CFG 1 / LCM / simple，输出 FLAC。RTX 5060 Ti 16 GB / RAM 64 GB，沿用 ComfyUI 自动加载和卸载，无全局显存/torch 参数更改。实际音频长度有模型 latent 步长舍入，不承诺采样点精确时长。

无损副本另有两项实测修正：`ConditioningStableAudio` 显式把时长输入传给正/负 conditioning，避免 ComfyUI StableAudio3 默认按 latent 向下取整（25 秒被推断为 24 秒，导致末尾约 1 秒静音）；`AudioAdjustVolume` 在 FLAC 编码前固定 −3 dB，避免瞬态超过整数 PCM 范围。原模板仍完全保留。不修改 ComfyUI 核心或全局模型行为。

点击节点运行并确认。生成成功后卡片及结果卡片有音频播放器、平台资产 ID；下载保留 FLAC。节点候选历史与画布生成流水可追溯 Run、实际 seed、参数快照和音频资产。输出端口为 `audio-source`，可连接音频结果或兼容音频输入，不能伪装为图片端口。

## 验收边界

三组测试用例、英文原提示词及参数见 `scripts/stable-audio/cases.mjs`。独立测试与平台测试分开记录，平台测试必须走带 lease/revision 的真实 `/comfyui/runs`，不能用独立 ComfyUI 返回冒充画布成功。文件全量 FLAC 解码、时长、峰值、RMS、静音及幅度活动报告见 `audio-analysis.json`。

当前工具没有可用于生成音频的语义听觉输入。浏览器播放/解码验证不等于实际听感验收，幅度分组不等于事件计数；无音乐、无人声、只有一次抽屉关闭、无多余事件、自然尾音仍需用户人工试听。技术通过不能宣称声音质量达标。

## 实际结果

以下均为最终显式时长条件 / −3 dB / 8 steps / CFG 1 / LCM / simple / 扩写关闭的本地结果。耗时为 execution start 到完成及平台捕获；不包括模型下载，首份空调包含重启后的冷加载。

| 测试 / 文件（`artifacts/stable-audio-3/` 下） | 输入时长 / 实际时长 | seed / 类别 | 耗时 | assetId |
|---|---|---|---|---|
| 办公室空调 `office-hvac-final.flac` | 25 / 24.984671 秒 | 12092032 / SFX | 7.109 秒 | `976cbbb7-a5d2-404b-b929-1e8c60a86e78` |
| 近距离翻纸 `paper-turn-final.flac` | 4 / 3.993832 秒 | 12092027 / SFX | 2.145 秒 | `52abf2a6-a492-4d42-b0b0-b3919b824163` |
| 单次抽屉提示词 `drawer-close-final.flac` | 4 / 3.993832 秒 | 12092028 / One-shot | 1.906 秒 | `48ba81c3-a4cd-4b15-8302-e66cb93f010c` |
| 抽屉 UI 补测 `canvas-ui-drawer-final.flac` | 4 / 3.993832 秒 | 12092029 / One-shot | 2.511 秒 | `618da775-5018-4ee3-a182-03a9f37087c9` |

原英文提示词、全部参数与 Run ID 在 `test-results.json`、`canvas-ui-run.json` 和每份 `.run.json` 中；实际冻结的 provider API JSON 包含相同提示词、seed、时长条件连接、扩写 false、类别与 −3 dB。最终 Run 分别为 `1903943d-7108-4ee6-ad29-80e15f6483e1`、`02a84b86-0dbf-4e14-9391-af8e9b26c756`、`eb7bf9ec-9d15-4768-bf8e-db8c0ef61dd5`、`414b3ee5-becc-4198-af30-362a7820dfb2`。

独立 ComfyUI `/prompt`：原模板转 API 并输出 FLAC成功（18.492 秒）；最终修复副本开启本地 Qwen / SFX 扩写成功（8.329 秒），prompt ID `fdf478c4-f2b2-423c-8700-f554b76b655b`，`standalone-final.flac`。实际扩写文本及完整 ComfyUI history 在 `standalone-result.json` / `standalone-history.json`。该测试不是平台 Run，不冒充画布历史。

技术分析用现有 PyAV + NumPy，未安装或升级任何依赖。最终四份文件全量解码为 44,100 Hz / 双声道 FLAC，无 NaN/Inf、无削波、非全静音；峰值依次为 −9.727、−4.597、−2.537、−3.241 dBFS。空调最终全程有幅度活动，逐秒 RMS 约 −22.7 至 −27.0 dBFS，末秒 −26.5 dBFS；初版 6.7–8 秒附近的大幅度变化和尾部整秒静音已通过提示词候选筛查与显式时长条件改善。

动作音的幅度分组：翻纸 2 段、seed 12092028 抽屉 3 段、UI seed 12092029 抽屉 1 段。**这不是语义事件计数**，可能是滑动、动作和尾音，也可能是额外事件；因此不能宣布“只关闭一次”已达标。UI 抽屉版本保留作为人工比较候选。

浏览器实测：右键分类→创建节点→填写提示词/时长/seed/One-shot→点击运行并确认→成功显示音频与候选；FLAC readyState=4、duration 正确、无解码错误，播放按钮切换暂停且进度实际推进，下载按钮触发真实 browser download。验收画布最终 8 节点 / 4 条 `audio-source → audio-target` 连线，顶部结果卡与源节点引用相同资产。节点历史及全画布流水都支持按真实资产类型播放/下载；后端重启后 13 条平台测试/补测 Run、全部候选与选中状态仍在。实际 asset 文件同时保存于 `backend/data/assets/<canvasId>/generated/`。

代码验收：后端 build、前端生产 build 通过；后端 20 suites / 157 tests 通过，含 FLAC 捕获、音频源端口、CustomCombo 类别、快速完成无轮询时的 startedAt 持久化及实际历史资产类型。修复前有一条中间翻纸 Run 缺少 startedAt，历史诚实显示耗时不可用；已失去原进程事件，不人为补造时间。最终测试与修复后的 Run 时间均正常。

### 仍需人工验收

- 三组音频是否真的无人声、无音乐、无杂声及多余事件。
- 空调底声的听觉连续性、稳定性和可用作背景底声的自然度（幅度更平稳不代表语义正确）。
- 翻纸是否只有翻纸、抽屉是否只关闭一次、动作和尾音是否自然；重点比较两份抽屉候选。

已触发浏览器播放并验证解码/进度，但当前代理无法接收播放声音进行语义试听，所以**工程集成与技术验收已通过，音效听感验收未完成**。
