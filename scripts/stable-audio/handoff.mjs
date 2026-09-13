export const options={summary:'音效工程与技术验收通过，原始及最终候选保留；请人工试听三组及 UI 抽屉候选，确认无音乐/人声、动作次数与自然尾音。'};
export default async function(s){
  return{canvasId:s.canvasId,revision:s.revision,nodes:s.canvas.graph.nodes.length,edges:s.canvas.graph.edges.length,perceptualAcceptance:'human listening required'};
}
