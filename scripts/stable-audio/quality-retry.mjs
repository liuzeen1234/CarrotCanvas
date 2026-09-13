import {readFile,writeFile} from 'node:fs/promises';
export const options={summary:'空调底声补生成两份固定种子候选，原样本不删除；幅度检验不替代听感。'};
export default async function(s){
  const dir='artifacts/stable-audio-3',w=JSON.parse(await readFile(`${dir}/workflow.json`));
  const base=typeof w.apiJson==='string'?JSON.parse(w.apiJson):w.apiJson;
  const prompt='A continuous field recording of the ventilation fan of an office air conditioner running steadily. Smooth soft broadband airflow noise with an even low mechanical hum, uninterrupted and at the same constant volume from beginning to end, a sustained neutral ambient noise bed. No start-up or shutdown, no clicks or impacts, no moving objects, no speech, no voices, no music. Length: 25 seconds.';
  const results=[];
  for(const [i,seed]of [12092031,12092032].entries()){
    const g=structuredClone(base),id=`hvac-steady-${i+1}`;
    g['52:31'].inputs.value=prompt;g['52:36'].inputs.value=25;g['52:3'].inputs.seed=seed;
    g['52:35'].inputs.value=false;g['52:43'].inputs.choice='SFX';g['52:43'].inputs.index=2;
    g['57'].inputs.filename_prefix=`audio/stable_audio_3_medium/${id}`;
    const n=s.canvas.graph.nodes.find(n=>n.id==='office-hvac');
    await s.operations([{type:'update_node',nodeId:n.id,dataPatch:{formValues:{...n.data.formValues,'52:31::value':prompt,'52:3::seed':seed},note:'空调底声补生成：幅度平稳度筛查，原候选保留。无音乐/人声及连续性仍需人工试听。'}}],`准备空调补生成 ${seed}`);
    const r=await s.write('POST','/comfyui/runs',{canvasId:s.canvasId,nodeId:n.id,workflowId:w.id,apiJson:g,inputAssetIds:[],idempotencyKey:`sa3-${s.canvasId}-${id}`},{providerRun:true});
    let run;do{await s.get(`/comfyui/runs/${r.run.promptId}`);run=await s.get(`/runs/${r.persistentRun?.id||r.run.runId}`);if(!['queued','running'].includes(run.status))break;await new Promise(r=>setTimeout(r,1000));s.assertActive();}while(true);
    if(run.status!=='succeeded'||!run.outputAssetIds.length)throw Error(JSON.stringify(run.error));
    await writeFile(`${dir}/${id}.run.json`,JSON.stringify(run,null,2));
    const assetId=run.outputAssetIds[0],bytes=Buffer.from(await(await fetch(`http://localhost:3100/api/assets/${assetId}/download`)).arrayBuffer());
    const filename=`${dir}/${id}.flac`,old=await readFile(filename).catch(()=>null);if(old&&!old.equals(bytes))throw Error('Refuse overwrite');if(!old)await writeFile(filename,bytes,{flag:'wx'});
    await s.operations([{type:'update_node',nodeId:n.id,dataPatch:{lastAssets:[{assetId,url:`/api/assets/${assetId}`,kind:'audio'}]}}],`保留空调候选 ${seed}`);
    results.push({id,prompt,seed,seconds:25,reprompt:false,category:'SFX',runId:run.id,assetId,generationSeconds:(run.finishedAt-run.startedAt)/1000});
    await writeFile(`${dir}/quality-retry-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));
  }
}
