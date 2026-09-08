import json
from pathlib import Path
import subprocess
import sys
import time
import uuid
import requests
import asyncio
import aiohttp

ROOT=Path(__file__).resolve().parent
name=sys.argv[1] if len(sys.argv)>1 else 'Pixel_Fantasy_5060Ti_15s_Manual'
base='http://127.0.0.1:8188'
client=str(uuid.uuid4())
api=json.loads((ROOT/(name+'-api.json')).read_text(encoding='utf-8'))
graph=json.loads((ROOT/(name+'.json')).read_text(encoding='utf-8'))
queue=requests.get(base+'/queue').json()
if queue['queue_running'] or queue['queue_pending']:
    raise RuntimeError('ComfyUI is busy; not submitting another job.')
async def run():
  async with aiohttp.ClientSession() as session, session.ws_connect('ws://127.0.0.1:8188/ws?clientId='+client) as ws:
    r=requests.post(base+'/prompt',json={'prompt':api,'client_id':client,'extra_data':{'extra_pnginfo':{'workflow':graph}}})
    (ROOT/(name+'-submitted.json')).write_text(r.text,encoding='utf-8')
    print('SUBMIT',r.status_code,r.text,flush=True)
    r.raise_for_status()
    pid=r.json()['prompt_id']
    started=time.monotonic()
    last=0
    with (ROOT/(name+'-events.jsonl')).open('w',encoding='utf-8') as events, (ROOT/(name+'-metrics.jsonl')).open('w',encoding='utf-8') as metrics:
        while True:
            try:
                msg=await ws.receive(timeout=5)
                raw=msg.data
                if isinstance(raw,str):
                    event=json.loads(raw)
                    events.write(json.dumps({'elapsed':time.monotonic()-started,**event},ensure_ascii=False)+'\n')
                    events.flush()
                    typ=event['type']; data=event.get('data',{})
                    if typ in ('execution_start','executing','progress','execution_error','execution_success'):
                        print(typ,json.dumps(data,ensure_ascii=False)[:1500],flush=True)
                    if data.get('prompt_id')==pid and (typ in ('execution_error','execution_success') or typ=='executing' and data.get('node') is None):
                        break
            except asyncio.TimeoutError:
                pass
            if time.monotonic()-last>=10:
                gpu=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used,power.draw,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True).stdout.strip()
                metrics.write(json.dumps({'elapsed':time.monotonic()-started,'gpu':gpu})+'\n'); metrics.flush()
                last=time.monotonic()
    history=requests.get(base+'/history/'+pid).json()
    (ROOT/(name+'-history.json')).write_text(json.dumps(history,ensure_ascii=False,indent=2),encoding='utf-8')
    print('FINAL',json.dumps({k:v.get('status') for k,v in history.items()},ensure_ascii=False),flush=True)
asyncio.run(run())

