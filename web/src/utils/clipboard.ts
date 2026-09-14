import { message } from 'antd';

/** HTTP 页面在用户点击期间同步执行回退，避免丢失浏览器用户激活。 */
function copyWithSelection(text: string): void {
  const activeElement = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:16px;';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Copy unavailable');
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

export async function copyCanvasTitle(title: string): Promise<void> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(title);
      } catch {
        copyWithSelection(title);
      }
    } else {
      copyWithSelection(title);
    }
    message.success('画布标题已复制');
  } catch {
    message.error('复制失败，请手动选择标题复制');
  }
}
