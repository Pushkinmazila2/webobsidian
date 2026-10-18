import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as u from '../../web/src/lib/obsidianUtils.ts';

// The examples come from the doc comments in obsidian.d.ts.
test('[obsidian-utils] front matter: info, entries, aliases, tags', () => {
  const content = '---\nkey1: value1\nkey2: value2\n---\nmain content\n';
  const info = u.getFrontMatterInfo(content);
  assert.equal(info.exists, true);
  assert.equal(info.frontmatter, 'key1: value1\nkey2: value2');
  assert.equal(content.slice(info.from, info.to), info.frontmatter);
  assert.equal(content.slice(info.contentStart), 'main content\n');
  assert.deepEqual(u.parseYaml(info.frontmatter), { key1: 'value1', key2: 'value2' });

  assert.equal(u.getFrontMatterInfo('no front matter').exists, false);
  assert.equal(u.getFrontMatterInfo('---\nunterminated: yes\n').exists, false);
  const crlf = u.getFrontMatterInfo('---\r\na: 1\r\n---\r\nbody');
  assert.equal(crlf.exists, true);
  assert.equal(crlf.frontmatter, 'a: 1');
  assert.equal('---\r\na: 1\r\n---\r\nbody'.slice(crlf.contentStart), 'body');
  assert.equal(u.getFrontMatterInfo('---\n---\nbody').exists, true); // empty block

  assert.equal(u.parseFrontMatterEntry({ foo: 'bar' }, 'foo'), 'bar');
  assert.equal(u.parseFrontMatterEntry({ baz: 'qux' }, /ba./), 'qux');
  assert.equal(u.parseFrontMatterEntry({ a: 1 }, 'missing'), null);
  assert.equal(u.parseFrontMatterEntry(null, 'a'), null);
  assert.deepEqual(u.parseFrontMatterStringArray({ foo: ['bar', ' baz '] }, 'foo'), ['bar', 'baz']);
  assert.deepEqual(u.parseFrontMatterStringArray({ foo: 'bar' }, 'foo'), ['bar']);
  assert.equal(u.parseFrontMatterStringArray({}, 'foo'), null);
  assert.deepEqual(u.parseFrontMatterAliases({ aliases: ['foo', 'bar'] }), ['foo', 'bar']);
  assert.deepEqual(u.parseFrontMatterAliases({ alias: 'baz' }), ['baz']);
  assert.equal(u.parseFrontMatterAliases({}), null);
  assert.deepEqual(u.parseFrontMatterTags({ tags: ['foo', '#bar'] }), ['#foo', '#bar']);
  assert.deepEqual(u.parseFrontMatterTags({ tags: 'baz' }), ['#baz']);
  assert.deepEqual(u.parseFrontMatterTags({ tag: 'a, b c' }), ['#a', '#b', '#c']);
  assert.equal(u.parseFrontMatterTags({}), null);
});

test('[obsidian-utils] yaml round trip', () => {
  const obj = { a: 1, list: ['x', 'y'], nested: { ok: true } };
  assert.deepEqual(u.parseYaml(u.stringifyYaml(obj)), obj);
  assert.throws(() => u.parseYaml('a: [unclosed'));
});

test('[obsidian-utils] links and headings', () => {
  assert.deepEqual(u.parseLinktext('foo'), { path: 'foo', subpath: '' });
  assert.deepEqual(u.parseLinktext('foo#bar'), { path: 'foo', subpath: '#bar' });
  assert.deepEqual(u.parseLinktext('foo#^block'), { path: 'foo', subpath: '#^block' });
  assert.equal(u.getLinkpath('foo#bar'), 'foo');
  assert.equal(u.stripHeading('foo!"#$%&()*+,.:;<=>?@^`{|}~/[]\\\r\nbar'), 'foo bar');
  assert.equal(u.stripHeadingForLink('foo:#|^\\\r\n%%[[]]bar'), 'foo bar');
});

test('[obsidian-utils] binary conversions', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.equal(u.arrayBufferToHex(bytes.buffer), '00017f80ff');
  assert.deepEqual([...new Uint8Array(u.hexToArrayBuffer('00017F80ff'))], [0, 1, 127, 128, 255]);
  assert.equal(u.arrayBufferToBase64(bytes.buffer), 'AAF/gP8=');
  assert.deepEqual([...new Uint8Array(u.base64ToArrayBuffer('AAF/gP8='))], [0, 1, 127, 128, 255]);
  const big = new Uint8Array(100_000).map((_, i) => i % 251); // beyond String.fromCharCode's argument limit
  assert.deepEqual(new Uint8Array(u.base64ToArrayBuffer(u.arrayBufferToBase64(big.buffer))), big);
  assert.throws(() => u.hexToArrayBuffer('abc'));
  assert.throws(() => u.hexToArrayBuffer('zz'));
});

test('[obsidian-utils] search: simple, fuzzy, sorting', () => {
  const simple = u.prepareSimpleSearch('hello wor');
  const hit = simple('Hello, world')!;
  assert.deepEqual(hit.matches, [[0, 5], [7, 10]]);
  assert.equal(simple('Hello there'), null, 'every word must match');
  assert.ok(u.prepareSimpleSearch('')('anything'), 'empty query matches');

  const fuzzy = u.prepareFuzzySearch('ntp');
  const m = fuzzy('New Tab Page')!;
  assert.deepEqual(m.matches, [[0, 1], [4, 5], [8, 9]]);
  assert.equal(fuzzy('xyz'), null);
  assert.equal(u.prepareFuzzySearch('ba')('ab'), null, 'order matters');
  // a tight match beats a scattered one
  const tight = u.prepareFuzzySearch('note')('notes')!;
  const loose = u.prepareFuzzySearch('note')('n-o-t-e')!;
  assert.ok(tight.score > loose.score);

  const results = [{ id: 'b', match: { score: -3, matches: [] } }, { id: 'a', match: { score: -1, matches: [] } }, { id: 'c', match: { score: -2, matches: [] } }];
  u.sortSearchResults(results);
  assert.deepEqual(results.map((r) => r.id), ['a', 'c', 'b']);
});

test('[obsidian-utils] versions and property ids', () => {
  assert.equal(u.requireApiVersion('1.0.0'), true);
  assert.equal(u.requireApiVersion(u.API_VERSION), true);
  assert.equal(u.requireApiVersion('99.0.0'), false);
  assert.equal(u.requireApiVersion('1.12.8'), false);
  assert.equal(u.requireApiVersion('1.10.1'), true); // TaskNotes gates its Bases views on this
  assert.deepEqual(u.parsePropertyId('note.author'), { type: 'note', name: 'author' });
  assert.deepEqual(u.parsePropertyId('file.name'), { type: 'file', name: 'name' });
  assert.deepEqual(u.parsePropertyId('formula.total'), { type: 'formula', name: 'total' });
  assert.deepEqual(u.parsePropertyId('author'), { type: 'note', name: 'author' });
});

test('[obsidian-utils] iterateRefs / iterateCacheRefs stop when the callback returns true', () => {
  const seen: number[] = [];
  assert.equal(u.iterateRefs([1, 2, 3], (r) => { seen.push(r); return r === 2; }), true);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(u.iterateRefs([1, 2], () => {}), false);
  const got: string[] = [];
  assert.equal(u.iterateCacheRefs({ links: [{ link: 'a' }], embeds: [{ link: 'b' }] }, (r) => { got.push(r.link); }), false);
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(u.iterateCacheRefs({}, () => true), false);
});

test('[obsidian-utils] processFrontMatterText: edit, add, delete keys; create a block; leave untouched notes alone', () => {
  const note = '---\ntitle: Hi\ntags:\n  - a\n---\n# Body\ntext\n';
  const edited = u.processFrontMatterText(note, (fm) => { fm.title = 'Yo'; fm.tags.push('b'); fm.count = 3; });
  assert.equal(edited, '---\ntitle: Yo\ntags:\n  - a\n  - b\ncount: 3\n---\n# Body\ntext\n');
  assert.equal(u.processFrontMatterText(note, () => {}), note);
  assert.equal(u.processFrontMatterText(note, (fm) => { delete fm.tags; }), '---\ntitle: Hi\n---\n# Body\ntext\n');
  assert.equal(u.processFrontMatterText('# Just a note\n', (fm) => { fm.status = 'done'; }), '---\nstatus: done\n---\n# Just a note\n');
  assert.equal(u.processFrontMatterText('# Just a note\n', () => {}), '# Just a note\n');
  assert.equal(u.processFrontMatterText(note, (fm) => { for (const k of Object.keys(fm)) delete fm[k]; }), '---\n---\n# Body\ntext\n');
  assert.equal(u.processFrontMatterText('---\r\na: 1\r\n---\r\nbody\r\n', (fm) => { fm.a = 2; }), '---\r\na: 2\r\n---\r\nbody\r\n');
  assert.throws(() => u.processFrontMatterText('---\n- a\n- b\n---\nx', () => {}), /mapping/);
  assert.throws(() => u.processFrontMatterText(note, () => { throw new Error('boom'); }), /boom/);
});
