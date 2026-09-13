export const options={summary:'三组测试及界面补测均有音频结果卡，原始候选和 Run 保留；请人工试听确认语义质量。'};
export default async function(s){
  const ids=['office-hvac','paper-turn','drawer-close','canvas-txt2img-mtyi555i-0'],ops=[];
  for(const [i,id]of ids.entries()){
    const n=s.canvas.graph.nodes.find(n=>n.id===id);if(!n)throw Error(`Missing ${id}`);
    const target=`preview-${id}`;
    if(!s.canvas.graph.nodes.some(n=>n.id===target))ops.push({type:'create_node',node:{id:target,type:'result',position:{x:80+i*380,y:100},data:{kind:'audio',cardName:`${n.data.cardName} · 音频`,note:'无损 FLAC。技术检查通过；听感、额外声音及动作次数需人工验收。'},style:{width:340}}});
    if(!s.canvas.graph.edges.some(e=>e.id===`${id}-audio-preview`))ops.push({type:'connect',edge:{id:`${id}-audio-preview`,source:id,target,sourceHandle:'audio-source',targetHandle:'audio-target'}});
  }
  ops.push({type:'move_nodes',positions:ids.map((nodeId,i)=>({nodeId,position:{x:80+i*380,y:500}}))});
  await s.operations(ops,'整理音效验收结果卡与真实音频连线');
  return{canvasId:s.canvasId,nodes:s.canvas.graph.nodes.length,edges:s.canvas.graph.edges.length,revision:s.revision};
}
