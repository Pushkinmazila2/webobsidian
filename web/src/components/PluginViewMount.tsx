import { useEffect, useRef } from 'react';

/** Mounts the DOM a community plugin's View built (`view.containerEl`) and keeps it informed about its size. */
export default function PluginViewMount({ leaf }: { leaf: { view?: { containerEl?: HTMLElement; onResize?: () => void } } }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = leaf.view?.containerEl;
    const box = host.current;
    if (!el || !box) return;
    box.appendChild(el);
    const ro = new ResizeObserver(() => { try { leaf.view?.onResize?.(); } catch (e) { console.warn('[plugin] onResize failed', e); } });
    ro.observe(box);
    return () => { ro.disconnect(); if (el.parentNode === box) box.removeChild(el); };
  }, [leaf, leaf.view]);
  return <div ref={host} className="plugin-view-host" />;
}
