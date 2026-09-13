"""CPU-only technical QA. Does not certify perceptual event/source quality."""
import json
import sys
from pathlib import Path
import numpy as np
import av

reports = []
for filename in sys.argv[1:]:
    with av.open(filename) as container:
        stream = container.streams.audio[0]
        sr = stream.codec_context.sample_rate
        codec = stream.codec_context.name
        decoded_format = stream.codec_context.format.name
        resampler = av.AudioResampler(format='fltp', layout=stream.codec_context.layout, rate=sr)
        chunks = [out.to_ndarray() for frame in container.decode(stream) for out in resampler.resample(frame)]
        chunks.extend(out.to_ndarray() for out in resampler.resample(None))
        data = np.concatenate(chunks, axis=1).T.astype('float64')
    size = max(1, int(sr * 0.1))
    envelope = [float(np.sqrt(np.mean(data[i:i+size] ** 2))) for i in range(0,len(data),size)]
    rms = float(np.sqrt(np.mean(data ** 2)))
    peak = float(np.max(np.abs(data)))
    per_second_rms = [float(np.sqrt(np.mean(data[i:i+sr] ** 2))) for i in range(0, len(data), sr)]
    threshold = max(10**(-45/20), max(envelope)*0.15)
    groups = []
    for i, value in enumerate(envelope):
        if value > threshold:
            if groups and i * .1 - groups[-1]['end'] <= .3:
                groups[-1]['end'] = round((i+1)*.1, 3)
            else:
                groups.append({'start': round(i*.1,3), 'end': round((i+1)*.1,3)})
    reports.append(dict(filename=str(Path(filename).resolve()), duration=len(data)/sr, sample_rate=sr, channels=data.shape[1], format=codec, decoded_format=decoded_format, frames=len(data), finite=bool(np.isfinite(data).all()), peak=peak, peak_dbfs=float(20*np.log10(max(peak,1e-12))), rms_dbfs=float(20*np.log10(max(rms,1e-12))), clipped_samples=int(np.sum(np.abs(data)>=.9999)), silence_sample_fraction=float(np.mean(np.abs(data)<10**(-60/20))), per_second_rms=per_second_rms, envelope_100ms=envelope, amplitude_activity_groups=groups, caveat='Amplitude groups are not semantic event counts; speech/music/extra sounds and natural tail need actual listening.'))
print(json.dumps(reports, indent=2))
