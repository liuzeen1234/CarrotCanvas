import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ComfyUIGraphConverter}=require('../../backend/dist/comfyui/comfyui-graph-converter.js');
const dir=new URL('./',import.meta.url), base='http://127.0.0.1:8188';
const save=(name,value)=>fs.writeFile(new URL(name,dir),JSON.stringify(value,null,2));
async function json(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;}
const plan=JSON.parse(await fs.readFile(new URL('story-prompts.json',dir),'utf8'));
const wf=JSON.parse(await fs.readFile(new URL('../../video_minimax_h3_r2v.json',dir),'utf8'));
const node=id=>wf.nodes.find(n=>n.id===id);
function set(id,key,index,value){node(id).widgets_values[index]=value;node(id).widgets_values_named??={};node(id).widgets_values_named[key]=value;}
for(let i=1;i<=2;i++){
 const form=new FormData();form.append('image',new Blob([await fs.readFile(new URL(`reference-${i}.png`,dir))],{type:'image/png'}),`sky-reboot-reference-${i}.png`);form.append('subfolder','sky-reboot');form.append('overwrite','false');
 const r=await fetch(base+'/upload/image',{method:'POST',body:form});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));
 set(i===1?137:139,'image',0,(d.subfolder?d.subfolder+'/':'')+d.name);
}
set(138,'value',0,plan.video_prompt);
set(115,'megapixels',1,0.98);
set(132,'value',0,6);
set(146,'value',0,true);
set(129,'noise_seed',0,2609071842); node(129).widgets_values[1]='fixed';
set(92,'filename_prefix',0,'video/Sky_Reboot_R2V');
wf.id=crypto.randomUUID();wf.extra.ds={scale:0.35,offset:[2500,-4750]};
const info=await json('/object_info');
const converted=ComfyUIGraphConverter.convert(wf,info);
if(!converted.ok)throw Error(JSON.stringify(converted));
const prompt=converted.apiJson;
// Preserve ComfyUI's flat dynamic-input names so the backend actually receives both references.
if(!prompt['136'].inputs['ref_images.ref_image_0']||!prompt['136'].inputs['ref_images.ref_image_1'])throw Error('Reference links lost');
await save('workflow.json',wf);await save('api-prompt.json',prompt);
await json('/userdata/workflows%2FSky_Reboot_R2V.json?overwrite=false',wf);
const clientId=crypto.randomUUID();let promptId;
const socket=new WebSocket(base.replace('http:','ws:')+'/ws?clientId='+clientId);
await new Promise((res,rej)=>{socket.addEventListener('open',res,{once:true});socket.addEventListener('error',rej,{once:true});});
socket.addEventListener('message',async e=>{if(typeof e.data!=='string')return;const msg=JSON.parse(e.data);if(msg.type==='progress_state')return;await fs.appendFile(new URL('events.jsonl',dir),JSON.stringify({at:new Date().toISOString(),...msg})+'\n');if(['executing','progress','execution_error','execution_success'].includes(msg.type)) console.log(JSON.stringify(msg));});
const start=Date.now();const submitted=await json('/prompt',{prompt,client_id:clientId,extra_data:{extra_pnginfo:{workflow:wf}}});
promptId=submitted.prompt_id;await save('submitted.json',{...submitted,start:new Date(start).toISOString()});console.log('SUBMITTED '+promptId);
for(;;){await new Promise(r=>setTimeout(r,15000));const history=await json('/history/'+promptId);if(!history[promptId])continue;const item=history[promptId];await save('history.json',item);if(item.status?.completed||item.status?.status_str==='error'){
 console.log('FINISHED '+JSON.stringify({status:item.status,seconds:(Date.now()-start)/1000,outputs:item.outputs}));
 if(item.status.status_str==='error'){socket.close();process.exitCode=1;break;}
 for(const output of Object.values(item.outputs??{}))for(const files of Object.values(output))if(Array.isArray(files))for(const f of files){if(f?.filename?.endsWith('.mp4')){const r=await fetch(base+'/view?'+new URLSearchParams(f));await fs.writeFile(new URL('Sky_Reboot.mp4',dir),Buffer.from(await r.arrayBuffer()));}}
 socket.close();break;
}}
