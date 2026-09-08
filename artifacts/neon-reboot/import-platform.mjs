import fs from 'node:fs';
const base = 'http://localhost:3100';
async function api(path, body) {
  const r = await fetch(base + path, body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {});
  const j = await r.json();
  if (!r.ok) throw Error(JSON.stringify(j));
  return j;
}
const name = 'MiniMax H3 双图参考生视频 · 重启天际';
const fields = [
  {nodeId:'137',param:'image',label:'参考图片 1（角色）',description:'上传图片或连接画布图片节点。提示词使用 <Picture 1> 引用。'},
  {nodeId:'139',param:'image',label:'参考图片 2（场景）',description:'上传图片或连接画布图片节点。提示词使用 <Picture 2> 引用。'},
  {nodeId:'138',param:'value',label:'视频提示词',description:'描述两张参考图的用途、镜头运动、动作顺序和声音；支持连接文本节点。'},
  {nodeId:'132',param:'value',label:'视频时长（秒）',description:'默认 6 秒；模型按帧数规则对齐，实测输出约 6.58 秒。'},
  {nodeId:'115',param:'megapixels',label:'画面像素量（百万）',description:'默认 0.98，当前 16:9 比例输出 1344×768。'},
  {nodeId:'129',param:'noise_seed',label:'随机种子',description:'默认 2609071842，为《重启天际》实测种子。'},
  {nodeId:'146',param:'value',label:'启用 Turbo',description:'默认启用 4 步 Turbo；关闭后使用 20 步分支。'},
];
const list = await api('/api/workflows');
const rows = Array.isArray(list) ? list : (list.items || list.workflows || list.data);
if (!Array.isArray(rows)) throw Error('Unknown workflow list');
let workflow = rows.find(w => w.id === '35c2f155-78f6-4762-9ce1-93b90c78856e' || w.name === name);
if (!workflow) {
  const result = await api('/api/comfyui/workflows/import', {
    filename:'Sky_Reboot_R2V.json', name, category:'img2vid',
    description:'MiniMax H3 本地双图参考生视频。角色图 + 场景图 + 提示词串联镜头，附《重启天际》未来城市实测素材与提示词。1344×768、24fps、约 6.58 秒，4 步 Turbo，原生音效。当前工作流提供两路图片参考，不包含视频或音频参考输入。',
    tags:['MiniMax H3','双图参考','R2V','Turbo','未来感'],
    exposure:{version:1,fields:fields.map(({nodeId,param}) => ({nodeId,param}))},
    inputConfig:{version:1,fields:[{nodeId:'137',param:'image',kind:'image'},{nodeId:'139',param:'image',kind:'image'},{nodeId:'138',param:'value',kind:'text'}]},
    fieldConfig:{version:1,fields,groups:fields.map(f=>({nodeId:f.nodeId,label:f.label}))},
  });
  workflow = result.workflow;
  fs.writeFileSync(new URL('./platform-import.json',import.meta.url),JSON.stringify(result,null,2));
}
const stored = await api('/api/workflows/'+workflow.id);
const schema = await api('/api/comfyui/workflows/'+workflow.id+'/schema');
fs.writeFileSync(new URL('./platform-workflow.json',import.meta.url),JSON.stringify(stored,null,2));
fs.writeFileSync(new URL('./platform-schema.json',import.meta.url),JSON.stringify(schema,null,2));
console.log(JSON.stringify({id:workflow.id,name:workflow.name,storedKeys:Object.keys(stored),category:stored.category,inputConfig:stored.inputConfig},null,2));
