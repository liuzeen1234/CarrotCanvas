import {readdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const dir='artifacts/stable-audio-3';
const files=(await readdir(dir)).filter(f=>f.endsWith('.flac'));
const {stdout}=await promisify(execFile)('D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/standalone-env/python.exe',['scripts/stable-audio/analyze.py',...files.map(f=>`${dir}/${f}`)],{maxBuffer:4*1024*1024});
await writeFile(`${dir}/audio-analysis.json`,stdout);
const reports=JSON.parse(stdout);console.log(JSON.stringify(reports.map(({filename,duration,sample_rate,channels,peak_dbfs,rms_dbfs,clipped_samples,finite,amplitude_activity_groups})=>({filename,duration,sample_rate,channels,peak_dbfs,rms_dbfs,clipped_samples,finite,amplitude_activity_groups})),null,2));
for(const r of reports){if(!r.finite||r.rms_dbfs<-80)throw Error(`Invalid/essentially silent audio: ${r.filename}`);}
// Parameter evidence is read from actual frozen provider inputs, not just card values.
const results=JSON.parse(await readFile(`${dir}/test-results.json`));
for(const c of results.results){const run=JSON.parse(await readFile(`${dir}/${c.id}.run.json`));const p=run.inputSnapshot;
  if(p['52:3'].inputs.seed!==c.seed||p['52:36'].inputs.value!==c.seconds||p['52:31'].inputs.value!==c.prompt||p['52:35'].inputs.value!==false||p['52:43'].inputs.choice!==c.category)throw Error(`Frozen parameter mismatch ${c.id}`);
  if(!p['52:58']||p['52:58'].inputs.seconds_total[0]!=='52:36')throw Error(`Missing explicit duration conditioning ${c.id}`);
  const audio=reports.find(r=>r.filename.endsWith(c.audioFilename||`${c.id}.flac`));if(!audio||Math.abs(audio.duration-c.seconds)>.15)throw Error(`Duration mismatch ${c.id}`);
  if(audio.clipped_samples)throw Error(`Final audio clips ${c.id}`);
  if(!run.startedAt||c.generationSeconds>900)throw Error(`Invalid real execution timing ${c.id}`);
}
console.log('Frozen parameters and actual decoded durations verified. Perceptual quality remains manual.');
