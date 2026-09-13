import {readFile,writeFile} from 'node:fs/promises';
const dir='artifacts/stable-audio-3',base='http://localhost:3100/api';
const {canvasId}=JSON.parse(await readFile(`${dir}/test-results.json`));
const history=await(await fetch(`${base}/runs?canvasId=${canvasId}&limit=50`)).json();
const run=history.items.find(r=>r.inputSnapshot?.['52:3']?.inputs.seed===12092029);
if(!run||run.status!=='succeeded'||!run.outputAssetIds.length||!run.inputSnapshot['52:58']||run.inputSnapshot['60']?.inputs.volume!==-3)throw Error('No successful real UI Run of final adapted workflow');
await writeFile(`${dir}/canvas-ui-run.json`,JSON.stringify(run,null,2));
for(const [i,id]of run.outputAssetIds.entries()){
  const r=await fetch(`${base}/assets/${id}/download`);if(!r.ok)throw Error(`HTTP ${r.status}`);
  const bytes=Buffer.from(await r.arrayBuffer());if(bytes.subarray(0,4).toString()!=='fLaC')throw Error('Expected FLAC');
  const filename=`${dir}/canvas-ui-drawer-final${i?'_'+i:''}.flac`;
  const old=await readFile(filename).catch(()=>null);if(old&&!old.equals(bytes))throw Error('Refuse overwrite');
  if(!old)await writeFile(filename,bytes,{flag:'wx'});
}
await writeFile(`${dir}/canvas-history.json`,JSON.stringify(history,null,2));
const canvas=await(await fetch(`${base}/canvas/${canvasId}`)).json();
await writeFile(`${dir}/canvas-final.json`,JSON.stringify(canvas,null,2));
console.log(JSON.stringify({canvasId,runId:run.id,nodeId:run.nodeId,assetIds:run.outputAssetIds,elapsedSeconds:(run.finishedAt-run.startedAt)/1000,historyRuns:history.items.length,graphNodes:canvas.graph.nodes.length,graphEdges:canvas.graph.edges.length}));
