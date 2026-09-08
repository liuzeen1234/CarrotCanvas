import { BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
const exec = promisify(execFile);

/** Reference videos use 24 fps; normalize frame timing, preserving the soundtrack. */
export async function prepareMediaUpload(buffer: Buffer, filename: string, kind = 'image') {
  const name = basename(filename.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._-]/gu, '_');
  if (!name || !buffer.length) throw new BadRequestException('文件内容或文件名为空');
  if (!['image', 'video', 'audio'].includes(kind)) throw new BadRequestException('不支持的媒体类型');
  if (kind !== 'video') return { buffer, name };
  const dir = await fs.mkdtemp(join(tmpdir(), 'carrot-reference-'));
  try {
    const source = join(dir, `input-${name}`); const output = join(dir, 'normalized.mp4');
    await fs.writeFile(source, buffer);
    const { stdout } = await exec('ffprobe', ['-v','error','-show_entries','format=duration','-of','json',source], { timeout: 30000 });
    const duration = Number(JSON.parse(stdout).format?.duration);
    if (!Number.isFinite(duration) || duration < 2 || duration > 15.1) throw new BadRequestException('参考视频时长需为 2–15 秒');
    await exec('ffmpeg', ['-v','error','-i',source,'-map','0:v:0','-map','0:a?','-vf','fps=24','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-y',output], { timeout: 180000 });
    return { buffer: await fs.readFile(output), name: `${name.replace(/\.[^.]+$/, '')}-24fps.mp4` };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('视频读取或 24 fps 转换失败，请检查文件及 ffmpeg/ffprobe 安装');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
