import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

export default function TagsPanel() {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const searchFor = useStore((s) => s.searchFor);

  useEffect(() => {
    api.tags().then((r) => setTags(r.tags)).catch(() => {});
  }, []);

  return (
    <div className="tag-container" style={{ padding: 8 }}>
      {tags.length === 0 && <div style={{ color: 'var(--text-faint)', padding: 8 }}>No tags found</div>}
      {tags.map((t) => (
        <span
          key={t.tag}
          className="tag-pill tag-pane-tag tree-item-self"
          title={`Search #${t.tag}`}
          onClick={() => searchFor(`tag:${t.tag}`)}
        >
          <span className="tag-pane-tag-text tree-item-inner-text">#{t.tag}</span>{' '}
          <span className="count tag-pane-tag-count">{t.count}</span>
        </span>
      ))}
    </div>
  );
}
