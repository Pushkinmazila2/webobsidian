#!/usr/bin/env node
/**
 * Plugin API compatibility report.
 *
 * Compares Obsidian's public plugin API (obsidian.d.ts from https://github.com/obsidianmd/obsidian-api)
 * with what WebObsidian's browser shim (web/src/lib/obsidianApi.ts) implements, and rates how
 * feasible each missing piece is in a web/server (non-Electron) setting.
 *
 *   git clone --depth 1 https://github.com/obsidianmd/obsidian-api /tmp/obsidian-api
 *   node scripts/plugin-api-report.mjs /tmp/obsidian-api      # writes docs/PLUGIN_API.md + docs/plugin-api-status.json
 *
 * Status of a symbol:  ok = implemented · stub = exists but is a no-op / partial · missing = absent
 * Feasibility of a missing/stub one: easy | medium | hard | impossible (with the reason).
 * The status part is computed from the code; the feasibility notes below are curated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = process.argv[2] ?? '/tmp/obsidian-api';
const dtsFile = path.join(apiDir, 'obsidian.d.ts');
const shimFile = path.join(root, 'web/src/lib/obsidianApi.ts');
const apiVersion = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8')).version;

const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
const isPrivate = (n) => (ts.getCombinedModifierFlags(n) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
const deprecated = (n) => ts.getJSDocTags(n).some((t) => t.tagName.text === 'deprecated');
const memberName = (m) => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null);

// ---- 1. the real API -------------------------------------------------------------------------
const dts = parse(dtsFile);
const api = { classes: new Map(), functions: new Map(), consts: new Map(), interfaces: [], types: [], enums: [] };
for (const n of dts.statements) {
  if (ts.isClassDeclaration(n) && n.name) {
    const members = new Map();
    for (const m of n.members) {
      if (ts.isConstructorDeclaration(m) || isPrivate(m) || m.kind === ts.SyntaxKind.IndexSignature) continue;
      const name = memberName(m);
      if (!name) continue;
      const kind = ts.isMethodDeclaration(m) || ts.isMethodSignature(m) ? 'method' : 'property';
      const stat = (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;
      const key = (stat ? 'static ' : '') + name;
      if (!members.has(key)) members.set(key, { name: key, kind, deprecated: deprecated(m) });
    }
    api.classes.set(n.name.text, { name: n.name.text, extends: n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText(), members, deprecated: deprecated(n) });
  } else if (ts.isFunctionDeclaration(n) && n.name) api.functions.set(n.name.text, { name: n.name.text, deprecated: deprecated(n) });
  else if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) api.consts.set(d.name.getText(), { name: d.name.getText(), deprecated: deprecated(n) });
  else if (ts.isInterfaceDeclaration(n)) api.interfaces.push(n.name.text);
  else if (ts.isTypeAliasDeclaration(n)) api.types.push(n.name.text);
  else if (ts.isEnumDeclaration(n)) api.enums.push(n.name.text);
}

// ---- 2. what we implement --------------------------------------------------------------------
const shim = parse(shimFile);
const ours = { classes: new Map(), exported: new Set(), stubs: new Set() };
const trivial = (body) => {
  if (!body) return false;
  const st = body.statements;
  if (st.length === 0) return true;
  if (st.length === 1 && ts.isReturnStatement(st[0])) {
    const e = st[0].expression;
    return !e || e.kind === ts.SyntaxKind.ThisKeyword || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
  }
  return false;
};
const scanClass = (n) => {
  if (ts.isClassDeclaration(n) && n.name) {
    const members = new Map();
    for (const m of n.members) {
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) if (p.modifiers?.some((x) => x.kind === ts.SyntaxKind.PublicKeyword)) members.set(p.name.getText(), 'ok');
        continue;
      }
      if (isPrivate(m)) continue;
      const name = memberName(m);
      if (!name) continue;
      const stat = (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;
      const fn = ts.isMethodDeclaration(m) ? m.body : ts.isGetAccessor(m) ? m.body : null;
      // Empty lifecycle hooks (onOpen, onunload, display, …) are meant to be overridden: they are complete as they are.
      const hook = /^(on[A-Z]\w*|onload|onunload|display|hide|renderSuggestion|selectSuggestion|setInstructions|setNoIcon|setUseNativeMenu|setParentElement|getDoc|setValue)$/.test(name);
      members.set((stat ? 'static ' : '') + name, fn && trivial(fn) && !hook ? 'stub' : 'ok');
    }
    ours.classes.set(n.name.text, { extends: n.heritageClauses?.[0]?.types[0]?.expression.getText(), members });
  }
};
for (const n of shim.statements) {
  scanClass(n);
  if (ts.isVariableStatement(n) || ts.isFunctionDeclaration(n)) {
    const names = ts.isFunctionDeclaration(n) ? [n.name?.text] : n.declarationList.declarations.map((d) => d.name.getText());
    for (const nm of names) if (nm) ours.exported.add(nm);
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) {
      const init = d.initializer;
      if (init && ts.isArrowFunction(init) && ts.isBlock(init.body) && trivial(init.body)) ours.stubs.add(d.name.getText());
      // An API class that the shim implements as a plain object holding its static methods
      // (MarkdownRenderer): its methods count as that class's static members.
      if (init && ts.isObjectLiteralExpression(init) && api.classes.has(d.name.getText())) {
        const members = new Map();
        for (const p of init.properties) {
          const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
          if (!name) continue;
          const body = ts.isMethodDeclaration(p) ? p.body
            : ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) ? p.initializer.body : null;
          members.set(`static ${name}`, body && ts.isBlock(body) && trivial(body) ? 'stub' : 'ok');
        }
        ours.classes.set(d.name.getText(), { extends: undefined, members });
      }
    }
  }
}
// Bases classes live inside createBasesApi() in bases/api.ts (nested, so not top-level statements)
const basesSrc = ts.createSourceFile('b.ts', fs.readFileSync(path.join(root, 'web/src/lib/bases/api.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const basesKeys = new Set();
const walkBases = (n) => {
  scanClass(n);
  if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression) && n.getSourceFile() === basesSrc) {
    for (const p of n.expression.properties) if (p.name) basesKeys.add(p.name.getText());
  }
  ts.forEachChild(n, walkBases);
};
walkBases(basesSrc);
// names reachable through require('obsidian'): the keys of rawModule
const mod = shim.statements.find((n) => ts.isVariableStatement(n) && n.declarationList.declarations[0].name.getText() === 'rawModule');
const moduleKeys = new Set();
for (const p of mod.declarationList.declarations[0].initializer.properties) {
  if (p.name) moduleKeys.add(p.name.getText());
  else if (ts.isSpreadAssignment(p) && p.expression.getText() === 'basesApi') { for (const k of basesKeys) moduleKeys.add(k); }
  else if (ts.isSpreadAssignment(p) && p.expression.getText() === 'utils') {
    // `...utils`: every export of obsidianUtils.ts is reachable through require('obsidian')
    const src = ts.createSourceFile('u.ts', fs.readFileSync(path.join(root, 'web/src/lib/obsidianUtils.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const n of src.statements) {
      if (!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export)) continue;
      if (ts.isVariableStatement(n)) n.declarationList.declarations.forEach((d) => moduleKeys.add(d.name.getText()));
      else if (ts.isFunctionDeclaration(n) && n.name) moduleKeys.add(n.name.getText());
    }
    moduleKeys.add('apiVersion');
  }
}

// ---- 3. things that are partial rather than complete, or reached through instances ----------
// (not detectable from the code shape)
const PARTIAL = new Set([
  'moment', 'Workspace.getLeaf', 'Workspace.getMostRecentLeaf', 'Workspace.getActiveViewOfType',
  'Vault.adapter', 'Platform', 'setIcon', 'requestUrl',
]);
const provided = {
  // classes plugins receive as app.metadataCache / app.fileManager (we expose a reduced object)
};

// Plugins reach the vault's disk adapter through `app.vault.adapter`, which in WebObsidian is the shim's `DataAdapter`.
// The real FileSystemAdapter / CapacitorAdapter classes do not exist here (so `instanceof FileSystemAdapter` has no
// right-hand side), but their *methods* are what plugins call on `vault.adapter`, so those are judged against DataAdapter.
const ADAPTER_ALIAS = { FileSystemAdapter: 'DataAdapter', CapacitorAdapter: 'DataAdapter' };

function ourMember(cls, member) {
  const key = `${cls}.${member}`;
  if (provided[cls]) return provided[cls].ok.includes(member) ? 'ok' : provided[cls].stub.includes(member) ? 'stub' : 'missing';
  for (let c = ours.classes.get(ADAPTER_ALIAS[cls] ?? cls), guard = 0; c && guard < 10; c = ours.classes.get(c.extends), guard++) {
    if (c.members.has(member)) return PARTIAL.has(key) ? 'stub' : c.members.get(member);
  }
  return 'missing';
}

// ---- 4. curated feasibility ---------------------------------------------------------------------
const E = 'easy', M = 'medium', H = 'hard', X = 'impossible';
/** [class-name regex, level, why]. First match wins. Members inherit; MEMBER_RULES override. */
const CLASS_RULES = [
  [/^(FileSystemAdapter|CapacitorAdapter)$/, X, 'Node/Electron filesystem or device adapter. The vault may live in GitHub, and a browser has no disk path.'],
  [/^(Bases.*|.*Value|Value|QueryController|PrimitiveValue|ListValue|ObjectValue|NullValue|NotNullValue)$/, H, 'Bases (database views over notes). Needs a query engine, a properties index and a table/board UI that WebObsidian does not have.'],
  [/^Workspace(Container|Floating|Item|Parent|Root|Sidedock|Split|Tabs|Window|MobileDrawer|Ribbon)$/, H, 'Obsidian pane/leaf tree (splits, tabs, side docks, pop-out windows). WebObsidian has its own simpler layout; a facade over it is possible only for the common calls.'],
  [/^WorkspaceLeaf$/, H, 'Leaves host arbitrary views; WebObsidian tabs do not expose a view container to plugins.'],
  [/^(View|ItemView|FileView|EditableFileView|TextFileView)$/, M, 'Custom views: doable by giving each plugin view a React host container and a tab; needs registerView + leaf facade.'],
  [/^(MarkdownEditView|MarkdownPreviewView)$/, H, 'Internal editor/preview view objects; our editor is a single CodeMirror view and a separate renderer.'],
  [/^HoverPopover$/, M, 'Popover UI is easy; hooking into link hover needs the preview pipeline.'],
  [/^(MetadataCache)$/, M, 'The server already parses notes for search/links; getFileCache needs section/heading/link positions and change events exposed to the browser.'],
  [/^(MarkdownRenderer|MarkdownPreviewRenderer|MarkdownRenderChild|RenderContext)$/, M, 'We have a Markdown pipeline (renderMarkdown); expose it and run plugin post-processors on its output.'],
  [/^(SuggestModal|FuzzySuggestModal|PopoverSuggest|AbstractInputSuggest|ConfirmationModal|ConfirmationButton)$/, E, 'Plain overlay UI on top of the Modal we already have.'],
  [/^EditorSuggest$/, M, 'Needs a CodeMirror autocomplete source driven by the plugin.'],
  [/^(Keymap|Scope)$/, M, 'Hotkeys: we have a global key handler; needs scopes and per-command hotkeys.'],
  [/^(SecretStorage|SecretComponent)$/, M, 'Server-side secret store plus a masked input; no OS keychain on the server.'],
  [/^(Setting|SettingGroup|SettingPage|SettingTab|.*Component|ColorComponent|SearchComponent|ProgressBarComponent|MomentFormatComponent|DisplayValueComponent|AbstractTextComponent|BaseComponent|ValueComponent)$/, E, 'Plain DOM widgets.'],
  [/^(Menu|MenuItem|MenuSeparator)$/, E, 'Maps onto our context menu.'],
  [/^(Editor)$/, E, 'Thin wrapper over CodeMirror 6, which we already use.'],
  [/^(Vault|TFile|TFolder|TAbstractFile|TExternalFile)$/, E, 'Backed by the files API; events come from the WebSocket change feed.'],
  [/^FileManager$/, E, 'Thin helpers over the files API (link generation, attachment paths, delete prompt).'],
  [/^PluginSettingTab$/, E, 'Settings-tab variants (definitions API) are plain DOM.'],
  [/^(Events|Component|Plugin|App|Notice|Modal|Tasks)$/, E, 'Core object; remaining members are small.'],
  [/^(MarkdownView)$/, M, 'Needs reading/live-preview modes and the leaf facade behind it.'],
];
/** Member-level overrides: 'Class.member' → [level, why] */
const MEMBER_RULES = {
  'Vault.adapter': [M, 'DataAdapter over the files API (read/write/list/exists/mkdir/rename/stat/remove).'],
  'Vault.getResourcePath': [E, 'Return our /api/files/content URL.'],
  'Vault.configDir': [E, 'Constant ".obsidian".'],
  'Vault.getConfig': [E, 'Read from .obsidian/app.json.'],
  'Plugin.registerEditorExtension': [M, 'Possible because the editor is CodeMirror 6, but plugins import @codemirror/* — those modules must be provided to require() at the same version.'],
  'Plugin.registerView': [M, 'See View: needs a React host container for the plugin view.'],
  'Plugin.registerMarkdownPostProcessor': [M, 'Run processors on rendered preview / live-preview HTML.'],
  'Plugin.registerMarkdownCodeBlockProcessor': [M, 'Same hook, selected by code-block language.'],
  'Plugin.registerExtensions': [M, 'Needs file-type → view mapping.'],
  'Plugin.registerObsidianProtocolHandler': [X, 'obsidian:// URLs are handled by the desktop app, not by a web page.'],
  'Plugin.registerHoverLinkSource': [M, 'Needs the link-hover preview pipeline.'],
  'Plugin.addCommand': [E, 'Implemented; hotkeys on commands are not.'],
  'Plugin.onUserEnable': [E, 'Call it when the user enables the plugin.'],
  'Plugin.onExternalSettingsChange': [E, 'Call it when data.json changes (we already poll plugin state).'],
  'App.isMobile': [E, 'Static value.'],
  'App.secretStorage': [M, 'See SecretStorage.'],
  'App.loadLocalStorage': [E, 'Prefix localStorage per vault.'],
  'App.saveLocalStorage': [E, 'Prefix localStorage per vault.'],
  'App.openWithDefaultApp': [X, 'Opens a file in the OS default program — not possible from a web page.'],
  'FileManager.processFrontMatter': [M, 'Parse/write YAML front matter on the client; round-trip must keep comments/ordering.'],
  'FileManager.getNewFileParent': [E, 'Follow the attachment/new-note folder settings.'],
  'Workspace.getLeaf': [H, 'Only a facade that opens a file is realistic.'],
  'Editor.cm': [M, 'Expose our EditorView (plugins expect a specific CM6 build).'],
  'Notice.messageEl': [E, 'Expose the notice body element.'],
};
const FUNC_RULES = {
  requestUrl: [M, 'Browsers enforce CORS, so the request has to go through a server proxy (with SSRF limits).'],
  request: [M, 'Same as requestUrl.'],
  moment: [M, 'Bundle the real moment (≈70 KB) instead of the stub.'],
  loadMathJax: [M, 'We ship KaTeX, not MathJax; either bundle MathJax or alias to KaTeX.'],
  renderMath: [M, 'Via KaTeX.'], finishRenderMath: [M, 'Via KaTeX.'],
  loadMermaid: [E, 'Mermaid is already bundled.'],
  loadPdfJs: [M, 'Bundle pdf.js lazily.'],
  loadPrism: [M, 'We highlight with CodeMirror/lowlight, not Prism; bundle Prism lazily.'],
  getAllTags: [M, 'Needs MetadataCache.'], iterateCacheRefs: [M, 'Needs MetadataCache.'], iterateRefs: [M, 'Needs MetadataCache.'],
  resolveSubpath: [M, 'Needs MetadataCache (headings/blocks).'],
  setIcon: [M, 'Works, but we only ship part of the Lucide set; add the rest on demand.'],
  getIcon: [M, 'Same.'], getIconIds: [M, 'Same.'], addIcon: [E, 'Register custom SVG in the icon table.'], removeIcon: [E, 'Same.'],
  displayTooltip: [E, 'Small overlay.'], setTooltip: [E, 'title attribute / small overlay.'],
  htmlToMarkdown: [M, 'Needs an HTML→Markdown converter (e.g. turndown).'],
  getLanguage: [E, 'navigator.language / UI setting.'], requireApiVersion: [E, 'Compare with the version we declare.'],
  stringifyYaml: [E, 'Bundle a YAML library; parseYaml currently handles JSON only.'], parseYaml: [E, 'Bundle a YAML library.'],
};
const CONST_RULES = {
  apiVersion: [E, 'A constant.'], moment: FUNC_RULES.moment, Platform: [E, 'Plain object of booleans (present).'],
  editorEditorField: [M, 'CM6 state fields — need the same @codemirror/state build as the plugin.'], editorInfoField: [M, 'Same.'],
  editorLivePreviewField: [M, 'Same.'], editorViewField: [M, 'Same.'], livePreviewState: [M, 'Same.'],
};
function classFeas(name, member) {
  const m = MEMBER_RULES[`${name}.${member}`];
  if (m) return m;
  for (const [re, lvl, why] of CLASS_RULES) if (re.test(name)) return [lvl, why];
  return [M, 'Not yet analysed.'];
}

// ---- 5. compute ------------------------------------------------------------------------------------
const rows = { classes: [], functions: [], consts: [] };
const totals = { ok: 0, stub: 0, missing: 0 };
const feasTotals = { easy: 0, medium: 0, hard: 0, impossible: 0 };
const bump = (st, feas) => { totals[st]++; if (st !== 'ok') feasTotals[feas]++; };

for (const c of api.classes.values()) {
  const exported = moduleKeys.has(c.name);
  const members = [...c.members.values()].map((m) => {
    const bare = m.name.replace(/^static /, '');
    const st = exported || provided[c.name] || ADAPTER_ALIAS[c.name] ? ourMember(c.name, m.name) : 'missing';
    const [level, why] = st === 'ok' ? [null, ''] : classFeas(c.name, bare);
    bump(st, level);
    // stubKind: "partial" = works with known limits (curated PARTIAL list), "noop" = present but does nothing.
    return { ...m, status: st, ...(st === 'stub' ? { stubKind: PARTIAL.has(`${c.name}.${bare}`) ? 'partial' : 'noop' } : {}), feasibility: level, note: why };
  });
  const classStatus = !exported && !provided[c.name] ? 'missing' : 'ok';
  const [classLevel, classWhy] = classFeas(c.name, '');
  if (!exported && !provided[c.name]) bump('missing', classLevel); // the class itself
  rows.classes.push({ name: c.name, extends: c.extends, deprecated: c.deprecated, classStatus, feasibility: classLevel, note: classWhy, members });
}
for (const f of api.functions.values()) {
  const impl = moduleKeys.has(f.name);
  const st = !impl ? 'missing' : PARTIAL.has(f.name) || ours.stubs.has(f.name) ? 'stub' : 'ok';
  const [level, why] = st === 'ok' ? [null, ''] : FUNC_RULES[f.name] ?? [E, 'Pure helper.'];
  bump(st, level);
  rows.functions.push({ ...f, status: st, ...(st === 'stub' ? { stubKind: PARTIAL.has(f.name) ? 'partial' : 'noop' } : {}), feasibility: level, note: why });
}
for (const f of api.consts.values()) {
  const impl = moduleKeys.has(f.name);
  const st = !impl ? 'missing' : PARTIAL.has(f.name) ? 'stub' : 'ok';
  const [level, why] = st === 'ok' ? [null, ''] : CONST_RULES[f.name] ?? [E, 'Constant.'];
  bump(st, level);
  rows.consts.push({ ...f, status: st, ...(st === 'stub' ? { stubKind: 'partial' } : {}), feasibility: level, note: why });
}

// ---- 6. write ----------------------------------------------------------------------------------------------
const ICON = { ok: '✅', stub: '🟡', missing: '❌' };
const total = totals.ok + totals.stub + totals.missing;
const pct = (n) => ((100 * n) / total).toFixed(1) + '%';
let md = `# Obsidian plugin API — what WebObsidian supports

> Generated by \`scripts/plugin-api-report.mjs\` from \`obsidian.d.ts\` (obsidian-api **${apiVersion}**) and the shim in
> \`web/src/lib/obsidianApi.ts\`. Do not edit by hand: change the code (status) or the curated notes in the script (feasibility),
> then re-run it. Status is read from the code; feasibility ratings are our judgement of what is realistic in a web + server
> (non-Electron) product, including vaults that live in GitHub rather than on disk.

**Legend.** ✅ implemented · 🟡 exists but is a no-op or partial · ❌ missing.
Feasibility of what is not ✅: **easy** (hours) · **medium** (a feature) · **hard** (a subsystem, or a UI WebObsidian does not have) · **impossible** (needs Electron/Node/OS or desktop-only behaviour).

## Summary

| | count | share |
|---|---:|---:|
| ✅ implemented | ${totals.ok} | ${pct(totals.ok)} |
| 🟡 stub / partial | ${totals.stub} | ${pct(totals.stub)} |
| ❌ missing | ${totals.missing} | ${pct(totals.missing)} |
| **runtime API items** (class members, functions, constants, missing classes) | **${total}** | |

Not yet working (🟡 + ❌), by feasibility: **easy ${feasTotals.easy}** · **medium ${feasTotals.medium}** · **hard ${feasTotals.hard}** · **impossible ${feasTotals.impossible}**.
${api.interfaces.length} interfaces, ${api.types.length} type aliases and ${api.enums.length} enum(s) are type-only (no runtime behaviour) and are not counted.

What typical plugins need first (a plugin is usable once these exist): commands ✅, settings tab ✅, \`loadData/saveData\` ✅, ribbon ✅, status bar ✅, modals ✅, notices ✅, editor commands ✅ —
then **MetadataCache**, **markdown post-processors**, **custom views**, **editor extensions**, **\`requestUrl\` via a server proxy**.

## Things that cannot work in WebObsidian (and why)

`;
const impossible = [];
for (const c of rows.classes) {
  if (c.feasibility === 'impossible') impossible.push(`- **${c.name}** — ${c.note}`);
  for (const m of c.members) if (m.feasibility === 'impossible' && c.feasibility !== 'impossible') impossible.push(`- **${c.name}.${m.name.replace('static ', '')}** — ${m.note}`);
}
for (const f of [...rows.functions, ...rows.consts]) if (f.feasibility === 'impossible') impossible.push(`- **${f.name}** — ${f.note}`);
impossible.push('- **Node/Electron modules** (`require("fs")`, `"path"`, `"electron"`, `child_process`, …) — not part of obsidian.d.ts, but many desktop-only plugins call them. A page cannot run them; such plugins show "unsupported module" and stay off. Plugins with `isDesktopOnly: true` are the likely casualties.');
impossible.push('- **Other plugins\' internals** (`app.plugins.plugins[...]`, `app.internalPlugins`) — undocumented; reachable only if we imitate them.');
md += impossible.join('\n') + '\n\n';

const byLevel = (lvl) => {
  const out = [];
  for (const c of rows.classes) {
    if (c.classStatus === 'missing' && c.feasibility === lvl) out.push(`- **${c.name}** (class) — ${c.note}`);
    const ms = c.members.filter((m) => m.status !== 'ok' && m.feasibility === lvl && !(c.classStatus === 'missing' && c.feasibility === lvl));
    const byNote = new Map();
    for (const m of ms) byNote.set(m.note, [...(byNote.get(m.note) ?? []), m]);
    for (const [note, list] of byNote) out.push(`- **${c.name}**: ${list.map((m) => '`' + m.name.replace('static ', '') + '`').join(', ')} — ${note}`);
  }
  for (const f of [...rows.functions, ...rows.consts]) if (f.status !== 'ok' && f.feasibility === lvl) out.push(`- **${f.name}** — ${f.note}`);
  return out;
};
for (const [lvl, title] of [[E, 'Easy'], [M, 'Medium'], [H, 'Hard']]) {
  const items = byLevel(lvl);
  md += `## ${title} — not done yet (${items.length} entries)\n\n${items.join('\n')}\n\n`;
}

md += `## Per-symbol detail\n\nOne line per class: ✅ implemented members, 🟡 stubs, ❌ missing. Deprecated members are marked *(dep.)*.\n\n`;
const fmt = (ms) => ms.map((m) => '`' + m.name.replace('static ', 'static·') + '`' + (m.deprecated ? '*(dep.)*' : '')).join(' ');
for (const c of rows.classes) {
  const ok = c.members.filter((m) => m.status === 'ok'), st = c.members.filter((m) => m.status === 'stub'), mi = c.members.filter((m) => m.status === 'missing');
  md += `### ${ICON[c.classStatus === 'missing' ? 'missing' : mi.length || st.length ? 'stub' : 'ok']} ${c.name}${c.extends ? ` <small>extends ${c.extends}</small>` : ''}${c.deprecated ? ' *(deprecated)*' : ''}\n`;
  if (c.classStatus === 'missing') md += `Class not provided. Feasibility: **${c.feasibility}** — ${c.note}\n\n`;
  if (ok.length) md += `- ✅ ${fmt(ok)}\n`;
  if (st.length) md += `- 🟡 ${fmt(st)}\n`;
  if (mi.length) md += `- ❌ ${fmt(mi)}\n`;
  md += '\n';
}
md += `### Functions and constants\n\n| name | status | feasibility | note |\n|---|---|---|---|\n`;
for (const f of [...rows.functions, ...rows.consts]) md += `| \`${f.name}\`${f.deprecated ? ' *(dep.)*' : ''} | ${ICON[f.status]} | ${f.feasibility ?? ''} | ${f.note} |\n`;
md += `\n### Type-only declarations (no runtime)\n\nInterfaces: ${api.interfaces.map((x) => '`' + x + '`').join(', ')}\n\nTypes: ${api.types.map((x) => '`' + x + '`').join(', ')}\n\nEnums: ${api.enums.map((x) => '`' + x + '`').join(', ')}\n`;

fs.writeFileSync(path.join(root, 'docs/PLUGIN_API.md'), md);
fs.writeFileSync(path.join(root, 'docs/plugin-api-status.json'), JSON.stringify({ apiVersion, totals, feasibility: feasTotals, ...rows }, null, 1));
console.log(`obsidian-api ${apiVersion}: ${total} items — ok ${totals.ok} (${pct(totals.ok)}), stub ${totals.stub}, missing ${totals.missing}`);
console.log('not done, by feasibility:', feasTotals);
