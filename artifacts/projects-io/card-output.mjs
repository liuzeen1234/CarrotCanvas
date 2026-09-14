import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const f=JSON.parse(await readFile(new URL('fixture.json',import.meta.url)));const id=f.target;const base='http://localhost:3100/api';
const api=async(path,method='GET',data)=>{const r=await fetch(base+path,{method,...(data?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});assert(r.ok,`${path}: ${r.status}`);return r.json()};
if(process.argv[2]==='setup'){
 const d=await api(`/canvas/${id}`);const lease=await api(`/canvas/${id}/control/acquire`,'POST',{holderType:'agent',holderId:'card-output-fixture'});const item=d.io.inputs[0].snapshots[0].items.find(i=>i.kind==='image');
 try{await api(`/canvas/${id}/operations`,'POST',{leaseToken:lease.leaseToken,leaseEpoch:lease.epoch,expectedRevision:d.revision,idempotencyKey:randomUUID(),actorType:'agent',actorId:lease.holderId,operations:[{type:'create_node',node:{id:'card-text',type:'codex-capability',position:{x:0,y:0},data:{cardName:'卡片文字验收',capability:'text',prompt:'不实际生成',model:'codex',lastText:'直接发布这份卡片文字'}}},{type:'create_node',node:{id:'card-image',type:'codex-capability',position:{x:400,y:0},data:{cardName:'卡片图片验收',capability:'image',prompt:'不实际生成',model:'codex',lastAssets:[{assetId:item.assetId,kind:'image',url:`/api/assets/${item.assetId}`}]}}}]});}finally{await api(`/canvas/${id}/control/release`,'POST',{leaseToken:lease.leaseToken,leaseEpoch:lease.epoch})}
 console.log(id);
}else{const d=await api(`/canvas/${id}`);assert(d.io.outputs.at(-1).items.some(i=>i.text==='直接发布这份卡片文字'&&i.sourceNodeId==='card-text'));console.log('Direct card publish saved exact text with node provenance.');}
