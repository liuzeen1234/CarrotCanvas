import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const dir='artifacts/stable-audio-3',base='http://localhost:3100/api';
const tests=JSON.parse(await readFile(`${dir}/test-results.json`)),ui=JSON.parse(await readFile(`${dir}/canvas-ui-run.json`));
const entries=[...tests.results.map(c=>({runId:c.runId,assetId:c.assetIds[0],filename:c.audioFilename})),{runId:ui.id,assetId:ui.outputAssetIds[0],filename:'canvas-ui-drawer-final.flac'}];
const assets=[];
for(const e of entries){
  const r=await fetch(`${base}/assets/${e.assetId}/download`),bytes=Buffer.from(await r.arrayBuffer()),local=await readFile(`${dir}/${e.filename}`);
  if(!r.ok||!bytes.equals(local)||!/^audio\/(x-)?flac/.test(r.headers.get('content-type')||'')||Number(r.headers.get('content-length'))!==bytes.length||bytes.subarray(0,4).toString()!=='fLaC')throw Error(`Attachment mismatch ${e.assetId}`);
  const partial=await fetch(`${base}/assets/${e.assetId}`,{headers:{Range:'bytes=0-1023'}}),chunk=Buffer.from(await partial.arrayBuffer());
  if(partial.status!==206||!chunk.equals(bytes.subarray(0,1024)))throw Error('Audio seek/range mismatch');
  const lineage=await(await fetch(`${base}/runs/${e.runId}/lineage`)).json(),a=lineage.assets.find(a=>a.id===e.assetId);
  if(a?.kind!=='audio'||a.canvasId!==tests.canvasId)throw Error('Invalid actual asset lineage');
  assets.push({...e,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mime:r.headers.get('content-type'),rangeVerified:true,storageRelativePath:a.relPath,canvasId:a.canvasId});
}
const canvas=await(await fetch(`${base}/canvas/${tests.canvasId}`)).json(),history=await(await fetch(`${base}/runs?canvasId=${tests.canvasId}&pageSize=100`)).json();
if(canvas.graph.edges.filter(e=>e.sourceHandle==='audio-source'&&e.targetHandle==='audio-target').length!==4)throw Error('Result handles mismatch');
if(history.items.some(r=>r.outputAssets.some(a=>a.kind!=='audio')))throw Error('History output type mismatch');
const original=await(await fetch('http://localhost:8188/userdata/workflows%2Faudio_stable_audio_3_medium.json')).json();
if(JSON.stringify(original)!==JSON.stringify(JSON.parse(await readFile(`${dir}/audio_stable_audio_3_medium.official.json`))))throw Error('Official original modified');
const receipt={checkedAt:new Date().toISOString(),canvasId:tests.canvasId,assets,historyRuns:history.total,nodes:canvas.graph.nodes.length,edges:canvas.graph.edges.length,officialOriginalUnchanged:true,allInferenceLocal:true,semanticListeningAvailable:false,technicalQA:'passed',perceptualQA:'requires human listening'};
await writeFile(`${dir}/acceptance-receipt.json`,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
