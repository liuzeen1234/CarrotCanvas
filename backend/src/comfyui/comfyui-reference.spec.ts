import { ComfyUISchemaService } from './comfyui-schema.service';
import { prepareComfyInputs } from './comfyui-reference';

describe('ComfyUI reference and connected scalar inputs', () => {
  const service = new ComfyUISchemaService();
  const info = {
    MiniMaxH3ReferenceToVideo: { input: { required: { ref_image_size: ['COMBO', { options: ['match', 'max'] }] } } },
    Controls: { input: { required: { steps: ['INT', { min: 1, max: 20 }], turbo: ['BOOLEAN', {}], ratio: ['COMBO', { options: ['16:9', '1:1'] }] } } },
  };
  it('exposes all optional reference sockets, preserving existing graph connections and modern combos', () => {
    const schema = service.analyze({ r: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['image', 0], ref_image_size: 'match' } } }, info);
    expect(schema.editableCount).toBe(18);
    expect(schema.groups[0].fields.find(f => f.param === 'ref_image_size')?.control).toBe('select');
    expect(schema.groups[0].fields.filter(f => f.mediaKind === 'video')).toHaveLength(3);
    expect(schema.groups[0].fields.filter(f => f.mediaKind === 'audio')).toHaveLength(6);
    expect(schema.groups[0].fields.filter(f => f.control === 'upload').every(f => !f.required)).toBe(true);
  });
  it('builds video/audio/image loaders, removes empty optionals and leaves the template unchanged', () => {
    const raw = { r: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['original',0], 'ref_images.ref_image_1': 'new.png', 'ref_images.ref_image_2': '', 'ref_videos.ref_video_0': 'test.mp4', 'ref_video_audios.ref_video_audio_0': 'voice.wav', 'ref_audios.ref_audio_0': 'sound.wav' } } };
    const schema = service.analyze(raw, info);
    const prepared = prepareComfyInputs(raw, schema) as Record<string, any>;
    expect(prepared.r.inputs['ref_images.ref_image_0']).toEqual(['original',0]);
    expect(prepared.r.inputs['ref_images.ref_image_2']).toBeUndefined();
    expect(Object.values(prepared).map(n => n.class_type)).toEqual(expect.arrayContaining(['LoadImage','LoadVideo','GetVideoComponents','LoadAudio']));
    expect(raw.r.inputs['ref_videos.ref_video_0']).toBe('test.mp4');
    expect(prepareComfyInputs(prepared, service.analyze(prepared, info))).toEqual(prepared);
  });
  it('converts connected numeric, boolean and enum text and rejects invalid values', () => {
    const raw = { c: { class_type: 'Controls', inputs: { steps: '4', turbo: 'false', ratio: '16:9' } } };
    const prepared = prepareComfyInputs(raw, service.analyze(raw, info)) as Record<string, any>;
    expect(prepared.c.inputs).toEqual({ steps: 4, turbo: false, ratio: '16:9' });
    for (const inputs of [{ steps: 'bad' }, { steps: '21' }, { steps: '4.5' }, { turbo: 'nope' }, { ratio: 'bad' }]) {
      const graph = { c: { class_type: 'Controls', inputs } };
      expect(() => prepareComfyInputs(graph, service.analyze(graph, info))).toThrow();
    }
  });
  it('rejects reference paths outside the input directory', () => {
    const raw = { r: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_audios.ref_audio_0': '../private.wav' } } };
    expect(() => prepareComfyInputs(raw, service.analyze(raw, info))).toThrow();
  });
  it('allows clearing legacy image defaults for audio-only reference and rejects orphan soundtrack or numbering gaps', () => {
    const raw = { image: { class_type: 'LoadImage', inputs: { image: '' } }, r: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['image',0], 'ref_audios.ref_audio_0': 'sound.wav' } } };
    const prepared = prepareComfyInputs(raw, service.analyze(raw, info)) as Record<string, any>;
    expect(prepared.image).toBeUndefined();
    expect(prepared.r.inputs['ref_images.ref_image_0']).toBeUndefined();
    for (const inputs of [{ 'ref_video_audios.ref_video_audio_0': 'sound.wav' }, { 'ref_videos.ref_video_1': 'clip.mp4' }]) {
      const graph = { r: { class_type: 'MiniMaxH3ReferenceToVideo', inputs } };
      expect(() => prepareComfyInputs(graph, service.analyze(graph, info))).toThrow();
    }
  });
  it('exposes dynamic video codec choices', () => {
    const schema = service.analyze({ v: { class_type:'SaveVideo',inputs:{codec:'auto'} } }, { SaveVideo:{input:{required:{codec:['COMFY_DYNAMICCOMBO_V3',{options:[{key:'auto'},{key:'h264'}]}]}}} });
    expect(schema.groups[0].fields[0]).toMatchObject({ control:'select',options:['auto','h264'] });
  });
});
