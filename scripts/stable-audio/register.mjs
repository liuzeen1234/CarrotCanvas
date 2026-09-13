import { readFile, writeFile } from 'node:fs/promises';
const dir = 'artifacts/stable-audio-3';
async function request(base, route, body) {
  const r = await fetch(`${base}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text(); if (!r.ok) throw Error(`${r.status}: ${text}`); return text ? JSON.parse(text) : null;
}
const comfy = 'http://localhost:8188', platform = 'http://localhost:3100/api';
const official = JSON.parse(await readFile(`${dir}/audio_stable_audio_3_medium.official.json`));
const local = structuredClone(official);
const root = local.nodes.find(n => n.id === 52);
Object.assign(root.widgets_values_named, { user_input: 'Steady office air conditioning ventilation hum, continuous soft airflow, no voices, no music, no sudden events. Length: 25 seconds.', duration: 25, seed: 12092026, use_reprompt: false, category: 'SFX' });
root.widgets_values = ['Steady office air conditioning ventilation hum, continuous soft airflow, no voices, no music, no sudden events. Length: 25 seconds.',25,12092026,false,'SFX','stable_audio_3_medium.safetensors','t5gemma_b_b_ul2.safetensors','qwen3.5_2b_bf16.safetensors'];
const save = local.nodes.find(n=>n.type==='SaveAudioAdvanced');
save.widgets_values=['audio/stable_audio_3_medium','flac']; save.widgets_values_named={filename_prefix:'audio/stable_audio_3_medium',format:'flac'};
// Optional preview is an OUTPUT_NODE: leaving it enabled forces Qwen even when the lazy switch is false.
for (const graph of local.definitions.subgraphs) for(const n of graph.nodes) if(n.id===54) n.mode=2;
const files = await request(comfy, '/userdata?dir=workflows');
for (const [name, graph] of [['audio_stable_audio_3_medium.json',official],['audio_stable_audio_3_medium_lossless.json',local]]) {
  const route = `/userdata/${encodeURIComponent(`workflows/${name}`)}`;
  if (!files.includes(name)) await request(comfy,`${route}?overwrite=false`,graph);
  else console.log(`Existing workflow retained: ${name}`);
}
await writeFile(`${dir}/audio_stable_audio_3_medium_lossless.json`,JSON.stringify(local,null,2));
const preview = await request(platform, '/comfyui/workflows/preview', {filename:'audio_stable_audio_3_medium_lossless.json'});
await writeFile(`${dir}/lossless-preview.json`,JSON.stringify(preview,null,2));
if(!preview.ok)throw Error(JSON.stringify(preview.errors));
const fields=[['52:31','value','音效提示词','建议使用英文明确描述声源、动作和排除项。'],['52:36','value','时长（秒）','Medium 最长 380 秒；短动作建议 3–5 秒。'],['52:3','seed','随机种子','固定种子便于复现；可使用随机按钮。'],['52:35','value','自动提示词扩写（本地 Qwen）','默认关闭。精细动作音保持关闭，避免扩写增加额外事件。'],['52:43','choice','官方扩写类别','Music / Instrument / SFX / One-shot 是官方扩写预设，关闭扩写时不会额外影响音频模型。']];
const payload={name:'Stable Audio 3 Medium · 本地音效',category:'txt2audio',description:'官方普通 Medium，8 steps / CFG 1 / LCM；默认关闭本地扩写，输出无损 FLAC。',tags:['local','Stable Audio 3','SFX','One-shot','FLAC'],content:JSON.stringify(preview.apiJson),exposureConfig:{version:1,fields:fields.map(([nodeId,param])=>({nodeId,param}))},inputConfig:{version:1,fields:[{nodeId:'52:31',param:'value',kind:'text'}]},fieldConfig:{version:1,fields:fields.map(([nodeId,param,label,description])=>({nodeId,param,label,description}))}};
const existing=(await request(platform,'/workflows')).find(w=>w.name===payload.name);
const workflow=existing ?? await request(platform,'/workflows',payload);
await writeFile(`${dir}/workflow.json`,JSON.stringify(workflow,null,2));
console.log(JSON.stringify({id:workflow.id,name:workflow.name,nodeCount:preview.nodeCount,warning:preview.warnings}));
