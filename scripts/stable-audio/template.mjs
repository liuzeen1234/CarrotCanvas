import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = 'artifacts/stable-audio-3'; await mkdir(dir, { recursive: true });
let content, source;
try {
  const r = await fetch('https://api.github.com/repos/Comfy-Org/workflow_templates/contents/templates/audio_stable_audio_3_medium.json');
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const data = await r.json(); content = Buffer.from(data.content, 'base64'); source = { url: data.html_url, gitBlob: data.sha };
} catch (error) {
  console.log(`GitHub unavailable: ${error.message}; using installed official template package`);
  content = await readFile('D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/standalone-env/Lib/site-packages/comfyui_workflow_templates_json/templates/audio_stable_audio_3_medium.json');
  source = { package: 'comfyui-workflow-templates 0.11.46', url: 'https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_3_medium.json' };
}
const template = JSON.parse(content);
await writeFile(`${dir}/audio_stable_audio_3_medium.official.json`, content);
await writeFile(`${dir}/template-source.json`, JSON.stringify({ ...source, sha256: createHash('sha256').update(content).digest('hex') }, null, 2));
const { ComfyUIGraphConverter } = await import('../../backend/dist/comfyui/comfyui-graph-converter.js');
const info = await (await fetch('http://localhost:8188/object_info')).json();
const result = ComfyUIGraphConverter.convert(template, info);
await writeFile(`${dir}/conversion.json`, JSON.stringify(result, null, 2));
await writeFile(`${dir}/object-info.json`, JSON.stringify(info));
console.log(JSON.stringify({source, ok:result.ok, warnings:result.warnings, errors:result.errors, nodes:Object.entries(result.apiJson ?? {}).map(([id,n])=>({id,...n}))},null,2));
