/** Lazy chunk: every Lucide icon as inner SVG markup (see loadLucide in Icon.tsx). */
import { icons } from 'lucide';

type Node = [string, Record<string, string | number>];
const attrs = (a: Record<string, string | number>) => Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
export const lucideIcons: Record<string, string> = Object.fromEntries(
  Object.entries(icons as unknown as Record<string, Node[]>).map(([name, nodes]) => [name, nodes.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('')]),
);
