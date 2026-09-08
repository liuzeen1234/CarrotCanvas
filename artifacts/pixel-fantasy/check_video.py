import av
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parent
src=Path(sys.argv[1])
label=sys.argv[2] if len(sys.argv)>2 else 'manual'
container=av.open(str(src))
stream=container.streams.video[0]
width,height,fps=stream.width,stream.height,float(stream.average_rate)
frames=[]
count=0
for frame in container.decode(video=0):
    if count%24==12:
        frames.append((count,frame.to_image()))
    count+=1
container.close()
audio=av.open(str(src))
audio_stream=audio.streams.audio[0]
audio_arrays=[f.to_ndarray().astype(np.float64) for f in audio.decode(audio=0)]
arr=np.concatenate(audio_arrays,axis=-1)
meta={'file':str(src),'width':width,'height':height,'frames':count,'fps':fps,'duration':count/fps,'audio_sample_rate':audio_stream.rate,'audio_channels':audio_stream.channels,'audio_peak':float(np.abs(arr).max()),'audio_rms':float(np.sqrt(np.mean(arr**2)))}
audio.close()
sheet=Image.new('RGB',(5*320,3*204),'#111827')
draw=ImageDraw.Draw(sheet)
for idx,(number,img) in enumerate(frames[:15]):
    img.thumbnail((320,180))
    x=(idx%5)*320;y=(idx//5)*204
    sheet.paste(img,(x,y))
    draw.text((x+8,y+182),f'{number/24:.1f}s',fill='white')
sheet.save(ROOT/(label+'-contact-sheet.jpg'),quality=92)
(ROOT/(label+'-media-info.json')).write_text(json.dumps(meta,indent=2),encoding='utf-8')
print(json.dumps(meta))
