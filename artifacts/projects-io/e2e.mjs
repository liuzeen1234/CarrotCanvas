import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const base = 'http://localhost:3100/api';
const projectId = process.argv[2];
const api = async (path, method = 'GET', data) => {
  const response = await fetch(base + path, { method, ...(data instanceof FormData ? { body: data } : data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }) });
  const text = await response.text(); const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${body?.message}`), { status: response.status, body }); return body;
};
const fixture = { canvases: [], projects: [projectId], checks: [] };
const check = (name, test) => { test(); fixture.checks.push(name); };
const leases = new Map();
const proof = async id => { const doc = await api(`/canvas/${id}`); const lease = leases.get(id); return { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: doc.revision, idempotencyKey: randomUUID(), actorType: 'agent', actorId: lease.holderId }; };
const create = async name => { const doc = await api('/canvas','POST',{ name }); fixture.canvases.push(doc.id); const lease = await api(`/canvas/${doc.id}/control/acquire`,'POST',{holderType:'agent',holderId:`io-e2e-${doc.id}`}); leases.set(doc.id,lease); return doc.id; };
const io = async (id,command,payload) => api(`/canvas/${id}/io/command`,'POST',{...await proof(id),command,payload});
const project = async (id,command,payload) => api(`/projects/${id}/command`,'POST',{expectedRevision:(await api(`/projects/${id}`)).revision,idempotencyKey:randomUUID(),command,payload});
try {
  check('health', () => {}); assert.equal((await api('/health')).status,'ok');
  const source = await create('验收 · 人物素材'); const target = await create('验收 · 镜头工作'); fixture.source = source; fixture.target = target;
  const other = await api('/projects','POST',{name:'验收 · 另一个项目'}); fixture.projects.push(other.id);
  await project(projectId,'canvas.add',{canvasId:source}); await project(other.id,'canvas.add',{canvasId:source}); await project(projectId,'canvas.add',{canvasId:target});
  check('multi-project/no-canvas-revision', () => {}); assert.equal((await api(`/canvas/${source}`)).revision,0); assert.equal((await api('/canvas')).find(c=>c.id===source).projects.length,2);
  const text = Buffer.from('人物设定：许明，深蓝外套。\n此文件作为独立输入副本。');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=','base64');
  const wav = Buffer.alloc(44+16000); wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const files = [{name:'人物说明.md',type:'text/plain',bytes:text},{name:'参考图片.png',type:'image/png',bytes:png},{name:'静音测试.wav',type:'audio/wav',bytes:wav}];
  // Read-only local fixture; copied only into isolated acceptance canvases.
  if (process.env.VIDEO_FIXTURE_ASSET_ID) files.push({name:'测试视频.mp4',type:'video/mp4',bytes:Buffer.from(await (await fetch(`${base}/assets/${process.env.VIDEO_FIXTURE_ASSET_ID}/download`)).arrayBuffer())});
  const form = new FormData(); for(const file of files) form.append('files',new File([file.bytes],file.name,{type:file.type})); for(const [key,value] of Object.entries(await proof(source))) form.append(key,String(value));
  const imported = await api(`/canvas/${source}/io/files`,'POST',form); const group = imported.canvas.io.inputs[0];
  for(const [index,item] of group.snapshots[0].items.entries()) { assert.equal(item.name,files[index].name); const bytes = Buffer.from(await (await fetch(`${base}/assets/${item.assetId}/download`)).arrayBuffer()); assert.deepEqual(bytes,files[index].bytes); await io(source,'output.publish',{assetId:item.assetId,name:item.name,note:'快照来源验收'}); }
  fixture.checks.push(`multipart-${files.length}-kinds/byte-equality/output-publish`);
  await io(target,'input.capture',{sourceCanvasId:source}); let state = await api(`/canvas/${target}/io`); const captured = state.inputs[0]; const initial = captured.snapshots[0]; fixture.groupId = captured.id;
  assert.notEqual(initial.items[0].assetId,group.snapshots[0].items[0].assetId); await io(target,'input.bind',{groupId:captured.id,itemKey:initial.items[0].itemKey,position:{x:180,y:180}});
  let output = (await api(`/canvas/${source}/io`)).outputs.at(-1); await io(source,'output.replace',{itemKey:output.items[0].itemKey,text:'人物设定第二版：灰色外套。',name:'人物说明.md'});
  assert.equal((await api(`/canvas/${target}`)).graph.nodes[0].data.lastText,initial.items[0].text);
  const preview = await api(`/canvas/${target}/io/inputs/${captured.id}/update-preview`); assert.equal(preview.hasUpdate,true); await io(target,'input.update',{groupId:captured.id,sourceOutputsVersion:preview.sourceOutputsVersion});
  assert.equal((await api(`/canvas/${target}`)).graph.nodes[0].data.lastText,'人物设定第二版：灰色外套。'); await io(target,'input.restore',{groupId:captured.id,snapshotId:initial.id});
  fixture.checks.push('explicit-update/stable-binding/history-rollback');
  // Publish target result independently, so the UI can also inspect an output panel.
  await io(target,'output.publish',{assetId:initial.items[1].assetId,name:'镜头最终参考图'});
  output = (await api(`/canvas/${source}/io`)).outputs.at(-1); await project(projectId,'results.capture',{name:'验收第一版成果',note:'独立成果快照，不供引用',selections:output.items.slice(0,2).map(item=>({canvasId:source,itemKey:item.itemKey,outputsVersion:output.version}))});
  const savedProject = await api(`/projects/${projectId}`); fixture.projectResultIds = savedProject.results[0].items.map(i=>i.assetId); assert.notEqual(fixture.projectResultIds[0],output.items[0].assetId);
  fixture.checks.push('project-results-copy');
  const registry = await api('/actions'); assert(registry.actions.some(a=>a.name==='canvas.input.capture')); assert(registry.actions.some(a=>a.name==='project.results.capture'));
  fixture.checks.push('action-registry');
  await writeFile(new URL('fixture.json',import.meta.url),JSON.stringify(fixture,null,2));
  console.log(JSON.stringify(fixture,null,2));
} finally {
  for(const [id,lease] of leases) await api(`/canvas/${id}/control/release`,'POST',{leaseToken:lease.leaseToken,leaseEpoch:lease.epoch}).catch(()=>{});
  await writeFile(new URL('fixture.json',import.meta.url),JSON.stringify(fixture,null,2));
}
