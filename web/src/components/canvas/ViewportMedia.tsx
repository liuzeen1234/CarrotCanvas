import { createElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type SyntheticEvent } from 'react';

// One observer for all card media: panning does not subscribe every card to
// React Flow's viewport store. A small margin prepares media before it appears.
const listeners = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
function observe(element: Element, listener: (visible: boolean) => void) {
  if (typeof IntersectionObserver === 'undefined') { listener(true); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: '160px' });
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    listeners.delete(element);
    if (!listeners.size) { observer?.disconnect(); observer = undefined; }
  };
}

type MediaProps = { kind: 'img' | 'video' | 'audio' } & (ComponentPropsWithoutRef<'img'> | ComponentPropsWithoutRef<'video'>);
function ViewportMedia({ kind, src, style, onLoadedMetadata, ...props }: MediaProps) {
  const ref = useRef<HTMLImageElement | HTMLVideoElement | HTMLAudioElement>(null);
  const [visible, setVisible] = useState(false);
  const height = useRef(0);
  const playbackTime = useRef(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      // offsetHeight is in canvas coordinates, unaffected by zoom.
      if (element.hasAttribute('src') && element.offsetHeight) height.current = element.offsetHeight;
    });
    resize.observe(element);
    const stop = observe(element, (next) => {
      if (!next && element.hasAttribute('src') && element.offsetHeight) {
        height.current = element.offsetHeight;
      }
      if (!next && element instanceof HTMLMediaElement) {
        playbackTime.current = element.currentTime;
        element.pause();
      }
      setVisible(next);
    });
    return () => {
      stop(); resize.disconnect();
      if (element instanceof HTMLMediaElement) element.pause();
    };
  }, []);
  useEffect(() => { playbackTime.current = 0; }, [src]);
  useEffect(() => {
    const element = ref.current;
    if (!visible && element instanceof HTMLMediaElement) {
      // Removing src alone can retain the previous decoder/buffer.
      element.removeAttribute('src');
      element.load();
    }
  }, [visible, src]);
  return createElement(kind, { ...props, ref,
    src: visible ? src : undefined, 'data-viewport-media': kind, 'data-media-active': visible,
    decoding: kind === 'img' ? 'async' : undefined,
    style: visible ? style : { ...style, ...(height.current ? { height: height.current } : { aspectRatio: kind === 'audio' ? undefined : '1' }), color: 'transparent', background: '#f2f2f2' },
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      if (playbackTime.current && Number.isFinite(event.currentTarget.duration)) {
        event.currentTarget.currentTime = Math.min(playbackTime.current, event.currentTarget.duration);
      }
      (onLoadedMetadata as ((event: SyntheticEvent<HTMLMediaElement>) => void) | undefined)?.(event);
    },
  });
}

export function ViewportImage(props: ComponentPropsWithoutRef<'img'>) { return <ViewportMedia {...props} kind="img" />; }
export function ViewportVideo(props: ComponentPropsWithoutRef<'video'>) { return <ViewportMedia {...props} preload={props.preload || 'metadata'} kind="video" />; }
export function ViewportAudio(props: ComponentPropsWithoutRef<'audio'>) { return <ViewportMedia {...props} preload={props.preload || 'none'} kind="audio" />; }
