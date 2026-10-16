import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBase, runView, BaseContext, summarize, type BaseFile } from '../../web/src/lib/bases/engine.ts';
import { parseExpression, evaluate, type Scope } from '../../web/src/lib/bases/expr.ts';
import { BDate, BLink, BError, parseDuration, parseDate, display } from '../../web/src/lib/bases/values.ts';

const day = 864e5;
const mk = (path: string, fm: Record<string, unknown> = {}, extra: Partial<BaseFile> = {}): BaseFile => {
  const name = path.split('/').pop()!;
  return {
    path, name, basename: name.replace(/\.[^.]+$/, ''), ext: name.includes('.') ? name.split('.').pop()! : '',
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', size: 100, ctime: Date.UTC(2024, 0, 1), mtime: Date.UTC(2024, 0, 2),
    tags: [], links: [], embeds: [], frontmatter: fm, ...extra,
  };
};
const files: BaseFile[] = [
  mk('Books/Dune.md', { author: '[[Herbert]]', rating: 5, pages: 412, status: 'done', read: '2024-03-10', genres: ['scifi', 'classic'] }, { tags: ['book', 'fav'] }),
  mk('Books/Emma.md', { rating: 3, pages: 320, status: 'reading', read: '2024-05-01', genres: ['classic'] }, { tags: ['book'], links: ['Herbert'] }),
  mk('Books/Neuromancer.md', { rating: 4, pages: 271, status: 'done', genres: ['scifi'] }, { tags: ['book'] }),
  mk('People/Herbert.md', { born: 1920 }),
  mk('Notes/Idea.md', {}, { tags: ['idea'] }),
  mk('pic.png', {}, { size: 5000 }),
  mk('.obsidian/app.json', {}),
];
const resolve = (l: string) => files.find((f) => f.basename === l.replace(/^\[\[|\]\]$/g, '') || f.path === l)?.path ?? null;
const ctx = () => new BaseContext({ files, resolve });
const ev = (src: string, file = files[0], c = ctx()) => evaluate(parseExpression(src), c.scope(file, file) as Scope);
const names = (r: { rows: { file: BaseFile }[] }) => r.rows.map((x) => x.file.basename);

test('[bases] expressions: arithmetic, strings, lists, booleans', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('10 % 4'), 2);
  assert.equal(ev('"a" + "b"'), 'ab');
  assert.equal(ev('"Hello".lower()'), 'hello');
  assert.equal(ev('"abc".length'), 3);
  assert.equal(ev('"a,b".split(",").length'), 2);
  assert.equal(ev('[1,2,3].map(value * 2).join("-")'), '2-4-6');
  assert.deepEqual(ev('[1,2,3,4].filter(value > 2)'), [3, 4]);
  assert.equal(ev('[1,2,3].reduce(acc + value, 0)'), 6);
  assert.equal(ev('if(1 > 2, "x", "y")'), 'y');
  assert.equal(ev('true && !false'), true);
  assert.equal(ev('null || "d"'), 'd');
  assert.equal(ev('(3.14159).toFixed(2)'), '3.14');
  assert.equal(ev('max(1, 5, 3)'), 5);
  assert.equal(ev('"x".replace(/x/, "y")'), 'y');
});

test('[bases] properties: note, file, formula, links, tags', () => {
  assert.equal(ev('rating'), 5);
  assert.equal(ev('note.pages'), 412);
  assert.equal(ev('note["pages"]'), 412);
  assert.equal(ev('file.name'), 'Dune.md');
  assert.equal(ev('file.ext'), 'md');
  assert.equal(ev('file.folder'), 'Books');
  assert.equal(ev('file.hasTag("book")'), true);
  assert.equal(ev('file.hasTag("nope")'), false);
  assert.equal(ev('file.inFolder("Books")'), true);
  assert.equal(ev('file.inFolder("People")'), false);
  assert.equal(ev('file.hasProperty("rating")'), true);
  assert.equal(ev('genres.contains("scifi")'), true);
  assert.equal(ev('genres.containsAny("x", "classic")'), true);
  const link = ev('author') as BLink;
  assert.ok(link instanceof BLink);
  assert.equal(link.path, 'People/Herbert.md');
  assert.equal(ev('author.asFile().born'), 1920);
  assert.equal(ev('file.backlinks.length', files[3]), 1);   // Emma links to Herbert
  assert.equal(ev('missing'), null);
  assert.equal(ev('missing.isEmpty()'), true);
});

test('[bases] dates and durations', () => {
  assert.ok(parseDuration('1d')!.ms === day);
  assert.ok(parseDuration('2 weeks')!.ms === 14 * day);
  assert.equal(parseDuration('nope'), null);
  assert.equal(ev('read.year'), 2024);
  assert.equal(ev('read.format("YYYY/MM/DD")'), '2024/03/10');
  assert.equal(ev('(date("2024-03-11") - date("2024-03-10")).days'), 1);
  assert.equal(display(ev('date("2024-03-10") + "1d"')), '2024-03-11');
  assert.equal(display(ev('date("2024-03-10") + "1M"')), '2024-04-10');
  assert.equal(ev('read > date("2024-01-01")'), true);
  assert.equal(ev('read > "2024-12-01"'), false);
  assert.equal(ev('file.mtime > file.ctime'), true);
  assert.ok(ev('today()') instanceof BDate);
  // a YAML date arriving as an ISO instant is a plain date
  assert.equal(parseDate('2024-01-05T00:00:00.000Z')!.dateOnly, true);
});

test('[bases] errors become values, not exceptions', () => {
  assert.throws(() => parseExpression('1 +'), /Unexpected end/);
  const c = ctx();
  const r = runView({ formulas: { bad: 'nope(1)' }, views: [{ type: 'table', order: ['formula.bad'] }] }, 0, c, null);
  assert.ok(r.rows[0].get('formula.bad') instanceof BError);
});

test('[bases] view: filters (and/or/not), formulas, sort, limit, groupBy', () => {
  const cfg = parseBase(`
filters:
  and:
    - file.inFolder("Books")
formulas:
  perPage: rating / pages * 100
  label: 'if(status == "done", "✓ " + file.basename, file.basename)'
views:
  - type: table
    name: Books
    order: [file.name, rating, formula.perPage]
    sort:
      - property: rating
        direction: DESC
  - type: list
    filters:
      or:
        - status == "reading"
        - 'rating >= 5'
  - type: table
    filters:
      not:
        - status == "done"
  - type: cards
    sort: [{ property: pages, direction: ASC }]
    limit: 2
  - type: table
    groupBy: { property: status, direction: ASC }
`);
  let r = runView(cfg, 0, ctx(), null);
  assert.deepEqual(names(r), ['Dune', 'Neuromancer', 'Emma']);
  assert.equal(r.columns[2].name, 'perPage');
  assert.equal(Math.round(r.rows[0].get('formula.perPage') as number * 1000) / 1000, 1.214);
  assert.equal(r.rows[0].get('formula.label'), '✓ Dune');
  r = runView(cfg, 1, ctx(), null);
  assert.deepEqual(names(r).sort(), ['Dune', 'Emma']);
  r = runView(cfg, 2, ctx(), null);
  assert.deepEqual(names(r), ['Emma']);
  r = runView(cfg, 3, ctx(), null);
  assert.deepEqual(names(r), ['Neuromancer', 'Emma']);   // by pages asc, limit 2
  assert.equal(r.total, 3);
  r = runView(cfg, 4, ctx(), null);
  assert.deepEqual(r.groups!.map((g) => [g.key, g.rows.length]), [['done', 2], ['reading', 1]]);
});

test('[bases] no filters lists every visible file; hidden folders and bad filters are handled', () => {
  const r = runView(parseBase('views:\n  - type: table\n'), 0, ctx(), null);
  assert.equal(r.rows.length, 6);                       // .obsidian/app.json excluded
  assert.deepEqual(r.columns[0], { id: 'file.name', name: 'Name' });
  const bad = runView(parseBase('filters: "rating >"\nviews:\n  - type: table\n'), 0, ctx(), null);
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.throws(() => parseBase('- a\n- b'), /mapping/);
  assert.equal(parseBase('').views!.length, 0);
});

test('[bases] this refers to the embedding / base file', () => {
  const c = ctx();
  const cfg = parseBase('filters: \'file.hasLink(this.file)\'\nviews:\n  - type: table\n');
  const r = runView(cfg, 0, c, files.find((f) => f.basename === 'Herbert')!);
  assert.deepEqual(names(r), ['Emma']);
});

test('[bases] summaries', () => {
  const c = ctx();
  assert.equal(summarize('Sum', [1, 2, 3], c, {}), 6);
  assert.equal(summarize('Average', [1, 2, 3], c, {}), 2);
  assert.equal(summarize('Median', [1, 5, 3, 4], c, {}), 3.5);
  assert.equal(summarize('Filled', [1, null, ''], c, {}), 1);
  assert.equal(summarize('Unique', ['a', 'a', 'b'], c, {}), 2);
  const r = runView(parseBase('filters: file.inFolder("Books")\nviews:\n  - type: table\n    summaries: { pages: Sum, rating: Average }\n'), 0, c, null);
  assert.equal(r.summaries['note.pages'], 1003);
  assert.equal(r.summaries['note.rating'], 4);
});
