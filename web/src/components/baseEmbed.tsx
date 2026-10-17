import { createRoot } from 'react-dom/client';
import { pluginHost } from '../lib/pluginHost';
import BaseView from './BaseView';

/** Mount a Bases view into a DOM element (note embeds, ```base blocks); returns the unmount function. */
export function installBaseEmbedRenderer() {
  pluginHost.setBaseEmbedRenderer((el, o) => {
    const root = createRoot(el);
    root.render(<BaseView path={o.path} source={o.source} thisPath={o.thisPath} viewName={o.viewName} embedded />);
    return () => queueMicrotask(() => root.unmount());
  });
}
