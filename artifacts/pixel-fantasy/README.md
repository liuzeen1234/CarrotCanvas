# Pixel Fantasy · 5060 Ti 16GB 本地适配

2026-09-08。只保存到 ComfyUI Desktop，未导入 CarrotCanvas 平台。原始文件保存在 `original.json`，没有覆盖下载目录中的原工作流。

## 使用

ComfyUI 工作流列表中打开：

- `Pixel_Fantasy_5060Ti_15s_Auto`：图片 → 本地 Qwen 看图扩写 → H3 参考视频 → 原生音视频输出。更换图片时使用此版本，中文需求在指令推理节点的自定义提示词开头，后面的时间轴模板用于约束输出格式。
- `Pixel_Fantasy_5060Ti_15s_Manual`：省去扩写，直接使用经人工核对的图片描述与分镜；可编辑完整英文提示词。默认提示词针对本次蓝发角色，换图后需要相应修改。

本次参考图：`D:/downloads/zimage_2k_16x9_00020_.png`，上传为 ComfyUI input 中的 `Pixel_Fantasy_reference.png`。

## 修复与配置

| 项目 | 调整结果 |
|---|---|
| 主模型 | 本机 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`，与 ReferenceToVideo 节点匹配 |
| 文本编码器 | 本机 Qwen3-VL-32B NVFP4 AWQ，device=default，实际 CUDA 编码 |
| LoRA / 采样 | Ref2V Turbo 4-step、强度 1、res_multistep、simple、4 步 |
| H3SigmaRefiner | 随原 8 步调度替换；4 步 Turbo 不额外插入精修步 |
| 分辨率 / 时长 | 16:9、0.4 MP → 864×480；24 fps、15 秒输入 → 按 H3 约束对齐 362 帧 / 15.083 秒 |
| 视频 VAE | 本机 FP16 VAE，GPU 分块解码，tile=512、overlap=64、temporal=64/8；该 H3 VAE 本身也支持内部流式分块 |
| 音频 VAE | 原生 FP32 音频 VAE，CUDA 推理 |
| 视频输出 | 缺失的 VHS_VideoCombine 换为官方 CreateVideo + SaveVideo，MP4/H.264，保留原生音轨 |
| 看图扩写 | 缺失的 llama_cpp 节点迁移到本机已安装的 XB_ToolBox 同类节点 |
| 扩写模型 | Qwen3.5-9B Q4_K_M + F16 mmproj，替代原 Q8 heretic 示例模型；量化和模型变体均有变化 |
| 扩写上下文 | 99968 → 8192；max_tokens=3072；图片最长边 768，image_max_tokens=1024 |
| 显存管理 | n_gpu_layers=-1（全部可卸载层上 GPU）；完成扩写后 force_offload=true，save_states=false |
| 种子 | 扩写与视频均固定 2609080715；已校验前端附加 seed 控件不会导致后续卸载开关错位 |
| 旧动态输入 | 修正为当前 ComfyUI 的 `values.a/b`、`ref_images.ref_image_0` 命名，已核对前端实际提交内容 |

保留现有 NORMAL_VRAM、DynamicVRAM、cudaMallocAsync、双流异步权重卸载。H3 INT8 主模型约 20GB 暂存权重仍大于显卡容量，系统 RAM 会承担权重暂存、缓存及媒体缓冲，CPU 也参与调度、搬运与最终 H.264 编码；这不是零 CPU 模式。没有强行开启 highvram/gpu-only，也没有修改其他工作流的参数。

## 实测

人工提示词版：prompt_id `56797fe0-a912-4aca-8c60-b97a7c3649b4`，成功，总耗时 311.535 秒，4 步采样约 187 秒。产出：

`D:/Comfy-Desktop/ComfyUI-Shared/output/video/Pixel_Fantasy_5060Ti_15s_00001_.mp4`

全部 362 帧与音频解码通过。864×480 / 24 fps / 15.083 秒，32kHz 双声道，音频非静音。逐秒抽帧见 `manual-contact-sheet.jpg`：人物脸、蓝发、黑红角与服装配色延续参考图；近景、全身、手掌遮挡、漫画舞台及两次 Pixel Fantasy 标题可辨认。小尺寸全身细节较软，文字部分被人物合理遮挡。没有把声音非静音检测等同于听感验收，也没有宣称逐帧动作或严格音乐卡点完全符合提示词。

扩写单测：prompt_id `b075b936-3919-449e-a8e2-2b1f30c288f2`，成功，约 40 秒，输出 3759 字符、15 镜及 14 个递增时间戳。第一次扩写漏掉时间戳，已增加明确的输出模板；第一条自动全链路尝试因此主动中止，非 OOM。扩写生成仍可能误认眼睛颜色或服装细节，输出文本应视为可审核草稿；人工提示词版保留准确外观锚点。

自动版最终从 ComfyUI 界面点击运行，实际请求与硬件采样保存为 `auto-ui-submitted.json`、`auto-ui-metrics.jsonl`；结果见 `auto-ui-history.json`。

最终自动版 prompt_id `da2816de-5b36-44bb-9aec-99dc8242c93c`，成功，总耗时 329.740 秒（复用已完成的约 40 秒扩写缓存，非包含扩写的冷启动总耗时）。产出 `D:/Comfy-Desktop/ComfyUI-Shared/output/video/Pixel_Fantasy_5060Ti_15s_00002_.mp4`，同为 362 帧 / 864×480 / 24fps / 15.083 秒，32kHz 双声道，全部媒体解码通过。抽帧见 `auto-contact-sheet.jpg`：切镜、奔跑、特写与两次标题均生成；自动描述误认眼睛为红色，成片也更偏红，人物保真以人工版更好。

人工版采样区间 GPU 利用率平均约 99.3%，整轮显存采样峰值 15544 MiB（含桌面占用）；自动版 CPU 仍有可观负载，并非纯 GPU。自动版系统 RAM 采样峰值约 57.2 GiB，最低可用约 6.7 GiB，未发生 OOM。结果支持本机 15 秒 / 0.4 MP / 4 步配置可运行，不代表更高分辨率也已验证。

## 依赖与复现记录

- ComfyUI 0.33.4，PyTorch 2.12.1+cu130，RTX 5060 Ti 16GB，64GB RAM。
- Desktop 的实际环境是 `D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv`，基础 `standalone-env/python.exe` 仅为解释器来源；修复依赖安装在 `.venv` 中。
- 安装 `llama-cpp-python 0.3.49+cu130`（CPython 3.13 Windows）和 `diskcache 5.6.3`。已验证 ggml-cuda 加载、compute capability 12.0、GPU_OFFLOAD=True，保留原有 torch/numpy。wheel 声明的 numpy 上限低于本机 2.5.1，本次视觉推理实际通过；没有为满足元数据而全局降级 numpy。
- 模型来源：[Unsloth Qwen3.5-9B GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF)，通过 hf-mirror 获取同一仓库模型并校验 SHA256；CUDA wheel 来源：[JamePeng 发布页](https://github.com/JamePeng/llama-cpp-python/releases/tag/v0.3.49-cu130-win-20260831)。精确地址、大小和校验值见 `download-manifest.json`。
- 用原有命令和目录重启 8188 以加载新增依赖，后台隐藏运行；启动命令见 `restart-command.json`，日志 `comfy-restarted.log`。
- `build_workflow.py` 生成本次适配的 API 与 UI 文件，并保存到 ComfyUI；`run_workflow.py` 记录 API 试跑；`monitor_ui_run.py` 记录最终真实前端试跑；`check_video.py` 做媒体解码和抽帧检查。没有修改平台业务代码。
