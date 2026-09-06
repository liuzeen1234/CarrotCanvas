import { BadGatewayException } from '@nestjs/common';
import { Codex2ApiController } from './codex2api.controller';

describe('Codex2ApiController image prompt reverse mode', () => {
  const createController = (payload: any) => {
    const service = {
      forwardMultipart: jest.fn().mockResolvedValue(payload),
    };
    const canvas = { assertWriteAccess: jest.fn() };
    const runs = {
      begin: jest.fn().mockResolvedValue({ run: { id: 'run-1' }, replay: false }),
      patch: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    return {
      controller: new Codex2ApiController(service as any, canvas as any, runs as any),
      service,
      runs,
    };
  };

  it('reuses image-prompts compatibility value and injects a visual reproduction instruction', async () => {
    const { controller, service, runs } = createController({
      text: '{"positive":"orange rabbit, cinematic light","negative":"watermark, blur"}',
    });

    const result = await controller.analyze([], {
      model: 'codex',
      prompt: '使用中文，重点描述构图',
      carrotOutputMode: 'image-prompts',
    });

    const forwardedFields = service.forwardMultipart.mock.calls[0][2];
    expect(forwardedFields.prompt).toContain('使用中文，重点描述构图');
    expect(forwardedFields.prompt).toContain('尽可能复现');
    expect(forwardedFields.prompt).toContain('不得声称恢复原始 prompt');
    expect(forwardedFields.prompt).toContain('seed、LoRA');

    const beginInput = runs.begin.mock.calls[0][0];
    expect(beginInput.inputSnapshot).toMatchObject({
      carrotOutputMode: 'image-prompts',
      carrotPromptIntent: 'reverse-image-prompt',
    });
    expect(result.outputParts).toEqual({
      positive: 'orange rabbit, cinematic light',
      negative: 'watermark, blur',
    });
    expect(runs.finish).toHaveBeenCalledWith(
      'run-1', 'succeeded', [], null,
      '正向提示词：orange rabbit, cinematic light\n\n负向提示词：watermark, blur',
      result.outputParts,
    );
  });

  it('returns a structured 502 failure when the provider output cannot be parsed', async () => {
    const { controller, runs } = createController({ text: '这不是 JSON' });

    await expect(controller.analyze([], {
      model: 'codex',
      carrotOutputMode: 'image-prompts',
    })).rejects.toBeInstanceOf(BadGatewayException);

    expect(runs.finish).toHaveBeenCalledWith('run-1', 'failed', [], {
      code: 'STRUCTURED_PROMPT_INVALID',
      message: '模型未返回可解析的正向与负向提示词，请重试',
    });
  });
});
