import {open,stat,readFile,writeFile} from 'node:fs/promises';
const dir='artifacts/stable-audio-3',models=[];
for(const name of ['stable-audio-3-manifest.json','Qwen3.5-manifest.json'])for(const m of JSON.parse(await readFile(`${dir}/${name}`))){
  const fd=await open(m.target,'r'),size=(await stat(m.target)).size,first=Buffer.alloc(8);
  await fd.read(first,0,8,0);const bytes=Number(first.readBigUInt64LE());
  if(bytes<=0||bytes>20*1024*1024)throw Error(`Invalid header size ${m.name}`);
  const header=Buffer.alloc(bytes);await fd.read(header,0,bytes,8);await fd.close();
  const data=JSON.parse(header),tensors=Object.entries(data).filter(([k])=>k!=='__metadata__');
  for(const [key,t]of tensors){if(t.data_offsets[1]+bytes+8>size)throw Error(`Truncated tensor ${key}`);}
  models.push({...m,safetensorsHeaderValid:true,tensors:tensors.length,keyExamples:tensors.slice(0,4).map(([k])=>k)});
}
const env=await(await fetch('http://localhost:8188/system_stats')).json();
const allInfo=await(await fetch('http://localhost:8188/object_info')).json();
const workflow=JSON.parse(await readFile(`${dir}/workflow.json`)),graph=typeof workflow.apiJson==='string'?JSON.parse(workflow.apiJson):workflow.apiJson;
const nodeTypes=[...new Set(Object.values(graph).map(n=>n.class_type))];
for(const type of nodeTypes)if(!allInfo[type])throw Error(`Missing node ${type}`);
await writeFile(`${dir}/environment-audit.json`,JSON.stringify({checkedAt:new Date().toISOString(),models,env,nodeTypes,missingNodes:[],checkpointRecognized:allInfo.CheckpointLoaderSimple.input.required.ckpt_name[0].includes('stable_audio_3_medium.safetensors'),comfyProcess:await(await fetch('http://localhost:3100/api/comfyui/process-status')).json()},null,2));
console.log(JSON.stringify({models:models.map(({name,size,sha256,tensors})=>({name,size,sha256,tensors})),nodeTypes}));
