import copy
import json
from pathlib import Path
import uuid
from urllib.parse import quote
import requests

ROOT = Path(__file__).resolve().parent
BASE = 'http://127.0.0.1:8188'
original = json.loads(Path('D:/downloads/MiniMaxH3+15秒卡点混剪工作流+像素幻想Lab.json').read_text(encoding='utf-8'))
(ROOT / 'original.json').write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding='utf-8')
info = requests.get(BASE + '/object_info').json()
(ROOT / 'object-info.json').write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
source = Path('D:/downloads/zimage_2k_16x9_00020_.png')
with source.open('rb') as image:
    r = requests.post(BASE + '/upload/image', files={'image': ('Pixel_Fantasy_reference.png', image, 'image/png')}, data={'overwrite': 'false'})
    r.raise_for_status()
image_name = r.json()['name']
system = '''You write MiniMax H3 reference-to-video prompts. Inspect the supplied image and expand the user's concept into ONE English production prompt, without reasoning or code fences. Use these six fields in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.
Define the sole pictured character as <Subject 1>; use only visibly supported appearance facts. Preserve their face, hair, eye color, horns or ornaments, clothing, gloves, footwear, accessories and original palette throughout. Do not invent or copy characters or change clothing. The image is an identity reference, not necessarily the opening composition. The original background may be replaced by graphic stages in the character's palette. Do not write dimensions or aspect ratio.
The summary starts [reference generation]. Plan exactly 15 seconds with 15 distinct, readable shots. Use [Shot 1] without timestamp, then [Shot N] At MM:SS.mmm at increasing one-second intervals 00:01.000 through 00:14.000. Give each shot a concise concrete composition, character action and camera or graphic response. Use cel-shaded anime fashion editorial styling, ice-blue/navy/white graphic shapes with restrained gold/red accents when supported by the image. Maintain stable anatomy and clear hands. Use action-match cuts, occlusion cuts, ink wipes and comic panels without body morphing. Increase intensity toward a heroic final pose. Use the exact title "Pixel Fantasy" only twice; no other text or logos. Do not merely describe the reference or reuse an unrelated example character.
retention_analysis explicitly says <Subject 1>: fully_preserved. The subject never speaks or sings. Use an energetic 132 BPM 4/4 instrumental electronic pop beat, melodic synth, punchy drums and bass, sparse whooshes and impacts below the music; align cuts and gestures with strong beats. No intelligible lyrics, dialogue or voiceover. Stay under 6500 English characters; finish all six fields.'''
(ROOT / 'expansion-system.txt').write_text(system, encoding='utf-8')
prompt = '''subject_definitions:
<Subject 1>: The sole anime woman in <Picture 1>, with pale blue layered hair, a curved top strand, long blue side locks, violet-pink eyes, and paired black horns with red interiors. She wears a black high-neck sleeveless bodice, a gold bell at her chest, a white and pale-blue embroidered front panel, detached white sleeves with deep-blue angular cuffs, black gloves, dark tights, gold and red ornaments, red ankle ribbons and black-and-white shoes.
summary:
[reference generation] A fifteen-second high-impact anime character fashion PV. One consistent character performs rhythmic poses across ice-blue, navy and white graphic stages, accented with her existing gold and red details. Fifteen crisp shots build from intimate recognition to a bold full-body finale. The exact title "Pixel Fantasy" appears twice.
retention_analysis:
<Subject 1> (appears throughout [Shot 1]-[Shot 15]): fully_preserved - retain her face, eyes, hair, horns, outfit, ornaments, gloves, tights and shoes in every shot.
detailed_description:
Premium cel-shaded anime illustration with clean line art, graphic shadows, comic framing and restrained halftone. Every edit is a deliberate cut or opaque graphic wipe; the character retains stable anatomy and a single outfit.
[Shot 1] Extreme close-up of her violet-pink eyes. She looks into the lens; a thin ice-blue graphic line strikes on the first downbeat.
[Shot 2] At 00:01.000, head-and-shoulders view. She turns her chin right, pale-blue locks following; a short rightward whip-pan exits with a whoosh.
[Shot 3] At 00:02.000, medium frontal view. Her right gloved hand rises beside her cheek then opens outward. A white comic panel tracks the gesture.
[Shot 4] At 00:03.000, close-up of the gold chest bell and white collar as her shoulders rotate. Gold graphic rings pulse behind the bell on the kick.
[Shot 5] At 00:04.000, three-quarter full-body view. She steps left and settles into a balanced stance, sleeves trailing naturally; camera tracks left.
[Shot 6] At 00:05.000, a low-angle medium view catches her crossed wrists opening into a confident pose. Navy panels split apart behind her.
[Shot 7] At 00:06.000, a close-up side profile shows her small smile as she glances back. Her horns and hair stay unchanged; cut on the snare.
[Shot 8] At 00:07.000, a gloved palm moves toward the lens, fully occluding it; an opaque ice-blue ink wipe finishes the motion with a low impact.
[Shot 9] At 00:08.000, the wipe reveals a wide graphic stage. She stands in a strong three-quarter pose; "Pixel Fantasy" lands behind her in large clean lettering.
[Shot 10] At 00:09.000, close view of her shoes taking one precise forward step. Red ankle bows remain visible; a white geometric line follows the footfall.
[Shot 11] At 00:10.000, medium view rises to her face while she lifts both forearms into a clear symmetrical pose. Sleeves snap on a musical accent.
[Shot 12] At 00:11.000, an overhead three-quarter view tracks a small turn, revealing the embroidered panel and long blue garment tails, with restrained radial graphics.
[Shot 13] At 00:12.000, eye-level close-up. She tilts her chin upward then meets the lens with a confident smile; the camera pushes in slightly.
[Shot 14] At 00:13.000, full-body low-angle view. She plants her feet and sweeps one arm outward, triggering crisp white and ice-blue panels that hard-cut to the final stage.
[Shot 15] At 00:14.000, stable full-body hero composition. She holds a graceful confident pose, face clearly visible. "Pixel Fantasy" returns behind her, identical spelling. Camera settles and the last frame remains readable.
overall_soundscape:
Sparse short whooshes at whip-pan and palm wipe, one low impact for the title, restrained cloth snaps. Effects remain below the music. No dialogue or voiceover; the character remains silent.
non_diegetic_music:
132 BPM, 4/4 instrumental Japanese electronic pop club track with bright melodic synth, punchy bass, crisp snare and hi-hats. Establish a clear beat immediately, add rhythmic layers across the middle shots, peak during the final poses, and resolve with a short clean final accent. Cuts and strongest gestures synchronize to downbeats or clear musical accents. No intelligible lyrics.'''
(ROOT / 'manual-prompt.txt').write_text(prompt, encoding='utf-8')

api = {}
def add(i, cls, **inputs):
    api[str(i)] = {'class_type': cls, 'inputs': inputs}

add(174, 'CLIPLoader', clip_name='qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type='minimax', device='default')
add(175, 'VAELoader', vae_name='minimax_h3_video_vae_fp16.safetensors')
add(176, 'VAELoader', vae_name='minimax_h3_audio_vae_fp32.safetensors')
add(180, 'UNETLoader', unet_name='minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype='default')
add(200, 'LoraLoaderModelOnly', model=['180',0], lora_name='minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', strength_model=1.0)
add(203, 'ModelAttentionBackend', model=['200',0], attention='comfy kitchen attention')
add(115, 'ResolutionSelector', aspect_ratio='16:9 (Widescreen)', megapixels=0.4, multiple=32)
add(135, 'PrimitiveFloat', value=15.0)
add(194, 'PrimitiveFloat', value=24.0)
add(134, 'ComfyMathExpression', expression='max(5, round(a * b)) + (5 - (max(5, round(a * b)) % 17)) % 17', **{'values.a':['135',0], 'values.b':['194',0]})
add(114, 'LoadImage', image=image_name)
add(211, 'PrimitiveStringMultiline', value=prompt)
add(212, 'MiniMaxH3ReferenceToVideo', clip=['174',0], vae=['175',0], audio_vae=['176',0], prompt=['211',0], width=['115',0], height=['115',1], length=['134',1], ref_image_size='match', **{'ref_images.ref_image_0':['114',0]})
add(183, 'BasicGuider', model=['203',0], conditioning=['212',0])
add(184, 'RandomNoise', noise_seed=2609080715)
add(198, 'KSamplerSelect', sampler_name='res_multistep')
add(199, 'BasicScheduler', model=['203',0], scheduler='simple', steps=4, denoise=1.0)
add(186, 'SamplerCustomAdvanced', noise=['184',0], guider=['183',0], sampler=['198',0], sigmas=['199',0], latent_image=['212',1])
add(124, 'VAEDecodeTiled', samples=['186',0], vae=['175',0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=8)
add(168, 'VAEDecodeAudio', samples=['186',0], vae=['176',0])
add(224, 'CreateVideo', images=['124',0], audio=['168',0], fps=['194',0], bit_depth=8)
add(167, 'SaveVideo', video=['224',0], filename_prefix='video/Pixel_Fantasy_5060Ti_15s', format='mp4', codec='h264')

positions = {n['id']: n['pos'] for n in original['nodes']}
positions[224] = [130, 4700]
positions.update({174:[0,60],175:[0,300],176:[0,540],180:[0,780],200:[0,1020],
                  114:[410,60],115:[410,550],135:[410,790],194:[410,1030],134:[410,1270],
                  209:[820,60],208:[820,420],210:[1210,60],211:[1210,740],
                  212:[1830,60],203:[1830,620],183:[1830,860],199:[2220,60],
                  198:[2220,310],184:[2220,550],186:[2220,790],
                  124:[2610,60],168:[2610,370],224:[2610,610],167:[2610,850]})
titles = {114:'参考人物图片', 115:'分辨率 · 5060 Ti 16GB', 135:'时长（秒）', 194:'帧率 · H3 固定 24', 211:'视频提示词 · 可手动修改', 124:'GPU 分块解码 · 控制显存峰值', 180:'H3 Ref2VA INT8', 174:'Qwen3-VL NVFP4 · GPU 编码', 200:'Ref2V Turbo · 4 步', 167:'保存 15 秒卡点 PV'}

def make_graph(api):
    groups=[{'id':i+1,'title':title,'bounding':box,'color':'#3f789e','font_size':24,'flags':{}} for i,(title,box) in enumerate([
        ('模型 · GPU 与量化',[-20,0,395,1250]),('参考图 / 输出尺寸 / 时长',[390,0,395,1510]),
        ('本地 Qwen 视觉扩写 / 提示词',[800,0,995,1390]),('参考条件',[1810,0,395,1120]),
        ('4 步 Turbo 采样',[2200,0,395,1060]),('GPU 解码 / 音视频输出',[2590,0,580,1470])])]
    graph = {'id':str(uuid.uuid4()),'version':0.4,'revision':0,'nodes':[], 'links':[], 'groups':groups, 'config':{}, 'extra':{'ds':{'scale':0.38,'offset':[40,60]}}, 'last_node_id':230, 'last_link_id':0}
    byid = {}
    scalar_types = {'INT','FLOAT','STRING','BOOLEAN','COMBO','COMFY_DYNAMICCOMBO_V3'}
    for order, (key, node) in enumerate(api.items()):
        cls = node['class_type']
        schema = info[cls]
        g = {'id':int(key),'type':cls,'pos':positions.get(int(key),[0,0]),'size':[345,200], 'flags':{},'order':order,'mode':0,'inputs':[],'outputs':[], 'properties':{'Node name for S&R':cls},'widgets_values':[], 'title':titles.get(int(key),schema.get('display_name') or cls)}
        for k, spec in list(schema['input'].get('required',{}).items()) + list(schema['input'].get('optional',{}).items()):
            typ = spec[0]
            opts = spec[1] if len(spec)>1 and isinstance(spec[1],dict) else {}
            if typ == 'COMFY_AUTOGROW_V3':
                for actual, val in node['inputs'].items():
                    if actual.startswith(k+'.'):
                        subtype = 'IMAGE' if k=='ref_images' else 'FLOAT,INT,BOOLEAN'
                        g['inputs'].append({'name':actual,'type':subtype,'link':None})
                continue
            is_widget = (isinstance(typ,list) or typ in scalar_types) and not opts.get('forceInput',opts.get('force_input',False))
            val = node['inputs'].get(k)
            connected = isinstance(val,list) and len(val)==2 and str(val[0]) in api
            if connected or not is_widget:
                if k in node['inputs'] or k in schema['input'].get('required',{}):
                    port = {'name':k,'type':'COMBO' if isinstance(typ,list) else typ,'link':None}
                    if is_widget:
                        port['widget']={'name':k}
                    g['inputs'].append(port)
            if is_widget:
                default = opts.get('default', typ[0] if isinstance(typ,list) and typ else opts.get('options',[0])[0])
                g['widgets_values'].append(default if connected or val is None else val)
                if opts.get('control_after_generate') or (cls=='RandomNoise' and k=='noise_seed') or (cls=='XB_llamaInstruct' and k=='seed'):
                    g['widgets_values'].append('fixed')
        if cls=='LoadImage':
            g['widgets_values'].append('image')
            g['size']=[360,430]
        if cls in ('PrimitiveStringMultiline','XB_llamaInstruct'):
            g['size']=[550,600]
        if cls=='XB_llamaModelLoader':
            g['size']=[345,300]
        if cls=='XB_llamaParameters':
            g['size']=[345,460]
        if cls=='MiniMaxH3ReferenceToVideo':
            g['size']=[345,500]
        if cls=='SaveVideo':
            g['size']=[530,540]
        if cls=='ShowText|pysssss':
            g['widgets_values']=['']
            g['size']=[550,500]
        for slot, typ in enumerate(schema['output']):
            g['outputs'].append({'name':schema['output_name'][slot],'type':typ,'links':[],'slot_index':slot})
        graph['nodes'].append(g)
        byid[key]=g
    for key,node in api.items():
        for port_slot,port in enumerate(byid[key]['inputs']):
            val=node['inputs'].get(port['name'])
            if not (isinstance(val,list) and len(val)==2 and str(val[0]) in api):
                continue
            graph['last_link_id']+=1
            lid=graph['last_link_id']
            src,slot=val
            source_port=byid[src]['outputs'][slot]
            graph['links'].append([lid,int(src),slot,int(key),port_slot,source_port['type']])
            port['link']=lid
            source_port['links'].append(lid)
    return graph

def save(name, api):
    graph=make_graph(api)
    (ROOT/(name+'-api.json')).write_text(json.dumps(api,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/(name+'.json')).write_text(json.dumps(graph,ensure_ascii=False,indent=2),encoding='utf-8')
    r=requests.post(BASE+'/userdata/'+quote('workflows/'+name+'.json',safe='')+'?overwrite=true',json=graph)
    r.raise_for_status()
    print(r.text)

save('Pixel_Fantasy_5060Ti_15s_Manual', api)
if 'Qwen3.5' in info['XB_llamaModelLoader']['input']['required']['chat_handler'][0]:
    original_sys=next(n for n in original['nodes'] if n['id']==210)['widgets_values'][2]
    (ROOT/'original-expansion-system.txt').write_text(original_sys,encoding='utf-8')
    add(209,'XB_llamaModelLoader',model='Qwen3.5-9B-Q4_K_M.gguf',mmproj='Qwen3.5-9B-mmproj-F16.gguf',chat_handler='Qwen3.5',n_ctx=8192,vram_limit=-1,image_min_tokens=0,image_max_tokens=1024)
    add(208,'XB_llamaParameters',max_tokens=3072,top_k=30,top_p=0.9,min_p=0.05,typical_p=1.0,temperature=0.6,repeat_penalty=1.05,frequency_penalty=0.0,present_penalty=0.0,mirostat_mode=0,mirostat_eta=0.1,mirostat_tau=5.0,state_uid=-1)
    user_prompt='制作15秒高冲击人物PV卡点混剪，15个分镜。保持参考图中的人物、脸、发型、服装、配饰和配色。标题为“Pixel Fantasy”。\n\nFill the following production template. COPY EVERY FIELD NAME AND TIMESTAMP EXACTLY. Replace each parenthesized instruction with a concise English description. Do not remove timestamps. Use only deliberate edits, never body morphing. Do not invent glove clasps or extra garments.\nsubject_definitions: (describe the visible reference character accurately)\nsummary: [reference generation] (15-second anime character PV)\nretention_analysis: <Subject 1>: fully_preserved.\ndetailed_description:\n[Shot 1] (eye close-up; one action)\n' + '\n'.join(f'[Shot {i}] At 00:{i-1:02d}.000, (one clear composition and gesture; '+('the exact title "Pixel Fantasy" appears behind the character' if i in (9,15) else 'action-matched hard cut or graphic wipe')+')' for i in range(2,16)) + '\noverall_soundscape: (sparse whooshes, impacts below music; no speech)\nnon_diegetic_music: (132 BPM 4/4 instrumental electronic pop; musical rise and final resolution, no intelligible lyrics)'
    add(210,'XB_llamaInstruct',llama_model=['209',0],parameters=['208',0],images=['114',0],preset_prompt='Empty - Nothing',custom_prompt=user_prompt,system_prompt=system,inference_mode='images',max_frames=2,max_size=768,seed=2609080715,force_offload=True,save_states=False)
    add(211,'ShowText|pysssss',text=['210',0])
    save('Pixel_Fantasy_5060Ti_15s_Auto',api)
