/**
 * Drives plugins' `EditorSuggest`s from the CodeMirror editor: after every cursor/doc change each registered
 * suggest's `onTrigger` is asked whether it applies; if so its `getSuggestions` fill a popup under the cursor
 * (↑/↓ move, Enter/Tab accept, Esc closes) and `selectSuggestion` is called with the chosen value.
 */
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { pluginHost, type EditorSuggestReg } from './pluginHost';

interface Active { reg: EditorSuggestReg; seq: number }

class SuggestDriver {
  active: Active | null = null;
  private seq = 0;
  constructor(readonly view: EditorView) {}

  update(u: ViewUpdate) {
    if (!(u.docChanged || u.selectionSet)) return;
    if (!this.view.hasFocus) { this.close(); return; }
    const regs = pluginHost.editorSuggests();
    if (!regs.length) return;
    const sel = u.state.selection.main;
    if (!sel.empty) { this.close(); return; }
    const line = u.state.doc.lineAt(sel.head);
    const cursor = { line: line.number - 1, ch: sel.head - line.from };
    // The suggest that is already open gets the first look so it can stay open while typing.
    const order = this.active ? [this.active.reg, ...regs.filter((r) => r !== this.active!.reg)] : regs;
    for (const reg of order) {
      let trig: { start: any; end: any; query: string } | null = null;
      try { trig = reg.suggest.onTrigger(cursor, reg.env.editor(), reg.env.file()); } catch { trig = null; }
      if (!trig) continue;
      void this.show(reg, trig, cursor);
      return;
    }
    this.close();
  }

  private async show(reg: EditorSuggestReg, trig: { start: any; end: any; query: string }, _cursor: unknown) {
    const s = reg.suggest;
    const seq = ++this.seq;
    s.context = { editor: reg.env.editor(), file: reg.env.file(), start: trig.start, end: trig.end, query: trig.query };
    let list: unknown[] = [];
    try { list = (await s.getSuggestions(s.context)) ?? []; } catch { list = []; }
    if (seq !== this.seq) return; // a newer keystroke superseded this lookup
    if (!list.length) { this.close(); return; }
    if (this.active && this.active.reg !== reg) this.closeReg(this.active.reg);
    this.active = { reg, seq };
    const off = this.view.state.doc.line(trig.start.line + 1).from + trig.start.ch;
    const c = this.view.coordsAtPos(Math.min(off, this.view.state.doc.length));
    if (c) { s.listEl.style.left = `${c.left}px`; s.listEl.style.top = `${c.bottom + 4}px`; }
    s.open();
    s.setSuggestions(list.slice(0, s.limit ?? 100));
  }

  private closeReg(reg: EditorSuggestReg) { try { reg.suggest.close(); } catch { /* ignore */ } try { reg.suggest.context = null; } catch { /* ignore */ } }
  close() { this.seq++; if (this.active) { this.closeReg(this.active.reg); this.active = null; } }
  destroy() { this.close(); }
}

const driver = ViewPlugin.fromClass(SuggestDriver);

function withDriver(view: EditorView, fn: (d: SuggestDriver, s: any) => boolean): boolean {
  const d = view.plugin(driver);
  if (!d?.active) return false;
  const s = d.active.reg.suggest;
  return s.isOpen ? fn(d, s) : false;
}

const keys = (key: string) => (view: EditorView) =>
  withDriver(view, (d, s) => {
    if (key === 'Escape') { d.close(); return true; }
    const evt = new KeyboardEvent('keydown', { key: key === 'Tab' ? 'Enter' : key });
    const used = s.handleKey(evt);
    if (used && (key === 'Enter' || key === 'Tab')) d.close();
    return used;
  });

export const editorSuggestExtension: Extension = [
  driver,
  Prec.highest(keymap.of(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map((key) => ({ key, run: keys(key) })))),
  EditorView.domEventHandlers({ blur: (_e, view) => { setTimeout(() => view.plugin(driver)?.close(), 150); return false; } }),
];
