import json
from pathlib import Path
import subprocess
import time
import psutil
import requests

ROOT=Path(__file__).resolve().parent
base='http://127.0.0.1:8188'
queue=requests.get(base+'/queue',timeout=10).json()
assert not queue['queue_running'] and not queue['queue_pending'], 'Queue must be idle'
listeners=[c for c in psutil.net_connections(kind='tcp') if c.laddr.port==8188 and c.status=='LISTEN']
assert listeners
p=psutil.Process(listeners[0].pid)
cmd=p.cmdline(); cwd=p.cwd()
assert any('ComfyUI' in x for x in cmd) and any('main.py' in x for x in cmd), cmd
(ROOT/'restart-command.json').write_text(json.dumps({'pid':p.pid,'cmd':cmd,'cwd':cwd},indent=2),encoding='utf-8')
p.terminate()
p.wait(timeout=20)
time.sleep(2)
try:
    if requests.get(base+'/system_stats',timeout=2).status_code==200:
        print('Desktop restarted ComfyUI automatically')
        raise SystemExit(0)
except requests.RequestException:
    pass
log=(ROOT/'comfy-restarted.log').open('ab',buffering=0)
child=subprocess.Popen(cmd,cwd=cwd,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
print('Started ComfyUI',child.pid,flush=True)
