# MiniMax H3 提示词写作

仅在 AI 直接为 CarrotCanvas 的 MiniMax H3 卡片创建、改写或审查生成提示词时读取。本文把 MiniMax 官方 `h3-prompt-writing` 规则适配到 CarrotCanvas 的稳定引用和画布保存合同；普通视频模型、已有提示词的原样运行、仅修改参数或查看历史不需要读取。

上游依据：

- `https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing`
- `references/base-en.txt`：T2VA、I2VA、FL2VA、L2VA
- `references/ref-en.txt`：Ref2VA

本地规则优先解决 CarrotCanvas 的引用身份、持久化和提交边界；提示词结构与语义遵循上述官方指南。上游规则更新时应重新核对本文，不凭记忆扩展格式。

## 先确认运行模式

先读取实时 workflow、API JSON、`inputConfig`、卡片引用组和目标时长，不只看工作流名称或图片数量。

- 实际生成节点属于文本/首尾帧家族时，按 T2VA、I2VA、FL2VA 或 L2VA 写三段基础结构。
- 实际生成节点为 `MiniMaxH3ReferenceToVideo`，或当前统一 H3 卡片会在提交阶段升级为该协议时，按 Ref2VA 写六段结构。
- 图片是首帧、末帧、首尾帧还是普通角色/场景参考，取决于用户意图和工作流角色，不由“有一张/两张图”自动决定。
- 视频仅提供动作、镜头或节奏参考时属于 reference generation；只有直接修改或续接原视频时才属于 video editing 或 video continuation。
- 音频仅在信号被复制或其音色、节奏、内容等被参考时声明相应关系；文件存在本身不等于复用其声音。

无法从实时配置和用户目标判定关键帧角色时，不擅自生成昂贵 Run；先保留明确的创作目标并向用户确认会改变成片语义的缺失选择。

## CarrotCanvas 稳定引用

卡片保存的是稳定 token，不是最终序号标签：

- 图片：卡片中绑定到 `promptMediaReferences` 的 `@名称·ID`，提交时编译为 `<Picture N>`。
- 视频：稳定 `@名称·ID`，提交时编译为 `<Video N>`。
- 独立参考音频：稳定 `@名称·ID`，提交时编译为 `<Audio N>`。
- 视频配音：按位置与同序参考视频配对，不生成提示词 token；不要为它伪造 `<Audio N>`。

在下面所有结构示例中，需要引用素材的位置都应在 canonical prompt 中使用其真实稳定 `@` token；`<Picture N>` 等仅表示提交后的预期结果。不要手写不存在的 token，也不要用文件名、assetId、卡片名或数组下标替代 referenceId 绑定。

更新提示词时同步维护 `promptMediaReferences`，但不改变不相关的 `referenceMedia`、排序、边、表单参数或产物。保存后重读 agent-view，按当前组内顺序确认每个活动 token 都能解析且编译标签正确。

## 基础与关键帧模式

最终提示词按以下字段顺序组织，不输出通用 `positive` / `negative` JSON：

```text
integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

模式差异：

- T2VA：直接从三段结构开始，建立完整视听时间线。
- I2VA：最前面声明首帧在 `0.00` 秒完整对应输入图片，再描述从该帧连续发展的动作路径。
- FL2VA：最前面声明首图对应 `0.00` 秒、末图对应视频结束时间，主体、物体、构图和镜头必须沿可观察路径逐渐抵达末帧。通常优先单镜头连续变化。
- L2VA：最前面声明输入图对应视频结束时间，从合理的较早状态逐渐收敛到该末帧，不能把末帧误写成开场。

关键帧说明必须是第一段，后接空行再写三段主体。canonical prompt 中用对应稳定 `@` token；提交后的编译结果应与实际序号和精确到两位小数的总时长一致。

`integrated_multimodal_description` 应沿播放顺序写可见或可听事件：

- `[Shot 1]` 不写切入时间；后续镜头使用严格递增且小于总时长的 `[Shot N] At MM:SS.mmm, ...`。
- 每个镜头交代必要的构图、主体、环境、动作、摄像机和同步声音；避免只写剧情摘要或堆叠“电影感、唯美”等抽象词。
- 运镜用自然语言说明类型；需要时补充幅度和速度。轻微景别变化优先连续运镜，不滥用切镜。
- 同一发声者跨镜头复用 `(S1)`、`(S2)`。对白或歌词写作 `<d>[Language] 原文</d>`，保留用户给出的原语言和文字，不翻译、不改写。
- 画外旁白要明确是 off-screen voiceover，并说明画面内对应人物嘴唇不动；跨切镜延续的语音或被结尾截断的语音明确连续关系。
- 可见招牌、字幕等场景文字保留原文并加英文双引号。

`overall_soundscape` 用一段简洁英文总结环境声、动作声和非语言人声。对白、歌唱和画内音乐已在主描述出现，不在这里重复。只有用户明确要求全程静音时才写 `N/A`。

`non_diegetic_music` 只描述角色听不到、观众能听到的配乐，写明乐器、速度、节奏及动态变化。画内收音机、演奏或歌唱属于主描述。没有画外配乐时写 `N/A`。

## Ref2VA 六段结构

当前统一多媒体 H3 卡片通常走 Ref2VA。严格按以下顺序输出：

```text
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

### subject_definitions

为后续需要独立追踪的参考内容逐行定义稳定角色：

- `<Subject N>` 表示从一个或多个素材抽象出的可复用人物、物体、环境、服装、动作或风格，不代表文件本身。
- 图片只有在充当具体首帧、关键帧、末帧、构图或分镜锚点时才单独定义 `<Picture N>`；若只用于定义角色或场景，在对应 Subject 定义里引用即可。
- `<Video N>` 表示源视频本身的编辑、续接或整体镜头/节奏结构；其中的人物、动作或场景仍应定义为 Subject。
- `<Audio N>` 表示确实复制或参考的音频信号。若用于某个发声者的音色，复用该发声者在成片中的 `(Sx)`，不要另起编号。

同一标签在六段中含义必须不变。一个素材可以贡献多个 Subject；一个 Subject 也可以综合多项素材，但要明确各素材提供什么。

### summary

用一个短英文段落概括目标视频与参考关系，以真实任务类型前缀开头。可组合的类型只有：

- `keyframe completion`
- `reference generation`
- `video editing`
- `video continuation`
- `audio reuse`
- `audio reference`

多项用 ` + ` 连接且不重复。summary 只能使用 subject_definitions 已定义的标签，不在此新增标签。

### retention_analysis

为每个实际使用的参考标签单独写一行，说明它出现的位置、保留方式和变化边界。

视觉标签只使用：

- `fully_preserved`
- `partially_preserved`
- `attribute_transfer`
- `weak_reference`

音频标签只使用：

- `fully_copy`
- `partially_copy`
- `reference`
- `weak_reference`

标记必须与定义的参考角色一致。新增剧情、动作或背景不自动构成参考内容损失；不得为了显得完整而声称未发生的 1:1 复制。

### detailed_description

这是按成片播放顺序写的主体。先用一两句英文建立整体视觉风格，再写镜头：

- `[Shot 1]` 无时间戳；后续镜头使用严格递增的 `At MM:SS.mmm`。
- 在重要 Subject 第一次清晰出现时说明其参考特征、画面位置和当前动作，后续继续用同一标签，不重复定义。
- 关键帧自然表达为从某图片开始、某图片对应中间关键帧或最终落到某图片；canonical prompt 使用稳定 `@` token。
- 编辑或续接源视频时，在其状态、结构或续接关系实际生效的位置引用对应 Video。
- 音频复制或参考关系只在它实际生效的镜头或语义阶段引用对应 Audio。
- 发声 Subject 同时写 `<Subject N> (Sx)`；只有直接复用的歌曲/整轨自身发声且不存在独立说话者时，才让 Audio 作为声音来源。
- 无法听清的参考语音写 `[unclear]`，不能猜词。仅参考音色、节奏或情绪时，不把原对白带入目标视频。

不要机械追求篇幅；细节量应足以约束实际镜头、动作、引用和声音，同时适配目标时长。对白密集时优先保证真实可说完，不能把明显超过时长的台词塞入短片。

### 声音两段

`overall_soundscape` 与 `non_diegetic_music` 的边界同基础模式。引用音频时，只在对应听觉层说明 copy/reference：环境和音效进入 soundscape，观众可听而角色不可听的配乐进入 non-diegetic music。完整对白或歌词只写在 detailed_description 的 `<d>` 中。

提示词里的“更响、逐渐增强、淡出”等只是生成意图，不能保证确定 dB、峰值或 LUFS。需要精确音量调整时，应使用独立音频处理流程，不能声称 H3 提示词已经完成后期增益或响度标准化。

## 写入前自检

在更新卡片前完成以下检查：

1. 实时工作流支持所选模式，目标时长为 4–15 秒。
2. 使用正确的三段或六段结构，字段齐全且顺序固定；没有套用通用正负提示词 JSON。
3. 所有镜头时间严格递增并落在目标时长内；关键帧对齐结束时间与实际时长一致。
4. 每个素材引用使用真实稳定 `@` token，并有匹配的 `promptMediaReferences`；没有悬空、伪造或错类型引用。
5. 引用重排只改变最终编号，不改变 token 指向；视频配音没有被误编号为独立 Audio。
6. Subject、Picture、Video、Audio 和 `(Sx)` 在全文含义一致，summary 与 retention 没有引入未定义标签。
7. 对白、歌词、画面文字保留原文；声音没有在主描述、soundscape 和 music 段重复归类。
8. 没有编造素材不可观察的身份、品牌事实、对白、音频复制关系或精确音量结果。
9. 更新仅修改提示词及必要绑定；保存后重读 agent-view，验证引用、顺序、formValues 和其他卡片数据未被意外覆盖。
