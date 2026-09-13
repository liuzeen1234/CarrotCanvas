// Resume the contiguous .part without re-downloading it; range workers write only missing bytes.
import { readFile, writeFile, stat, mkdir, open, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
async function json(url) {const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);return r.json();}
const repo = process.argv[2] || 'stable-audio-3';
const names = repo === 'Qwen3.5' ? ['text_encoders/qwen3.5_2b_bf16.safetensors'] : ['checkpoints/stable_audio_3_medium.safetensors','text_encoders/t5gemma_b_b_ul2.safetensors'];
const ms=await json(`https://modelscope.cn/api/v1/models/Comfy-Org/${repo}/repo/files?Recursive=true`);
const hf=await json(`https://hf-mirror.com/api/models/Comfy-Org/${repo}/tree/main?recursive=true`);
const manifest=[];
for(const name of names) {
  const m=ms.Data.Files.find(f=>f.Path===name), h=hf.find(f=>f.path===name);
  if(!m||!h||m.Size!==h.size||m.Sha256!==h.lfs.oid)throw Error(`Mirror mismatch ${name}`);
  const target=path.join('D:/Comfy-Desktop/ComfyUI-Shared/models',name),temp=`${target}.part`;
  await mkdir(path.dirname(target),{recursive:true});
  if(!await stat(target).catch(()=>null)) {
    let state=JSON.parse(await readFile(`${temp}.ranges.json`,'utf8').catch(()=>'null'));
    if(!state) {const start=(await stat(temp).catch(()=>({size:0}))).size;const chunk=Math.ceil((m.Size-start)/8);state={size:m.Size,sha256:m.Sha256,ranges:Array.from({length:8},(_,i)=>({start:start+i*chunk,end:Math.min(m.Size-1,start+(i+1)*chunk-1)})).filter(r=>r.start<=r.end)}; await writeFile(`${temp}.ranges.json`,JSON.stringify(state));}
    if(state.size!==m.Size||state.sha256!==m.Sha256)throw Error('Range manifest mismatch');
    const fd=await open(temp,'a').then(async f=>{await f.close();return open(temp,'r+');});
    let downloaded=0,last=0;
    await Promise.all(state.ranges.map(async range=> {
      if(range.done)return;
      for(let attempt=0;attempt<4;attempt++) {
        try {
          const r=await fetch(`https://modelscope.cn/models/Comfy-Org/${repo}/resolve/master/${name}`,{headers:{Range:`bytes=${range.start}-${range.end}`}});
          if(r.status!==206||!r.headers.get('content-range')?.startsWith(`bytes ${range.start}-`))throw Error(`Range refused: ${r.status}`);
          let pos=range.start;
          for await(const chunk of r.body){await fd.write(chunk,0,chunk.length,pos);pos+=chunk.length;downloaded+=chunk.length;if(Date.now()-last>15000){console.log(`${name}: +${(downloaded/1e6).toFixed(0)}MB`);last=Date.now();}}
          if(pos!==range.end+1)throw Error('Incomplete range');range.done=true;await writeFile(`${temp}.ranges.json`,JSON.stringify(state));break;
        }catch(e){if(attempt===3)throw e;console.log(`Retry ${name}: ${e.message}`);}
      }
    }));await fd.close();
    const hash=createHash('sha256');for await(const c of createReadStream(temp))hash.update(c);
    if((await stat(temp)).size!==m.Size||hash.digest('hex')!==m.Sha256)throw Error(`Integrity failure ${name}`);
    await rename(temp,target);
  }
  const hash=createHash('sha256');for await(const c of createReadStream(target))hash.update(c);
  if(hash.digest('hex')!==m.Sha256)throw Error(`Existing hash mismatch ${name}`);
  manifest.push({name,target,size:m.Size,sha256:m.Sha256,source:'ModelScope',officialMirrorMatched:true});console.log(`Verified ${name}`);
}
await writeFile(`artifacts/stable-audio-3/${repo}-manifest.json`,JSON.stringify(manifest,null,2));
