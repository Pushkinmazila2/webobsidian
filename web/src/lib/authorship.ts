import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** "Show authors": every stretch of text shaded in the colour of the person who wrote it. */
export interface AuthorSpan {
  from: number;
  to: number;
  name: string;
  color: string;
}

export const setAuthorship = StateEffect.define<AuthorSpan[]>();

export const authorshipField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes); // follows typing between refreshes
    for (const e of tr.effects) {
      if (!e.is(setAuthorship)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const len = tr.state.doc.length;
      for (const s of e.value) {
        const from = Math.min(s.from, len);
        const to = Math.min(s.to, len);
        if (to <= from) continue;
        b.add(from, to, Decoration.mark({
          class: 'author-span',
          attributes: { style: `background:${s.color}2e;border-bottom:2px solid ${s.color}`, title: `Written by ${s.name}` },
        }));
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
