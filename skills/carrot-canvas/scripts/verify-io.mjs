// Zero-provider acceptance: only mutates and removes fixtures created by this invocation.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasClient } from './canvas.mjs';

const client = new CanvasClient(); const ids = []; let project;
const folder = await mkdtemp(join(tmpdir(), 'carrot-skill-io-'));
try {
  const actions = (await client.get('/actions')).actions;
  assert(actions.find(a => a.name === 'canvas.input.remove').errors.every(e => e.code !== 'INPUT_ITEM_IN_USE'));
  for (const name of ['source','target']) ids.push((await client.request('POST','/canvas',{name:`Skill IO acceptance ${name} ${Date.now()}`})).id);
  project = await client.request('POST','/projects',{name:`Skill IO acceptance ${Date.now()}`});
  const projectCommand = async (command,payload) => {
    const current = await client.get(`/projects/${project.id}`);
    return client.request('POST',`/projects/${project.id}/command`,{expectedRevision:current.revision,idempotencyKey:crypto.randomUUID(),command,payload});
  };
  await projectCommand('canvas.add',{canvasId:ids[0]});
  await client.withCanvas(ids[0], async source => {
    await source.operations([{type:'create_node',node:{id:'writer',type:'codex-capability',position:{x:0,y:0},data:{capability:'text',model:'codex',prompt:'fixture',cardName:'交付文案',lastText:'v1'}}}],'IO fixture');
    await source.io('output.publish',{nodeId:'writer',name:'交付文案'});
    const first = source.canvas.io.outputs.at(-1).items[0];
    await client.withCanvas(ids[1], async target => {
      await target.io('input.capture',{sourceCanvasId:ids[0],sourceOutputsVersion:source.canvas.io.outputs.at(-1).version});
      const group = target.canvas.io.inputs[0];
      await target.io('input.bind',{groupId:group.id,itemKey:first.itemKey,position:{x:80,y:80}});
      const bound = target.canvas.graph.nodes[0]; assert.notEqual(bound.data.inputLocalAssetId, first.assetId);
      await source.operations([{type:'update_node',nodeId:'writer',dataPatch:{lastText:'v2'}}]);
      await source.io('output.publish',{nodeId:'writer',name:'交付文案'});
      assert.equal(source.canvas.io.outputs.at(-1).items.length,1); assert.equal(source.canvas.io.outputs.at(-1).items[0].itemKey,first.itemKey);
      const preview = await target.get(`${target.path}/io/inputs/${group.id}/update-preview`);
      await target.io('input.update',{groupId:group.id,sourceOutputsVersion:preview.sourceOutputsVersion});
      assert.equal(target.canvas.graph.nodes[0].data.lastText,'v2');
      await target.io('input.remove',{groupId:group.id});
      const view = await target.get(`${target.path}/agent-view`);
      assert.equal(view.ioSummary.inputGroups.length,0); assert.equal(view.ioSummary.retainedWorkingInputs[0].reason,'group_removed');
      assert.equal(target.canvas.graph.nodes[0].data.lastText,'v2');
      const filename = join(folder,'输入.txt'); await writeFile(filename,'本地输入');
      await target.importInputs([filename]); assert.equal(target.canvas.io.inputs[0].snapshots[0].items[0].text,'本地输入');
    });
    const output = source.canvas.io.outputs.at(-1);
    await projectCommand('results.capture',{selections:[{canvasId:ids[0],itemKey:first.itemKey,outputsVersion:output.version}]});
    const result = (await client.get(`/projects/${project.id}`)).results.at(-1).items[0];
    assert.notEqual(result.assetId,output.items[0].assetId);
  });
  console.log(JSON.stringify({passed:['stable card output identity','cross-canvas local copy','explicit update','remove keeps working snapshot','agent-view summary','local file import','project independent results'],generationRuns:0}));
} finally {
  for (const id of ids.reverse()) await client.withCanvas(id,s=>s.write('DELETE',s.path));
  if (project) { const current = await client.get(`/projects/${project.id}`); await client.request('DELETE',`/projects/${project.id}`,{expectedRevision:current.revision}); }
  if (!folder.startsWith(join(tmpdir(),'carrot-skill-io-'))) throw Error('Unexpected fixture folder');
  await rm(folder,{recursive:true,force:true});
}
