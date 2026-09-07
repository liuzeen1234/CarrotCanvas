import { ComfyUISchemaService } from './comfyui-schema.service';

describe('ComfyUISchemaService seed detection', () => {
  const service = new ComfyUISchemaService();
  const int = (extra: Record<string, unknown> = {}) => ['INT', { min: 0, max: 0xffffffffffffffff, ...extra }];

  it('识别 KSampler seed 与 RandomNoise noise_seed', () => {
    const result = service.analyze({
      '1': { class_type: 'KSampler', inputs: { seed: 42 } },
      '2': { class_type: 'RandomNoise', inputs: { noise_seed: 7 } },
    }, {
      KSampler: { input: { required: { seed: int() } } },
      RandomNoise: { input: { required: { noise_seed: int() } } },
    });
    expect(result.groups.flatMap((group) => group.fields).map((field) => field.isSeed)).toEqual([true, true]);
  });

  it('不把普通整数或无种子语义节点的 seed 字段误判为随机种子', () => {
    const result = service.analyze({
      '1': { class_type: 'ImageResize', inputs: { seed: 42, width: 1024 } },
    }, {
      ImageResize: { input: { required: { seed: int(), width: int() } } },
    });
    expect(result.groups[0].fields.map((field) => field.isSeed)).toEqual([false, false]);
  });

  it('结合 control_after_generate 识别自定义种子节点', () => {
    const result = service.analyze({
      '1': { class_type: 'CustomGenerator', inputs: { seed: 42 } },
    }, {
      CustomGenerator: { input: { required: { seed: int({ control_after_generate: 'randomize' }) } } },
    });
    expect(result.groups[0].fields[0].isSeed).toBe(true);
  });
});
