# AI 语音评价与本机重型计算租约

> 对应需求：[Issue #14](https://github.com/liuzeen1234/CarrotCanvas/issues/14)

## 当前实现范围

平台新增统一 `speech-evaluator` Provider。它与 ComfyUI、CosyVoice 3、IndexTTS2 共用同一个持久化 FIFO“本机重型计算租约”，租约代表 GPU、CPU、内存、页面文件、磁盘与重型模型进程的排他执行窗口，不再只表示显存。

首个纵向版本已实现三个不会伪造感知分数的内置 WAV 工具：

1. `audio-profile`：时长、采样率、声道、峰值、RMS、dBFS、削波比例。
2. `pause-timing`：基于自适应帧 RMS 的静音段、停顿数量、静音时长与占比。
3. `pitch-energy`：基于归一化自相关的 F0 均值、P10/P90 和半音音域。

这些结果是客观基础测量，不冒充转写准确度、说话人相似度或 MOS 自然度。FunASR/强制对齐、WeSpeaker 和经过许可证及中文数据域验证的 MOS 模型尚未安装时，结果会明确返回 `unavailable`，综合结论为 `needs_model_evaluation`，不会自动触发重生成。

## 严格串行合同

一个批次可以包含多条语音，但第一版执行顺序固定为“工具优先、音频串行”：

```text
取得本机重型计算租约
  → audio-profile 处理音频 1、2、3……
  → pause-timing 处理音频 1、2、3……
  → pitch-energy 处理音频 1、2、3……
  → 单条汇总与批次技术排序
  → 最终结果持久化
  → 清理 Provider
  → 释放本机重型计算租约
```

同一时间只运行一个工具、处理一条音频，也只允许一个评价批次持有外层租约。CPU-only 阶段仍持有租约，ComfyUI/TTS 不得插队。每个“工具 × 音频”完成后立即保存阶段状态和指标。

## 接口

- `POST /api/speech-evaluator/runs`：受 canvas lease/revision 保护地提交评价批次；立即返回持久 Run 和项目列表，后台等待并执行本机重型计算租约。
- `GET /api/speech-evaluator/runs/:id`：读取平台 Run 及按输入顺序排列的评价项目和阶段结果。
- `GET /api/local-compute-scheduler/status`：读取当前重型计算租约、驻留 Provider、FIFO 等待队列和 fail-closed 状态。
- `GET /api/gpu-scheduler/status`：暂时保留的兼容入口，新代码不得继续依赖。

提交目标包含目标音频 `assetId`，并可附带源 TTS `sourceRunId`、参考音频 `referenceAssetId` 和目标文本 `targetText`。输入快照固定记录 `tool-major-serial-v1` 执行策略。

## 持久化与迁移

- 新租约表为 `local_compute_leases`。
- 启动时如果检测到旧 `gpu_resource_leases`，历史记录会按主键单向复制到新表；旧表暂不破坏性删除。
- 每条评价项目保存在 `speech_evaluation_items`，包含批次 Run、输入资产、阶段状态、工具版本、中间指标、错误和最终结果。
- 评价批次本身复用持久化 `generation_runs`，Provider 为 `speech-evaluator`；源 TTS Run 和音频资产不会因评价失败而被反向标失败。

## 后续模型接入门槛

FunASR、WeSpeaker、VERSA/UTMOSv2 等适配器接入前必须验证：维护状态、许可证、Windows 与当前 CUDA/Python 环境、权重下载可靠性、中文/角色语音数据域表现以及实际 CPU/RAM/VRAM。适配器仍必须遵守同一工具级串行与中间结果持久化合同。

## 当前阶段边界

本轮不实现跨工具并行、多文件并行、动态 batch、自动重生成或主观 MOS 替代品。内置“技术分”只用于同批候选的基础信号健康度排序，不代表自然度或人类偏好。
