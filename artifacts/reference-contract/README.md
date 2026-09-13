# 参考图存储合同验证（2026-09-13）

修改仓库 Skill 的 SKILL.md、references/operations.md，并同步同名文件到 C:/Users/liu/.codex/skills/carrot-canvas/；两对文件 SHA-256 一致。按 AGENTS.md 更新两份设计文档的变更记录，阶段范围不变。

CodexCapabilityNode.tsx 修改前后 SHA-256 均为 `24622C0A7234B41972D580613C9523A47AAA6D0E8B04308819B7FC4E2E20BECF`，既有去重与产物预览修复保持完整。本次未修改其他业务代码。

从仓库根复验：

```powershell
node backend/node_modules/jest/bin/jest.js --config artifacts/reference-contract/jest.config.cjs --runInBand
```

结果：1 suite / 4 tests 通过。

- 执行 Codex 组件实际组装与提示词编译表达式：连线、上传、混合、旧副本、上传重复、重排、重复排序 ID、未排序引用，以及相同 assetId 的上传/两条独立连线仍保留各自输入位置。
- 执行 ComfyUI 组件实际组装表达式：连线、上传、混合文件型引用、旧副本与排序；核对当前资产血缘 Set 的实现边界。
- 执行文档混合示例：referenceImages 仅含上传图，排序及提示词绑定仍含连线引用。
- 内存 SQLite 使用实际 CanvasService：正常 agent acquire/update_node/release；无有效租约写入被拒绝。清理 Codex 与 ComfyUI 旧数组副本后，连线、排序、提示词绑定、formValues、其他媒体组及产物保持，未调用资产清理。

只执行本地无费用行为验证；未提交 provider Run、未做付费生成、未修改业务画布旧数据、未重启服务，也未将这些验证视为新的浏览器或 provider 验收。两份 Skill 与两份设计文档的 git diff --check 通过。
