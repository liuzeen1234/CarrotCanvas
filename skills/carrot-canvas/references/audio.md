# 本地音效生成与验收

## 节点、参数与运行

从 `/workflows` 找到用户指定、已注册的 `txt2audio` 工作流，再读取其 API JSON、字段配置与可用 schema。不要固定工作流 ID、ComfyUI 子图 ID、模型目录或测试 seed；本机 Stable Audio 集成说明在已定位的 CarrotCanvas 仓库 `docs/STABLE-AUDIO-INTEGRATION.md`，部署信息与历史测试留在项目文档中。

- 音效源仍是 `type:'txt2img'`，data 中填写 workflowId/workflowName、可选 cardName/note、formValues。不要创建不存在的 `txt2audio` React 节点，也不要用语音合成 `tts` 替代环境声或动作音。
- formValues 以 `${comfyNodeId}::${param}` 为键；实际提交仍需复制 API JSON 并写入同一组参数，不能只改卡片。记录提示词、秒数、实际 seed、扩写开关和类别；固定 seed 测试应关闭相应自动随机选项，并以最终 Run 的 inputSnapshot 核验实际值。
- 通过同一 session 的正常 `/comfyui/runs` 提交与等待，沿用 FIFO、lease/revision、错误和候选历史机制。独立 ComfyUI 测试不是画布 Run，不能拿其成功结果冒充平台验收。
- 连接结果卡：创建 `type:'result', data:{kind:'audio'}`，再以 `audio-source → audio-target` 连接。只连到真实兼容的音频输入；配置工作流存在时，后端会校验输出类型，不能伪装图片端口。
- 成功后按真实资产信息更新源节点 lastAssets，使用平台 assetId/url/kind/filename。连接的结果卡可投影上游资产，不需要复制本地文件路径或伪造第二个资产。图同步遵守 active session 与当前 revision。

人工界面入口为画布空白处右键 → 音效生成（本地）→ 已注册工作流；填写参数、运行并确认，当前产物、节点历史和全画布流水提供音频播放器及下载。界面操作需要实际 UI 验证时才使用可用的浏览器控制能力，普通生产优先机器接口。

## Stable Audio 3 Medium 注意事项

精细动作音先关闭自动提示词扩写，明确动作次数、近远距离、尾音及排除事件；环境底声强调持续、稳定、无启动/停止。提示词排除音乐与说话不是质量保证。需要扩写时确认它走本地 Qwen 分支，不接云端 API。

官方 Music / Instrument / SFX / One-shot 是扩写预设：关闭扩写时直接使用原提示词，类别不会成为独立模型条件。下拉选项应取当前工作流 CustomCombo 的实际非空选项与 schema，不能以空的通用节点定义猜测枚举。若图保留独立的扩写 PreviewAny 输出节点，即使主分支关闭扩写也可能强制加载 Qwen；生产优先复用已验证的无损副本，不擅自修改共享工作流。

本机无损副本已显式把秒数连接到 `ConditioningStableAudio` 的正负条件，避免此环境默认 latent 时长向下取整造成末尾约一秒静音；编码前 −3 dB 为实测瞬态留出余量。这是该副本的修正，不是所有音频模型的通用配置，也不能保证任意提示词都不削波。运行时复用图并检查实际连接，不只改 EmptyLatentAudio 时长。输出长度有 latent 步长舍入，报告输入时长与解码时长，不承诺采样点精确。

## 交付与质量边界

优先保留实际无损 FLAC / WAV，下载保留真实格式及文件名，不把 FLAC 改扩展名为 WAV。使用客户端 `download <assetId> <当前项目内绝对路径>` 的覆盖保护；必要时核对 Content-Type、文件头、完整字节/哈希和 Range 播放响应，不能仅看 HTTP 200 或任务 succeeded。

技术验收检查可解码、采样率/声道、真实时长、非全静音、峰值/削波及异常静音；有现成分析能力时辅助检查 RMS/包络。不为普通验收默认安装依赖。环境声末尾静音与动作音自然留白需按用途判断，幅度活动分组不是事件计数，也不能证明无人声、无音乐或无杂声。

实际试听才可判断动作次数、额外声音、听觉连续性和尾音。浏览器播放器 readyState、进度推进或播放完成只证明播放链路，不代表代理听到了声音。没有语义听觉输入时明确交付待人工试听项；用户明确反馈试听通过后，可记录其人工验收意见及所针对的产物，但不能伪称代理亲自试听，也不能替用户调用候选 approve。

交付列出 canvas/Run/assetId、音频路径、提示词与参数、实际耗时及质量结果。耗时取真实 startedAt/finishedAt，说明是否包含冷加载/排队；旧记录时间缺失则标为不可用，不补造。重跑保留旧 Run 与候选，在授权预算内按具体问题有限修正；再次失败或达到预算时报告证据和剩余人工决策，不无限生成。
