import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const base='http://localhost:3100/api';
const fixture=JSON.parse(await readFile(new URL('fixture.json',import.meta.url)));
const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(!r.ok&&r.status!==404)throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);return r.status===204||r.status===404?null:r.json()};
for(const id of fixture.canvases){const doc=await api(`/canvas/${id}`);if(!doc)continue;if(!doc.name.startsWith('验收 · '))throw new Error('Refusing non-fixture canvas');const lease=await api(`/canvas/${id}/control/acquire`,'POST',{holderType:'agent',holderId:`fixture-cleanup-${id}`});await api(`/canvas/${id}`,'DELETE',{leaseToken:lease.leaseToken,leaseEpoch:lease.epoch,expectedRevision:doc.revision,actorType:'agent',actorId:lease.holderId,idempotencyKey:randomUUID()});}
for(const id of fixture.projects){const p=await api(`/projects/${id}`);if(!p)continue;if(!p.name.startsWith('验收 · ')||p.canvases.length)throw new Error('Refusing nonempty/non-fixture project');await api(`/projects/${id}`,'DELETE',{expectedRevision:p.revision});}
await writeFile(new URL(`cleanup-${Date.now()}.json`,import.meta.url),JSON.stringify({fixture,cleanedAt:new Date().toISOString()},null,2));
console.log('Cleaned isolated acceptance canvases and projects.');
