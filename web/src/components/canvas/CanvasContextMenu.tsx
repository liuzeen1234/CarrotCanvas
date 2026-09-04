/**
 * CarrotCanvas 画布空白右键分级菜单（C5，§4.2.1）。
 * 一级 = 工作流分类（文生图 / 图生图 / …）；悬停展开二级 = 该分类下所有工作流。
 * 一期只有「文生图」分类可点，其余分类项、以及空分类项 disabled 置灰（不隐藏）。
 * 选中某工作流 → 回调 onPick(workflow)，由编辑器在右键处（经 screenToFlowPosition 转坐标）落生成节点。
 *
 * 实现：不用受控 Dropdown（受控 open + 0 尺寸锚点定位不可靠），改为在右键屏幕坐标处
 * 渲染一个 fixed 定位的 AntD Menu 浮层，点击外部 / Esc / 选中后关闭。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Spin, type MenuProps } from 'antd';
import { request } from 'umi';
import { ComfyUIAPI } from '@/components/comfyui/types';
import { WORKFLOW_CATEGORIES } from './workflowCategories';
import type { CodexCapability } from './nodes/types';

export interface CanvasContextMenuState {
  /** 屏幕坐标（右键处），既用于菜单定位也用于换算节点落点 */
  screenX: number;
  screenY: number;
  /** 从输出端点拖到空白处时携带；菜单只展示有同类型输入的工作流。 */
  connection?: { sourceNodeId: string; sourceHandle: string; kind: 'image' | 'video' | 'audio' | 'text' };
}

export interface CanvasContextMenuProps {
  /** 打开状态与右键屏幕坐标；null = 关闭 */
  state: CanvasContextMenuState | null;
  onClose: () => void;
  /** 选中某分类下的具体工作流 */
  onPick: (workflow: ComfyUIAPI) => void;
  onPickCapability: (capability: CodexCapability) => void;
}

/** 当前画布已支持的工作流分类。 */
const ENABLED_CATEGORIES = new Set(['txt2img', 'img2img', 'txt2vid', 'img2vid']);

export default function CanvasContextMenu({ state, onClose, onPick, onPickCapability }: CanvasContextMenuProps) {
  const [workflows, setWorkflows] = useState<ComfyUIAPI[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 首次打开时拉一次工作流列表（后续复用；编辑期新增工作流频率低，重开编辑器会重取）
  useEffect(() => {
    if (!state || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    request<ComfyUIAPI[]>('/api/workflows')
      .then((list) => setWorkflows(list ?? []))
      .catch(() => setWorkflows([]))
      .finally(() => setLoading(false));
  }, [state]);

  // 打开时：点击外部 / 再次右键 / Esc 关闭
  // 用 click（而非 mousedown）做外部关闭：click 晚于 Menu 的选中 onClick，
  // 因此点二级工作流项时先完成选中再关闭，不会打断 onPick；点画布空白则正常关闭。
  useEffect(() => {
    if (!state) return;
    const shouldKeep = (target: HTMLElement) => {
      if (menuRef.current && menuRef.current.contains(target)) return true;
      // 一级菜单展开的二级弹层渲染在 body 上，点它（展开/悬停时）不算外部
      return !!target.closest?.('.ant-menu-submenu-popup');
    };
    const onDocClick = (e: MouseEvent) => {
      if (!shouldKeep(e.target as HTMLElement)) onClose();
    };
    const onDocContextMenu = (e: MouseEvent) => {
      // 在别处再次右键：关闭当前菜单（编辑器会紧接着以新坐标重新打开）
      if (!shouldKeep(e.target as HTMLElement)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 延迟挂载，避免本次右键的 click/contextmenu 立即关闭刚打开的菜单
    const t = setTimeout(() => {
      document.addEventListener('click', onDocClick);
      document.addEventListener('contextmenu', onDocContextMenu);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('contextmenu', onDocContextMenu);
      document.removeEventListener('keydown', onKey);
    };
  }, [state, onClose]);

  /** 按分类分组 */
  const byCategory = useMemo(() => {
    const map = new Map<string, ComfyUIAPI[]>();
    for (const w of workflows) {
      const arr = map.get(w.category) ?? [];
      arr.push(w);
      map.set(w.category, arr);
    }
    return map;
  }, [workflows]);

  const items: MenuProps['items'] = useMemo(() => {
    const compatibleCapabilities: CodexCapability[] = !state?.connection
      ? ['text', 'image', 'edit', 'analyze']
      : state.connection.kind === 'text'
        ? ['text', 'image', 'edit', 'analyze']
        : state.connection.kind === 'image'
          ? ['edit', 'analyze']
          : [];
    const capabilityLabels: Record<CodexCapability, string> = {
      text: '文生文', image: '文生图', edit: '图生图', analyze: '图像理解',
    };
    const capabilityItems: MenuProps['items'] = compatibleCapabilities.length ? [{
      key: 'codex', label: 'AI 能力（Codex2API）', children: [
        ...compatibleCapabilities.map((capability) => ({
          key: `cap:${capability}`,
          label: capabilityLabels[capability],
        })),
      ],
    }, { type: 'divider' }] : [];
    return [...capabilityItems, ...WORKFLOW_CATEGORIES.map((cat) => {
      const list = (byCategory.get(cat.value) ?? []).filter((workflow) =>
        !state?.connection || workflow.inputConfig?.fields?.some((field) => field.kind === state.connection!.kind),
      );
      const enabled = ENABLED_CATEGORIES.has(cat.value);
      if (!enabled) {
        // 其余分类一期未放开：置灰、不可展开（§4.2.1）
        return { key: `cat:${cat.value}`, label: cat.label, disabled: true };
      }
      if (list.length === 0) {
        // 已放开但无工作流：置灰
        return { key: `cat:${cat.value}`, label: `${cat.label}（${state?.connection ? `不支持 ${state.connection.kind} 输入` : '暂无工作流'}）`, disabled: true };
      }
      // 已放开且有工作流：可展开二级列出具体工作流
      return {
        key: `cat:${cat.value}`,
        label: cat.label,
        children: list.map((w) => ({ key: `wf:${w.id}`, label: w.name })),
      };
    })];
  }, [byCategory, state?.connection]);

  const handleClick: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('cap:')) {
      onPickCapability(key.slice(4) as CodexCapability);
      onClose();
      return;
    }
    if (!key.startsWith('wf:')) return;
    const id = key.slice(3);
    const wf = workflows.find((w) => w.id === id);
    if (wf) onPick(wf);
    onClose();
  };

  if (!state) return null;

  // 防止菜单超出视口右/下边缘（粗略夹取）
  const left = Math.min(state.screenX, window.innerWidth - 240);
  const top = Math.min(state.screenY, window.innerHeight - 200);

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: Math.max(8, left),
        top: Math.max(8, top),
        zIndex: 2000,
        boxShadow: '0 6px 16px rgba(0,0,0,0.16)',
        borderRadius: 8,
        background: '#fff',
        minWidth: 180,
      }}
      // 阻止右键浮层自身再次触发画布右键
      onContextMenu={(e) => e.preventDefault()}
    >
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : (
        <Menu
          mode="vertical"
          items={items}
          onClick={handleClick}
          selectable={false}
          style={{ border: 'none', borderRadius: 8 }}
        />
      )}
    </div>
  );
}
