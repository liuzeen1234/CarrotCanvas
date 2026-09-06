import { Injectable, Logger } from '@nestjs/common';
import { ComfyUIClientService } from './comfyui-client';
import { RunState } from './comfyui-runner.service';
import { AssetsService } from '../assets/assets.service';
import { AssetKind } from '../assets/asset.entity';

/**
 * C2 画布运行产物捕获（CANVAS-INTEGRATION §4.3 / §4.6）。
 * 画布节点发起的运行成功后，把 ComfyUI 输出字节捕获进该画布资产分区并建 asset 行，
 * 每次运行追加新资产；旧候选由生成历史持久保留。
 * 工具箱运行（不带 canvasId）不经过本服务，维持"代理不落盘"现状。
 */
@Injectable()
export class ComfyUIAssetCaptureService {
  private readonly logger = new Logger('ComfyUIAssetCapture');

  constructor(
    private readonly client: ComfyUIClientService,
    private readonly assets: AssetsService,
  ) {}

  /**
   * 运行成功后捕获该 run 的所有输出文件。
   * - 逐文件从 ComfyUI /view 拉取字节 → saveGenerated 落盘建 asset 行；
   * - 全部成功且指定了 nodeId 时，覆盖清理该节点上一版 generated 产物；
   * - 任一文件失败则中止，保留已捕获部分与旧资产（下次重跑再整组替换）。
   * 捕获结果回填到 run.outputs（assetId / assetUrl），前端轮询可见。
   */
  async captureRunOutputs(
    run: RunState,
    canvasId: string,
    nodeId: string | null,
    workflowId: string,
  ): Promise<void> {
    const capturable = run.outputs.filter((o) => o.kind !== 'other');
    if (!capturable.length) {
      this.logger.warn(
        `运行 ${run.promptId} 无可用输出文件（kind=other 跳过），不做资产捕获`,
      );
      return;
    }

    const captured = new Map<string, { assetId: string; assetUrl: string }>();
    let allOk = true;

    for (const out of capturable) {
      const key = outputKey(out.filename, out.subfolder, out.type);
      try {
        const { buffer, mime } = await this.client.fetchViewFile({
          filename: out.filename,
          type: out.type,
          subfolder: out.subfolder,
        });
        const asset = await this.assets.saveGenerated({
          canvasId,
          nodeId,
          runPromptId: run.promptId,
          workflowId,
          kind: out.kind as AssetKind,
          buffer,
          originName: out.filename,
          mime: inferMime(out.kind, mime, out.filename),
        });
        captured.set(key, { assetId: asset.id, assetUrl: `/api/assets/${asset.id}` });
      } catch (e) {
        allOk = false;
        this.logger.error(
          `捕获运行 ${run.promptId} 输出 ${out.filename} 失败：${(e as Error).message}`,
        );
      }
    }

    // 回填 outputs（无论是否全部成功，已捕获的都让前端可见）
    if (captured.size) {
      for (const out of run.outputs) {
        const c = captured.get(outputKey(out.filename, out.subfolder, out.type));
        if (c) {
          out.assetId = c.assetId;
          out.assetUrl = c.assetUrl;
        }
      }
    }

    if (allOk && captured.size) {
      this.logger.log(`运行 ${run.promptId} 追加捕获 ${captured.size} 个候选资产`);
    } else if (!allOk) {
      this.logger.warn(
        `运行 ${run.promptId} 部分输出捕获失败，保留旧产物，本次已捕获 ${captured.size} 个文件`,
      );
    }
  }
}

function outputKey(filename: string, subfolder: string, type: string): string {
  return `${type}/${subfolder}/${filename}`;
}

/** 优先用 /view 返回的 content-type；缺失或泛化时按扩展名推断 */
function inferMime(
  kind: string,
  mime: string | null,
  filename?: string,
): string | null {
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
  };
  if (map[ext]) return map[ext];
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/wav';
    default:
      return null;
  }
}
