import { BadGatewayException } from '@nestjs/common';
import { Codex2ApiController, composeTextTransformPrompt } from './codex2api.controller';

describe('Codex2ApiController text transform mode', () => {
  it('composes the instruction and upstream text with explicit boundaries', () => {
    expect(composeTextTransformPrompt('原始文字', '压缩到 100 字')).toBe(
      '请按照以下要求处理输入文本。\n\n加工要求：\n压缩到 100 字\n\n输入文本：\n原始文字',
    );
  });

  it('forwards only the composed prompt and preserves both source fields in the run snapshot', async () => {
    const providerPayload = { choices: [{ message: { content: '加工结果' } }] };
    const service = {
      request: jest.fn().mockResolvedValue(new Response(JSON.stringify(providerPayload), { status: 200 })),
      readJsonResponse: jest.fn().mockResolvedValue(providerPayload),
    };
    const runs = {
      begin: jest.fn().mockResolvedValue({ run: { id: 'run-text' }, replay: false }),
      patch: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new Codex2ApiController(service as any, { assertWriteAccess: jest.fn() } as any, runs as any);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await controller.chat({
      model: 'codex', stream: false,
      messages: [{ role: 'user', content: '不应直接转发' }],
      carrotInputText: '上游产物', carrotInstruction: '改写成三点',
    }, response as any);

    const forwarded = JSON.parse(service.request.mock.calls[0][1].body);
    expect(forwarded.messages).toEqual([{
      role: 'user',
      content: composeTextTransformPrompt('上游产物', '改写成三点'),
    }]);
    expect(forwarded.carrotInputText).toBeUndefined();
    expect(forwarded.carrotInstruction).toBeUndefined();
    expect(runs.begin.mock.calls[0][0].inputSnapshot).toMatchObject({
      carrotInputText: '上游产物',
      carrotInstruction: '改写成三点',
      messages: forwarded.messages,
    });
    expect(runs.finish).toHaveBeenCalledWith('run-text', 'succeeded', [], null, '加工结果', null);
  });
});

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
