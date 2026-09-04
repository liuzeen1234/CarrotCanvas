import { useEffect, useRef, useState } from 'react';
import { Input } from 'antd';

interface SharedProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
}

interface TextAreaProps extends SharedProps {
  autoSize?: boolean | { minRows?: number; maxRows?: number };
}

/**
 * 移动端中文输入法会先发送一串 composition 中间态。中间态只保留在控件本地，
 * 等 compositionEnd 后再回写画布节点，避免父节点重渲染打断输入法并产生重复文本。
 */
function useImeDraft(value: string, onChange: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);
  const committedRef = useRef(value);

  useEffect(() => {
    committedRef.current = value;
    if (!composingRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    setDraft(next);
    if (next === committedRef.current) return;
    committedRef.current = next;
    onChange(next);
  };

  return {
    draft,
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composingRef.current = false;
      commit(event.currentTarget.value);
    },
    onValueChange: (next: string, isComposing: boolean) => {
      setDraft(next);
      if (!composingRef.current && !isComposing) commit(next);
    },
    onBlur: () => {
      composingRef.current = false;
      commit(draft);
    },
  };
}

export function ImeSafeTextArea({ value, onChange, ...props }: TextAreaProps) {
  const ime = useImeDraft(value, onChange);
  return <Input.TextArea
    {...props}
    value={ime.draft}
    onCompositionStart={ime.onCompositionStart}
    onCompositionEnd={ime.onCompositionEnd}
    onBlur={ime.onBlur}
    onChange={(event) => ime.onValueChange(event.target.value, event.nativeEvent.isComposing)}
  />;
}

export function ImeSafeInput({ value, onChange, ...props }: SharedProps) {
  const ime = useImeDraft(value, onChange);
  return <Input
    {...props}
    value={ime.draft}
    onCompositionStart={ime.onCompositionStart}
    onCompositionEnd={ime.onCompositionEnd}
    onBlur={ime.onBlur}
    onChange={(event) => ime.onValueChange(event.target.value, event.nativeEvent.isComposing)}
  />;
}
