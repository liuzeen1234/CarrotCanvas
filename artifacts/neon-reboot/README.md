# 重启天际 · MiniMax H3 R2V 实测

2026-09-07，通过本地 codex2api 生成剧情、提示词及两张 1536×1024 参考图，使用 ComfyUI Desktop 的本地 MiniMax H3 Ref2VA 工作流生成视频。

剧情：银白装甲信使在未来都市高空平台上托起青色能源核心；核心悬浮并展开几何光环，能量脉冲掠过城市，点亮天际线。

- 成片：`Sky_Reboot.mp4`
- Desktop 已保存工作流：`Sky_Reboot_R2V`
- 可导入的 Desktop 工作流：`workflow-desktop.json`（图片位于 ComfyUI input 根目录，避免旧版 LoadImage 下拉框不枚举子目录的问题）
- 本次实际执行图与请求：`workflow.json`、`api-prompt.json`（使用同一图片的 input/sky-reboot 子目录副本）
- codex2api 原始剧情及提示词：`story-prompts.json`、`text-response.json`
- 输入图：`reference-1.png`、`reference-2.png`
- 执行记录：`submitted.json`、`history.json`、`events.jsonl`
- 媒体信息及抽帧：`media-info.json`、`contact-sheet.jpg`、`start.png`、`middle.png`、`end.png`

## 运行参数与结果

- ComfyUI /system_stats 报告版本：0.33.4。
- 主模型：minimax_h3_ref2va_pruned_int8_convrot.safetensors。
- LoRA：minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors，强度 1，4 步。
- 采样器 res_multistep，调度器 simple，ref_image_size=match。
- 种子 2609071842，16:9，0.98 MP，时长输入 6 秒，按模型约束对齐到 158 帧。
- 输出 1344×768、24 fps、6.583333 秒；H.264 视频 + 32 kHz 双声道 AAC。
- ComfyUI 实际执行耗时 655.128 秒；prompt_id：1bf1bb80-656f-4554-8065-4560e2711376。
- 原始输出：D:/Comfy-Desktop/ComfyUI-Shared/output/video/Sky_Reboot_R2V_00001_.mp4。
- ffmpeg 完整解码通过；音轨非静音，平均 -14.0 dB、峰值 -0.6 dB。

## 画面检查

六帧概览以及全分辨率尾帧显示：人物、白色装甲及城市风格延续了参考图；能源球悬浮、光环展开、能量波和城市点亮均有呈现。画面可以辨认装甲分块与建筑线条，移动与发光区域比静态参考图更软。光环生成的是菱形几何结构，镜头也加入了侧向绕行，未严格遵守纯后移镜头和薄水平环的全部要求。

本次验证范围为多图片参考与原生音视频生成；没有测试外部视频/音频作为参考输入。音频仅做了声道、时长、非静音及峰值检查，未作听感评价。

## 平台画布使用

已导入工作流：**MiniMax H3 双图参考生视频 · 重启天际**。ID：`35c2f155-78f6-4762-9ce1-93b90c78856e`。

画布取得编辑权后，在空白处右键 → 图生视频 → 选择此工作流。可直接使用默认参考图片与提示词，也可将两张图片节点分别连接参考图片 1 / 2，将文本节点连接视频提示词。提示词以 `<Picture 1>`、`<Picture 2>` 引用对应图片。

默认 6 秒、1344×768、24fps、4 步 Turbo；实测素材成片约 6.58 秒。当前版本支持双图参考，不包含视频或音频参考输入。平台导入校验通过，未重复运行视频。导入脚本 `import-platform.mjs` 按名称检查已有条目，避免重复创建。

## 全能参考升级（2026-09-08）

当前名称：MiniMax H3 全能参考 · 重启天际；分类：全能参考。46 个可编辑字段都可连线：9 图片、3 视频、3 对应视频配音、3 独立音频、28 文本/控制参数。数字使用文本输入节点填写数字，布尔填 true/false 或 1/0，枚举填写选项原值。视频上传自动转换 24 fps，需 2–15 秒；每种参考从第 1 路连续填写。视频配音和独立音频共用连续 Audio 标签，视频配音在前。

画布空白处右键 → 输入节点，可添加图片、视频、音频或文本/参数源；右键 → 全能参考，可添加主工作流。示例：http://localhost:8000/canvas/73b899eb-e086-4d54-a309-bc36c5b3c56d 。已有页面请刷新以重新读取工作流 schema。

仅对媒体加载链路进行了新增实跑，成功输出 PNG/FLAC；本轮未执行混合参考的完整 MiniMax 成片生成。上面的旧双图导入说明属于 2026-09-07 的历史状态。
