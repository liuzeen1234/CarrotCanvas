import { Controller, Get, Put, Post, Param, Body, HttpException } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get(':key')
  async get(@Param('key') key: string) {
    const row = await this.settingsService.get(key);
    return { key, value: row?.value ?? null };
  }

  @Put(':key')
  async set(@Param('key') key: string, @Body('value') value: string | null) {
    const row = await this.settingsService.set(key, value);
    return { key, value: row.value };
  }

  @Post('test-connection')
  async testConnection(@Body('url') url: string) {
    if (!url) {
      throw new HttpException('缺少 url 参数', 400);
    }
    try {
      const resp = await fetch(`${url.replace(/\/+$/, '')}/system_stats`);
      if (resp.ok) {
        const data = await resp.json();
        return { ok: true, data };
      }
      return { ok: false, error: `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
