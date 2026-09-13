# Stable Audio 3 Medium 验收素材

[完整集成与验收说明](../../docs/STABLE-AUDIO-INTEGRATION.md)。工程与技术验收通过，代理无法语义试听，听感仍需人工验收。

- `office-hvac-final.flac`：空调底声，24.984671 秒，seed 12092032，assetId `976cbbb7-a5d2-404b-b929-1e8c60a86e78`。
- `paper-turn-final.flac`：翻纸，3.993832 秒，seed 12092027，assetId `52abf2a6-a492-4d42-b0b0-b3919b824163`。
- `drawer-close-final.flac`：抽屉，3.993832 秒，seed 12092028，assetId `48ba81c3-a4cd-4b15-8302-e66cb93f010c`。
- `canvas-ui-drawer-final.flac`：真实界面补测抽屉，seed 12092029，assetId `618da775-5018-4ee3-a182-03a9f37087c9`，建议同时试听比较。
- `standalone-final.flac`：独立 ComfyUI、开启本地 Qwen/SFX 扩写测试，不是平台画布 Run。

`test-results.json` / `canvas-ui-run.json` 保存真实提示词、参数、执行时间与 Run；`canvas-history.json` / `canvas-final.json` 保存最终平台事实；`audio-analysis.json` 保存解码与幅度分析。其余初版及中间文件保留用于追溯，不把它们与最终素材混淆。幅度活动分组不能判断语义事件次数。

复用脚本（在仓库根）：`template.mjs` 拉官方文件；`register.mjs` 注册默认副本；`duration-fix.mjs` 加入时长与编码前余量、更新自己创建的无损副本，原模板不改；`canvas-test.mjs` 通过 carrot-canvas 客户端正常 lease/revision 运行三组；`standalone.mjs` 只在队列空闲时独立验证；`qa.mjs` 使用现有 Python PyAV/NumPy。测试幂等键固定，重新执行不代表新生成；要新生成应明确换参数和幂等键，不盲目重试未知状态任务。
