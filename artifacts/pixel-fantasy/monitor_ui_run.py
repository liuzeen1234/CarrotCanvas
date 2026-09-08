import json
from pathlib import Path
import subprocess
import time
import psutil
import requests

ROOT=Path(__file__).resolve().parent
base='http://127.0.0.1:8188'
queue=requests.get(base+'/queue').json()
run=queue['queue_running'][0]
pid=run[1]
(ROOT/'auto-ui-submitted.json').write_text(json.dumps(run,ensure_ascii=False,indent=2),encoding='utf-8')
assert run[2]['210']['inputs']['force_offload'] is True
assert run[2]['212']['inputs']['ref_images.ref_image_0']==['114',0]
assert run[2]['134']['inputs']['values.a']==['135',0]
print('Monitoring',pid,'UI inputs verified',flush=True)
started=time.monotonic()
psutil.cpu_percent()
with (ROOT/'auto-ui-metrics.jsonl').open('w',encoding='utf-8') as out:
    while True:
        h=requests.get(base+'/history/'+pid).json()
        if pid in h:
            (ROOT/'auto-ui-history.json').write_text(json.dumps(h,ensure_ascii=False,indent=2),encoding='utf-8')
            print('DONE',json.dumps(h[pid]['status']),flush=True)
            break
        gpu=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used,power.draw,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True).stdout.strip()
        v=psutil.virtual_memory()
        out.write(json.dumps({'elapsed':time.monotonic()-started,'gpu':gpu,'cpu_percent':psutil.cpu_percent(),'ram_used':v.used,'ram_available':v.available})+'\n');out.flush()
        time.sleep(5)
