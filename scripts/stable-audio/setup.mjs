import { mkdir, readFile, writeFile, stat, rename, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';

const artifacts = path.resolve('artifacts/stable-audio-3');
await mkdir(artifacts, { recursive: true });
async function json(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json();
}
const ms = await json('https://modelscope.cn/api/v1/models/Comfy-Org/stable-audio-3/repo/files?Recursive=true');
const hf = await json('https://hf-mirror.com/api/models/Comfy-Org/stable-audio-3/tree/main?recursive=true');
await writeFile(path.join(artifacts, 'modelscope-files.json'), JSON.stringify(ms, null, 2));
await writeFile(path.join(artifacts, 'hf-mirror-files.json'), JSON.stringify(hf, null, 2));
async function hash(file) {
  const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex');
}
const manifest = [];
await Promise.all(['checkpoints/stable_audio_3_medium.safetensors', 'text_encoders/t5gemma_b_b_ul2.safetensors'].map(async name => {
  const m = ms.Data.Files.find(x => x.Path === name);
  const h = hf.find(x => x.path === name);
  if (!m || !h || m.Size !== h.size || m.Sha256 !== h.lfs.oid) throw new Error(`Mirror mismatch: ${name}`);
  const target = path.join('D:/Comfy-Desktop/ComfyUI-Shared/models', name);
  await mkdir(path.dirname(target), { recursive: true });
  let s = await stat(target).catch(() => null);
  if (!s) {
    const temp = `${target}.part`;
    const r = await fetch(`https://modelscope.cn/models/Comfy-Org/stable-audio-3/resolve/master/${name}`);
    if (!r.ok) throw new Error(`Download ${name}: ${r.status}`);
    console.log(`Downloading ${name}: ${m.Size} bytes`);
    let bytes = 0, last = 0;
    const stream = Readable.fromWeb(r.body);
    stream.on('data', chunk => { bytes += chunk.length; if (Date.now() - last > 15000) { console.log(`${name}: ${(100*bytes/m.Size).toFixed(1)}%`); last = Date.now(); } });
    await pipeline(stream, createWriteStream(temp));
    s = await stat(temp);
    if (s.size !== m.Size || await hash(temp) !== m.Sha256) throw new Error(`Integrity failure: ${name}`);
    await rename(temp, target);
  } else if (s.size !== m.Size || await hash(target) !== m.Sha256) throw new Error(`Existing file mismatch: ${target}`);
  const fd = await open(target, 'r'); const buf = Buffer.alloc(8); await fd.read(buf, 0, 8, 0);
  const headerSize = Number(buf.readBigUInt64LE()); const header = Buffer.alloc(headerSize); await fd.read(header, 0, headerSize, 8); await fd.close();
  JSON.parse(header.toString());
  manifest.push({ name, target, size: m.Size, sha256: m.Sha256, source: 'ModelScope', officialMirrorMatched: true, safetensorsHeaderValid: true });
  console.log(`Verified ${name}`);
}));
await writeFile(path.join(artifacts, 'model-manifest.json'), JSON.stringify(manifest, null, 2));
