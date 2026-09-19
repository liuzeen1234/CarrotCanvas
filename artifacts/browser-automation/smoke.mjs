// 冒烟测试：attach 到已运行的 Chrome（CDP），打开 CarrotCanvas 前端，验证链路。
//
// 前置：先跑 `node launch-chrome.mjs` 让 9222 就绪。
//
// 用法：
//   node smoke.mjs
//   node smoke.mjs --port 9333 --url http://localhost:8000
//
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(getArg('--port', '9222'));
const URL = getArg('--url', 'http://localhost:8000');

console.log(`[smoke] 通过 CDP attach 到 http://localhost:${PORT} ...`);
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);

const context = browser.contexts()[0]; // 复用现有上下文（带登录态）
if (!context) {
  console.error('[smoke] ❌ 没有可用的浏览器上下文');
  process.exit(1);
}

// 复用已有标签页或新开一个
let page = context.pages().find((p) => p.url().includes('localhost:8000')) ?? (await context.newPage());
console.log(`[smoke] 打开 ${URL} ...`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

// 等 SPA 真正渲染出内容（React 挂载后 #root 会有子节点）
try {
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#root') || document.body;
      return root && root.innerText.trim().length > 0;
    },
    { timeout: 15000 }
  );
} catch {
  console.warn('[smoke] ⚠ 等待渲染超时，仍继续截图以便诊断');
}

const title = await page.title();
console.log(`[smoke] 页面标题：${title || '(空)'}`);
console.log(`[smoke] 当前 URL：${page.url()}`);

// 诊断：证明页面真的渲染了内容，而不是白屏
const diag = await page.evaluate(() => {
  const root = document.querySelector('#root') || document.body;
  const text = (root?.innerText || '').trim();
  return {
    bodyTextLength: text.length,
    textPreview: text.slice(0, 200),
    rootChildCount: root?.childElementCount ?? 0,
    linkCount: document.querySelectorAll('a').length,
    buttonCount: document.querySelectorAll('button').length,
  };
});
console.log('[smoke] 页面诊断：', JSON.stringify(diag, null, 2));

const shotPath = path.join(__dirname, 'smoke-screenshot.png');
await page.screenshot({ path: shotPath, fullPage: true });
console.log(`[smoke] ✅ 截图已保存：${shotPath}`);

// 不关闭浏览器（attach 模式下 close 只断开连接，不杀浏览器）
await browser.close();
console.log('[smoke] 完成，已断开 CDP 连接（Chrome 保持打开）。');
