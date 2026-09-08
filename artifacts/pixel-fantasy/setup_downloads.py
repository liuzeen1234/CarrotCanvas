import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import requests

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path('D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/models/LLM')
MODEL_DIR.mkdir(parents=True, exist_ok=True)
repo = 'unsloth/Qwen3.5-9B-GGUF'
files = requests.get(f'https://hf-mirror.com/api/models/{repo}/tree/main', timeout=30).json()
jobs = []
for name in ['Qwen3.5-9B-Q4_K_M.gguf', 'mmproj-F16.gguf']:
    meta = next(f for f in files if f['path'] == name)
    dest = MODEL_DIR / ('Qwen3.5-9B-mmproj-F16.gguf' if name.startswith('mmproj') else name)
    jobs.append((f'https://hf-mirror.com/{repo}/resolve/main/{name}', dest, meta.get('lfs', {}).get('oid'), meta['size']))
release = requests.get('https://api.github.com/repos/JamePeng/llama-cpp-python/releases/tags/v0.3.49-cu130-win-20260831', timeout=30).json()
asset = next(a for a in release['assets'] if 'cp313-cp313-win_amd64.whl' in a['name'])
jobs.append((asset['browser_download_url'], ROOT / asset['name'], (asset.get('digest') or '').removeprefix('sha256:') or None, asset['size']))
(ROOT / 'download-manifest.json').write_text(json.dumps([{'url':u,'path':str(p),'sha256':s,'size':n} for u,p,s,n in jobs], indent=2), encoding='utf-8')

def download(job):
    url, dest, sha, size = job
    partial = dest.with_suffix(dest.suffix + '.part')
    if dest.exists():
        assert dest.stat().st_size == size, f'Existing file size mismatch: {dest}'
        print(f'EXISTS {dest.name}', flush=True)
        return
    for attempt in range(4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            r = requests.get(url, headers={'Range': f'bytes={offset}-'} if offset else {}, stream=True, timeout=(30, 90))
            r.raise_for_status()
            append = offset > 0 and r.status_code == 206
            if not append:
                offset = 0
            last = time.monotonic()
            with partial.open('ab' if append else 'wb') as out:
                for chunk in r.iter_content(4 * 1024 * 1024):
                    out.write(chunk)
                    offset += len(chunk)
                    if time.monotonic() - last > 15:
                        print(f'{dest.name}: {offset/size:.1%} ({offset/1e9:.2f}/{size/1e9:.2f} GB)', flush=True)
                        last = time.monotonic()
            assert partial.stat().st_size == size
            if sha:
                with partial.open('rb') as inp:
                    actual = hashlib.file_digest(inp, 'sha256').hexdigest()
                assert actual == sha, f'Hash mismatch: {dest}'
            partial.rename(dest)
            print(f'COMPLETE {dest.name}', flush=True)
            return
        except Exception as exc:
            print(f'RETRY {dest.name}: {exc}', flush=True)
            if attempt == 3:
                raise

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download, jobs))
