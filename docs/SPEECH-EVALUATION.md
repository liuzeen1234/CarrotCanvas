# AI 语音评价与本机重型计算租约

> 对应需求：[Issue #14](https://github.com/liuzeen1234/CarrotCanvas/issues/14)

## 当前实现范围

平台新增统一 `speech-evaluator` Provider。它与 ComfyUI、CosyVoice 3、IndexTTS2 共用同一个持久化 FIFO“本机重型计算租约”，租约代表 GPU、CPU、内存、页面文件、磁盘与重型模型进程的排他执行窗口，不再只表示显存。

当前版本已接入三个模型工具和三个客观 WAV 工具：

1. `funasr`：中文转写、字级时间戳、分句和目标文本 CER，CUDA 推理；ASR、VAD、标点模型均从 ModelScope 缓存加载。
2. `audio-profile`：时长、采样率、声道、峰值、RMS、dBFS、削波比例。
3. `pause-timing`：基于自适应帧 RMS 的静音段、停顿数量、静音时长与占比。
4. `pitch-energy`：基于归一化自相关的 F0 均值、P10/P90 和半音音域。
5. `wespeaker`：CAMPPlus 说话人嵌入余弦相似度，模型从 ModelScope 下载；固定 CPU 串行推理。
6. `utmosv2`：1–5 自然度预测，CUDA 推理；wav2vec2 骨干优先从 ModelScope 加载。最终检查点没有官方 ModelScope 镜像，使用项目官方 Hugging Face 发布权重。

模型与 Python 依赖部署在 `backend/data/speech-evaluator-runtime/evaluator-env` 独立虚拟环境，模型缓存、临时文件也位于同一忽略目录，不污染系统 Python 或其他 Provider。结果状态为 `evaluation_complete_unthresholded`：指标真实可用，但 UTMOSv2 的中文/本项目数据域阈值仍未标定，因此只提供证据，不自动触发重生成。

## 严格串行合同

一个批次可以包含多条语音，但第一版执行顺序固定为“工具优先、音频串行”：

```text
取得本机重型计算租约
  → FunASR 加载一次，处理音频 1、2、3……，进程退出
  → audio-profile 处理音频 1、2、3……
  → pause-timing 处理音频 1、2、3……
  → pitch-energy 处理音频 1、2、3……
  → WeSpeaker 加载一次，处理音频 1、2、3……，进程退出
  → UTMOSv2 加载一次，处理音频 1、2、3……，进程退出
  → 单条汇总与批次技术排序
  → 最终结果持久化
  → 清理 Provider
  → 释放本机重型计算租约
```

同一时间只运行一个工具、处理一条音频，也只允许一个评价批次持有外层租约。CPU-only 阶段仍持有租约，ComfyUI/TTS 不得插队。每个“工具 × 音频”完成后立即保存阶段状态和指标。

## 接口

- `POST /api/speech-evaluator/runs`：受 canvas lease/revision 保护地提交评价批次；立即返回持久 Run 和项目列表，后台等待并执行本机重型计算租约。
- `GET /api/speech-evaluator/runs/:id`：读取平台 Run 及按输入顺序排列的评价项目和阶段结果。
- `POST /api/speech-evaluator/runs/:id/cancel`（或通用 `POST /api/runs/:id/cancel`）：请求在当前“工具 × 音频”结束后的安全边界取消；已完成阶段保留，未开始阶段不伪造结果。
- `GET /api/local-compute-scheduler/status`：读取当前重型计算租约、驻留 Provider、FIFO 等待队列和 fail-closed 状态。
- `GET /api/gpu-scheduler/status`：暂时保留的兼容入口，新代码不得继续依赖。

提交目标包含目标音频 `assetId`，并可附带源 TTS `sourceRunId`、参考音频 `referenceAssetId` 和目标文本 `targetText`。输入快照固定记录 `tool-major-serial-v1` 执行策略。

## 持久化与迁移

- 新租约表为 `local_compute_leases`。
- 启动时如果检测到旧 `gpu_resource_leases`，历史记录会按主键单向复制到新表；旧表暂不破坏性删除。
- 每条评价项目保存在 `speech_evaluation_items`，包含批次 Run、输入资产、阶段状态、工具版本、中间指标、错误和最终结果。
- 评价批次本身复用持久化 `generation_runs`，Provider 为 `speech-evaluator`；源 TTS Run 和音频资产不会因评价失败而被反向标失败。
- 每个模型 worker 记录活动 PID、工具、Run 与启动时间。后端重启后，死亡 PID 的陈旧状态可安全清理；若旧 PID 仍存活或状态损坏而无法证明已释放，调度器以 `PROVIDER_STATE_UNCONFIRMED` fail-closed，不发放下一张租约。

## 模型与部署约束

- Python 3.10 虚拟环境；PyTorch/TorchAudio 2.8.0+cu128；FunASR 1.4.1；ModelScope 1.39.1；WeSpeaker 与 UTMOSv2 固定到 `requirements.in` 中的提交。
- CUDA PyTorch 需从 PyTorch 官方 cu128 索引先安装，其余依赖由 `requirements.in` 记录。
- ModelScope 是默认模型源。只有缺少官方镜像的 UTMOSv2 最终检查点允许回退；运行时启用 Hugging Face offline，避免隐式联网。
- UTMOSv2 代码为 MIT；输出保留 `uncalibrated-zh`，完成中文人工 MOS 样本标定前不得配置自动淘汰阈值。

## 当前阶段边界

本轮不实现跨工具并行、多文件并行、动态 batch 或自动重生成。内置“技术分”只用于同批候选的基础信号健康度排序；UTMOSv2 分数单独展示，不等同于本项目中文用户的主观偏好。

## 2026-09-09 验收证据

- 真实三音频批次 Run `945d2f9a-6a9c-435d-b317-ed44701f6630` 完成。时间戳确认所有阶段严格按 `funasr → audio-profile → pause-timing → pitch-energy → wespeaker → utmosv2` 执行，且每个阶段内第 N 条完成后第 N+1 条才开始。
- UTMOSv2 阶段曾同时观测到第 1 条 `succeeded`、第 2 条 `running`、第 3 条 `pending`，证明“工具 × 音频”结果在下一条完成前已持久化，而非批末一次性写入。
- 最终 `outputText` 在 Run 完成前持久化 `version=2`、`speech-evaluator-relative-v2`、三候选归一化分数、问题定位、排名与复核建议；随后调度器状态为 active/resident/waiting 全空。
- 真实取消 Run `62892420-35cf-4fd0-a9ba-e59e23f28a0b` 在 FunASR 安全边界结束：第 1 条为 `succeeded`、第 2 条保持 `pending`，Run 为 `cancelled`，外层租约释放。两个来源 TTS 音频取消后下载均返回 HTTP 200。
- 自动测试覆盖 CPU-only 阶段阻塞竞争 Provider、三次清理失败观测与 fail-closed、重启安全边界恢复、状态不可证明时 fail-closed、取消保留部分成果，以及评价失败不反向修改成功 TTS Run。
