// Independent ComfyUI acceptance requested by user; never used as a canvas Run substitute.
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {cases} from './cases.mjs';
const base='http://localhost:8188',dir='artifacts/stable-audio-3';
const scheduler=await (await fetch('http://localhost:3100/api/local-compute-scheduler/status')).json();
if(scheduler.blocked||scheduler.active)throw Error('Independent test requires an idle, managed ComfyUI');
const graph=JSON.parse(await readFile(`${dir}/duration-fixed-conversion.json`)).apiJson;
graph['52:54']=JSON.parse(await readFile(`${dir}/conversion.json`)).apiJson['52:54'];
const c=cases[1];
graph['52:31'].inputs.value=c.prompt;graph['52:36'].inputs.value=c.seconds;
graph['52:3'].inputs.seed=12092030;graph['52:35'].inputs.value=true;
graph['52:43'].inputs.choice='SFX';graph['52:43'].inputs.index=2;
graph['57'].inputs.filename_prefix='audio/stable_audio_3_medium/standalone-final-reprompt';
graph['57'].inputs.format='flac';delete graph['57'].inputs['format.quality'];
for(const name of ['standalone-prompt.json','standalone-submit.json','standalone-history.json','standalone-result.json']){
  const old=await readFile(`${dir}/${name}`).catch(()=>null);
  if(old&&!await readFile(`${dir}/${name}.initial`).catch(()=>null))await writeFile(`${dir}/${name}.initial`,old,{flag:'wx'});
}
await writeFile(`${dir}/standalone-prompt.json`,JSON.stringify(graph,null,2));
const began=Date.now();
const response=await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:graph,client_id:randomUUID()})});
const submitted=await response.json();await writeFile(`${dir}/standalone-submit.json`,JSON.stringify(submitted,null,2));
if(!response.ok)throw Error(JSON.stringify(submitted));
console.log(`Standalone prompt ${submitted.prompt_id}`);
for(;;){
  const history=(await (await fetch(`${base}/history/${submitted.prompt_id}`)).json())[submitted.prompt_id];
  if(history?.status?.completed){
    await writeFile(`${dir}/standalone-history.json`,JSON.stringify(history,null,2));
    if(history.status.status_str!=='success')throw Error(JSON.stringify(history.status));
    const outputs=Object.values(history.outputs).flatMap(o=>o.audio||[]);
    if(!outputs.length)throw Error('No actual audio output');
    for(const [i,o]of outputs.entries()){
      const bytes=Buffer.from(await (await fetch(`${base}/view?${new URLSearchParams(o)}`)).arrayBuffer());
      if(bytes.subarray(0,4).toString()!=='fLaC')throw Error('Expected FLAC');
      const filename=`${dir}/standalone-final${i?'_'+i:''}.flac`,old=await readFile(filename).catch(()=>null);
      if(old&&!old.equals(bytes))throw Error('Refuse overwrite');
      if(!old)await writeFile(filename,bytes,{flag:'wx'});
    }
    const result={promptId:submitted.prompt_id,seconds:c.seconds,seed:12092030,reprompt:true,category:'SFX',prompt:c.prompt,elapsedSeconds:(Date.now()-began)/1000,outputs,expandedText:history.outputs['52:54']};
    await writeFile(`${dir}/standalone-result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));break;
  }
  await new Promise(r=>setTimeout(r,2000));
  if(Date.now()-began>900000)throw Error('Standalone timeout; inspect existing prompt, do not resubmit blindly');
}
