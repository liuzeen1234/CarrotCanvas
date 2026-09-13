import { readFile, writeFile } from 'node:fs/promises';
import { cases } from './cases.mjs';
export const options = { summary: 'Stable Audio 3 Medium 三组本地音效验证，结果与参数保留在节点及 Run 历史；听感需人工确认。' };
export default async function (s) {
  const workflow = JSON.parse(await readFile('artifacts/stable-audio-3/workflow.json'));
  const graph = typeof workflow.apiJson === 'string' ? JSON.parse(workflow.apiJson) : workflow.apiJson;
  const results=[];
  for (const [i,c] of cases.entries()) {
    const outputId=`${c.id}-final`;
    const api=structuredClone(graph);
    api['52:31'].inputs.value=c.prompt; api['52:36'].inputs.value=c.seconds;
    api['52:3'].inputs.seed=c.seed; api['52:35'].inputs.value=false; api['52:43'].inputs.choice=c.category;
    api['52:43'].inputs.index=c.category==='One-shot'?3:2;
    api['57'].inputs.filename_prefix=`audio/stable_audio_3_medium/${outputId}`;
    const values=Object.fromEntries(Object.entries(api).flatMap(([id,n])=>Object.entries(n.inputs).filter(([,v])=>!Array.isArray(v)).map(([param,v])=>[`${id}::${param}`,v])));
    if(!s.canvas.graph.nodes.some(n=>n.id===c.id)) await s.operations([{type:'create_node',node:{id:c.id,type:'txt2img',position:{x:80+i*380,y:100},data:{workflowId:workflow.id,workflowName:workflow.name,cardName:c.name,note:'本地 Medium / 无损 FLAC / 自动扩写关闭。听感尚需人工验收。',formValues:values,autoRandomSeedKeys:[]},style:{width:340}}}],`添加 ${c.name}`);
    else await s.operations([{type:'update_node',nodeId:c.id,dataPatch:{formValues:values,autoRandomSeedKeys:[]}}],`应用显式时长条件 ${c.name}`);
    const status=await s.get('/local-compute-scheduler/status'); if(status.blocked)throw Error(JSON.stringify(status.blocked));
    const response=await s.write('POST','/comfyui/runs',{canvasId:s.canvasId,nodeId:c.id,workflowId:workflow.id,apiJson:api,inputAssetIds:[],idempotencyKey:`sa3-acceptance-${s.canvasId}-${outputId}`},{timeoutMs:180000,providerRun:true});
    const runId=response.persistentRun?.id || response.run?.runId;
    console.log(`Submitted ${c.id}: ${runId}`);
    const deadline=Date.now()+900000;
    let run;
    do {
      s.assertActive();
      // Existing provider status endpoint persists the real execution start timestamp.
      await s.get(`/comfyui/runs/${response.run.promptId}`);
      run=await s.get(`/runs/${runId}`);
      if(!['queued','running'].includes(run.status))break;
      if(Date.now()>deadline)throw Error(`Timeout ${runId}; inspect existing Run before retrying`);
      await new Promise(r=>setTimeout(r,2000));
    } while(true);
    await writeFile(`artifacts/stable-audio-3/${c.id}.run.json`,JSON.stringify(run,null,2));
    if(run.status!=='succeeded'||!run.outputAssetIds.length)throw Error(`${c.id}: ${JSON.stringify(run.error)}`);
    const lastAssets=run.outputAssetIds.map(assetId=>({assetId,url:`/api/assets/${assetId}`,kind:'audio'}));
    if(s.state==='active')await s.operations([{type:'update_node',nodeId:c.id,dataPatch:{lastAssets}}],`保存 ${c.name} 音频引用`);
    for(const [j,a] of lastAssets.entries()) {
      const r=await fetch(`http://localhost:3100${a.url}/download`);if(!r.ok)throw Error(`Download ${r.status}`);
      const bytes=Buffer.from(await r.arrayBuffer());if(bytes.subarray(0,4).toString()!=='fLaC')throw Error('Expected lossless FLAC');
      const filename=`artifacts/stable-audio-3/${outputId}${j?'_'+j:''}.flac`;
      const existing=await readFile(filename).catch(()=>null);
      if(existing&&!existing.equals(bytes))throw Error(`Refuse overwrite ${filename}`);
      if(!existing)await writeFile(filename,bytes,{flag:'wx'});
    }
    results.push({...c,audioFilename:`${outputId}.flac`,reprompt:false,runId,assetIds:run.outputAssetIds,startedAt:run.startedAt,finishedAt:run.finishedAt,generationSeconds:(run.finishedAt-run.startedAt)/1000});
    await writeFile('artifacts/stable-audio-3/test-results.json',JSON.stringify({canvasId:s.canvasId,results},null,2));
    console.log(`Succeeded ${c.id}: ${run.outputAssetIds.join(',')}`);
  }
  return {canvasId:s.canvasId,results};
}
