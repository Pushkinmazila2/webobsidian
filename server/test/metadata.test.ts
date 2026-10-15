import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetadata } from '../src/services/metadata.ts';

const doc = [
  '---', 'title: Hi', 'tags: [a, b]', '---',
  '# Heading One', '',
  'Text with [[Other Note|alias]] and ![[img.png]] and #tag1 and `#notatag [[nolink]]`.', '',
  '- item one', '  - [ ] sub task', '  - [x] done task ^blk', '- item two', '',
  '```js', '# not a heading [[nolink2]] #nottag', '```', '',
  '## Second', '[md](notes/other.md) [ext](https://x.y) #nested/tag', '',
  '> [!note] callout', '',
].join('\n');

test('[metadata] front matter, headings, links, embeds, tags', () => {
  const m = computeMetadata(doc);
  assert.deepEqual(m.frontmatter, { title: 'Hi', tags: ['a', 'b'] });
  assert.equal(m.frontmatterPosition!.start.line, 0);
  assert.equal(m.frontmatterPosition!.end.line, 3);
  assert.deepEqual(m.headings!.map((h) => [h.heading, h.level, h.position.start.line]), [['Heading One', 1, 4], ['Second', 2, 17]]);
  assert.deepEqual(m.links!.map((l) => [l.link, l.displayText]), [['Other Note', 'alias'], ['notes/other.md', 'md']]);
  assert.deepEqual(m.embeds!.map((l) => l.link), ['img.png']);
  assert.deepEqual(m.tags!.map((t) => t.tag), ['#tag1', '#nested/tag']);
  const t = m.tags![0];
  assert.equal(doc.slice(t.position.start.offset, t.position.end.offset), '#tag1');
});

test('[metadata] list items, tasks, parents, sections, blocks', () => {
  const m = computeMetadata(doc);
  const li = m.listItems!;
  assert.equal(li.length, 4);
  assert.equal(li[0].parent, -8); // root list starting on line 8
  assert.equal(li[1].task, ' ');
  assert.equal(li[1].parent, 8);
  assert.equal(li[2].task, 'x');
  assert.equal(li[3].parent, -8);
  assert.deepEqual(m.sections!.map((s) => s.type), ['yaml', 'heading', 'paragraph', 'list', 'code', 'heading', 'paragraph', 'callout']);
  assert.ok(m.blocks!.blk);
  assert.equal(computeMetadata('plain').frontmatter, undefined);
});
