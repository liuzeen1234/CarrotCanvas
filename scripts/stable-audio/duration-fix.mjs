import {readFile,writeFile} from 'node:fs/promises';
const dir='artifacts/stable-audio-3';
const local=JSON.parse(await readFile(`${dir}/audio_stable_audio_3_medium_lossless.json`));
const s=local.definitions.subgraphs.find(s=>s.nodes.some(n=>n.type==='KSampler'));
if(!s.nodes.some(n=>n.type==='ConditioningStableAudio')){
  for(const id of [4,6]){const link=s.links.find(l=>l.id===id);link.origin_id=58;link.origin_slot=id===4?0:1;}
  for(const [id,link]of [[6,86],[7,87]])s.nodes.find(n=>n.id===id).outputs[0].links=[link];
  s.nodes.find(n=>n.id===36).outputs[0].links.push(88);
  s.links.push({id:86,origin_id:6,origin_slot:0,target_id:58,target_slot:0,type:'CONDITIONING'},{id:87,origin_id:7,origin_slot:0,target_id:58,target_slot:1,type:'CONDITIONING'},{id:88,origin_id:36,origin_slot:0,target_id:58,target_slot:3,type:'FLOAT'});
  s.nodes.push({id:58,type:'ConditioningStableAudio',pos:[610,730],size:[420,190],flags:{},order:22,mode:0,title:'Explicit audio duration (avoid inferred integer truncation)',inputs:[{name:'positive',type:'CONDITIONING',link:86},{name:'negative',type:'CONDITIONING',link:87},{name:'seconds_start',type:'FLOAT',widget:{name:'seconds_start'},link:null},{name:'seconds_total',type:'FLOAT',widget:{name:'seconds_total'},link:88}],outputs:[{name:'positive',type:'CONDITIONING',links:[4]},{name:'negative',type:'CONDITIONING',links:[6]}],properties:{'Node name for S&R':'ConditioningStableAudio',cnr_id:'comfy-core'},widgets_values:[0,25],widgets_values_named:{seconds_start:0,seconds_total:25}});
  s.state.lastNodeId=58;s.state.lastLinkId=88;
}
if(!local.nodes.some(n=>n.type==='AudioAdjustVolume')){
  local.links[0]=[85,60,0,57,0,'AUDIO'];local.links.push([89,52,0,60,0,'AUDIO']);
  local.nodes.find(n=>n.id===52).outputs[0].links=[89];
  local.nodes.find(n=>n.id===57).pos=[1150,1120];
  local.nodes.push({id:60,type:'AudioAdjustVolume',pos:[820,1120],size:[280,110],flags:{},order:1,mode:0,title:'Output headroom (-3 dB, before FLAC encoding)',inputs:[{name:'audio',type:'AUDIO',link:89}],outputs:[{name:'AUDIO',type:'AUDIO',links:[85]}],properties:{'Node name for S&R':'AudioAdjustVolume',cnr_id:'comfy-core'},widgets_values:[-3],widgets_values_named:{volume:-3}});
  local.last_node_id=60;local.last_link_id=89;
}
const {ComfyUIGraphConverter}=await import('../../backend/dist/comfyui/comfyui-graph-converter.js');
const info=await(await fetch('http://localhost:8188/object_info')).json(),result=ComfyUIGraphConverter.convert(local,info);
if(!result.ok||!result.apiJson['52:58'])throw Error(JSON.stringify(result.errors));
const w=JSON.parse(await readFile(`${dir}/workflow.json`));
async function send(url,method,body){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(`${r.status} ${await r.text()}`);return r.json();}
await send('http://localhost:8188/userdata/workflows%2Faudio_stable_audio_3_medium_lossless.json?overwrite=true','POST',local);
const updated=await send(`http://localhost:3100/api/workflows/${w.id}`,'PATCH',{content:JSON.stringify(result.apiJson),description:'官方普通 Medium 本地适配，显式时长条件，8 steps / CFG 1 / LCM；默认关闭本地扩写、FLAC 编码前 -3 dB 余量。'});
await writeFile(`${dir}/audio_stable_audio_3_medium_lossless.json`,JSON.stringify(local,null,2));
await writeFile(`${dir}/workflow.json`,JSON.stringify(updated,null,2));
await writeFile(`${dir}/duration-fixed-conversion.json`,JSON.stringify(result,null,2));
for(const filename of ['test-results.json','office-hvac.run.json','paper-turn.run.json','drawer-close.run.json','canvas-ui-run.json']){
 const old=await readFile(`${dir}/${filename}`).catch(()=>null);
 if(old&&!await readFile(`${dir}/${filename}.initial`).catch(()=>null))await writeFile(`${dir}/${filename}.initial`,old,{flag:'wx'});
}
console.log(JSON.stringify({workflowId:w.id,node:result.apiJson['52:58'],warnings:result.warnings}));
