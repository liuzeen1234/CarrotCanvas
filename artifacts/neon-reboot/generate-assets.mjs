import fs from 'node:fs/promises';
const dir = new URL('./', import.meta.url);
async function post(path, body) {
  const r = await fetch('http://localhost:3010'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json(); if(!r.ok) throw Error(JSON.stringify(data)); return data;
}
const brief = `Create a polished futuristic sci-fi video concept called Sky Reboot / 重启天际. A lone adult female courier in sleek pearl-white and dark graphite armor, short black bob haircut, holds a luminous cyan energy sphere on a high platform above a futuristic city at blue hour. She opens her hand, sphere rises and unfolds a thin luminous geometric halo, a cyan wave lights up the city. Cool, spectacular but visually readable and sharp. ONE continuous 6-second shot, smooth modest dolly backward, no cuts, no dialogue, native electronic sound effects. Need TWO separate coherent reference images, not collages: Picture 1 hero waist-up holding core; Picture 2 same world empty platform and sweeping futuristic skyline, dormant city with cyan/amber accent lights. Strong face/armor detail, restrained glow, no fog or blur, no text/watermarks. Return ONLY valid JSON with title_zh, synopsis_zh, image1_prompt (English detailed), image2_prompt (English detailed), video_prompt (English 140-220 words). video_prompt MUST use exact tags <Picture 1> for character and core, <Picture 2> for environment; clear simple timed action progression; NO reference to absent audio/video inputs. Request detailed surfaces, sharp architectural edges and stable anatomy, no overcomplicated choreography. This is prompt writing only; do not generate images in this text request.`;
console.log('Generating story and prompts with codex2api');
const reply=await post('/v1/chat/completions',{model:'codex',messages:[{role:'user',content:brief}]});
await fs.writeFile(new URL('text-response.json',dir),JSON.stringify(reply,null,2));
const content=reply.choices[0].message.content;
const plan=JSON.parse(content.slice(content.indexOf('{'),content.lastIndexOf('}')+1));
await fs.writeFile(new URL('story-prompts.json',dir),JSON.stringify(plan,null,2));
console.log(JSON.stringify(plan));
for (let i=1;i<=2;i++) {
 console.log('Generating reference '+i);
 const result=await post('/v1/images/generations',{prompt:plan['image'+i+'_prompt'],size:'1536x1024',n:1,response_format:'b64_json'});
 await fs.writeFile(new URL('reference-'+i+'.png',dir),Buffer.from(result.data[0].b64_json,'base64'));
 await fs.writeFile(new URL('reference-'+i+'-metadata.json',dir),JSON.stringify({created:result.created,revised_prompt:result.data[0].revised_prompt},null,2));
 console.log('Saved reference-'+i+'.png');
}
console.log('ASSETS_COMPLETE');
