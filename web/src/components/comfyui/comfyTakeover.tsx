import { Modal, Typography } from 'antd';
import { request } from 'umi';

type TakeoverError = {
  code?: string;
  message?: string;
  portOwner?: { pid?: number; name?: string; path?: string | null; workingSetBytes?: number };
  desktopProcesses?: Array<{ pid?: number; name?: string }>;
};

export function isComfyTakeoverRequired(error: any) {
  return error?.response?.data?.code === 'COMFYUI_TAKEOVER_REQUIRED';
}

export async function confirmComfyTakeover(error: any): Promise<boolean> {
  if (!isComfyTakeoverRequired(error)) return false;
  const confirmation = await request<{ confirmationToken: string; expiresAt: number; inspection: TakeoverError }>('/api/comfyui/takeover/confirmation', { method: 'POST' });
  const conflictDetail = error.response.data as TakeoverError;
  const detail = { ...conflictDetail, ...confirmation.inspection, message: conflictDetail.message };
  const owner = detail.portOwner;
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: '检测到外部 ComfyUI，任务已安全中断',
      width: 560,
      okText: '关闭 Desktop 并交由调度器托管',
      cancelText: '暂不处理',
      content: <div>
        <Typography.Paragraph>{detail.message}</Typography.Paragraph>
        {owner ? <Typography.Paragraph type="secondary">
          端口进程：{owner.name || '未知'}（PID {owner.pid ?? '未知'}）<br />
          路径：{owner.path || '无法读取'}<br />
          内存：{formatBytes(owner.workingSetBytes)}
        </Typography.Paragraph> : null}
        <Typography.Text type="warning">确认后会关闭 ComfyUI Desktop 及其相关进程，并由调度器按需启动纯后端服务。以后仅遇到未知外部进程时再次询问。</Typography.Text>
      </div>,
      onOk: async () => {
        try {
          await request('/api/comfyui/takeover', { method: 'POST', data: {
            confirm: true, confirmationToken: confirmation.confirmationToken, alwaysManage: true,
          } });
          resolve(true);
        } catch (takeoverError) {
          resolve(false);
          throw takeoverError;
        }
      },
      onCancel: () => resolve(false),
    });
  });
}

function formatBytes(value?: number) {
  return Number.isFinite(value) ? `${(Number(value) / 1024 / 1024 / 1024).toFixed(2)} GB` : '未知';
}
