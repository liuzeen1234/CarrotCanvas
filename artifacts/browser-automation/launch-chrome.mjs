// 启动带 CDP 调试端口的 Chrome，使用【自动化专用独立 profile】。
//
// 路线 C：不碰你的日常 Chrome。自动化用一个独立 user-data-dir（本目录下 .chrome-profile），
// 可反复复用，登录态/cookie 只属于这个专用 profile，与日常浏览完全隔离。
//
// 用法：
//   node launch-chrome.mjs            # 专用 profile + 端口 9222
//   node launch-chrome.mjs --port 9333
//
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 9222;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 自动化专用独立用户数据目录（与日常 Chrome 隔离）
const USER_DATA_DIR = path.join(__dirname, '.chrome-profile');

async function isCdpUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const alreadyUp = await isCdpUp(PORT);
if (alreadyUp) {
  console.log(`[launch] CDP 已在端口 ${PORT} 就绪，直接复用，不重复启动。`);
  process.exit(0);
}

if (!existsSync(CHROME)) {
  console.error(`[launch] 找不到 Chrome：${CHROME}`);
  process.exit(1);
}

console.log(`[launch] 专用 profile 目录：${USER_DATA_DIR}`);
console.log(`[launch] 在端口 ${PORT} 启动 Chrome（调试端口，独立 profile，不影响日常浏览器）...`);

const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'http://localhost:8000',
  ],
  { detached: true, stdio: 'ignore' }
);
child.unref();

// 等待 CDP 就绪
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await isCdpUp(PORT)) {
    console.log(`[launch] ✅ CDP 已就绪：http://localhost:${PORT}/json/version`);
    process.exit(0);
  }
}
console.error('[launch] ❌ 等待 CDP 就绪超时。可能是同 profile 的 Chrome 仍在运行。');
process.exit(1);
