import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getAclStore, getUserStore, levelNum, type Level } from '../src/db/index.js';
import { refreshAcl, levelFor, vaultAccessible, principalFor, compileRule, type Principal } from '../src/services/acl.js';

const V = 'default';
const L = (n: number): string => ['none', 'read', 'comment', 'write', 'manage'][n];
let alice: Principal, bob: Principal, admin: Principal;
let editors = '', staff = '';

const rule = async (subjectType: 'user' | 'group' | 'everyone', subjectId: string | null, pattern: string, level: Level, effect: 'allow' | 'deny' = 'allow') => {
  await getAclStore().createRule({ vaultId: V, subjectType, subjectId, pattern, level, effect });
  await refreshAcl();
};
const reset = async () => {
  for (const r of await getAclStore().listRules(V)) await getAclStore().deleteRule(r.id);
  await getAclStore().setDefault(V, 'none');
  await refreshAcl();
};
const lv = (p: Principal, rel: string) => L(levelFor(p, V, rel));

before(async () => {
  const users = await initDb('sqlite::memory:');
  const a = await users.createUser({ username: 'alice' });
  const b = await users.createUser({ username: 'bob' });
  const ad = await users.createUser({ username: 'root', isAdmin: true });
  editors = (await users.createGroup({ name: 'editors' })).id;
  staff = (await users.createGroup({ name: 'staff' })).id;
  await users.addMember(editors, a.id);
  await users.addMember(staff, a.id);
  await users.addMember(staff, b.id);
  alice = await principalFor(a);
  bob = await principalFor(b);
  admin = await principalFor(ad);
});
after(async () => closeDb());

test('administrators always manage; the system (no principal) is unrestricted', async () => {
  await reset();
  assert.equal(lv(admin, 'anything/at/all.md'), 'manage');
  assert.equal(L(levelFor(null, V, 'x.md')), 'manage');
});

test('default is none; the vault default applies where no rule matches', async () => {
  await reset();
  assert.equal(lv(alice, 'Notes/a.md'), 'none');
  assert.equal(vaultAccessible(alice, V), false);
  await getAclStore().setDefault(V, 'read');
  await refreshAcl();
  assert.equal(lv(alice, 'Notes/a.md'), 'read');
  assert.equal(vaultAccessible(alice, V), true);
});

test('most specific rule wins: a deeper allow reopens what a broader deny closed', async () => {
  await reset();
  await rule('everyone', null, '', 'write'); // whole vault
  await rule('group', staff, 'HR', 'read', 'deny'); // HR: no access at all (deny read caps below read)
  await rule('user', alice.userId, 'HR/Public', 'read'); // …except HR/Public for alice
  assert.equal(lv(alice, 'Notes/a.md'), 'write');
  assert.equal(lv(alice, 'HR/salaries.md'), 'none');
  assert.equal(lv(alice, 'HR/Public/handbook.md'), 'read');
  assert.equal(lv(bob, 'HR/Public/handbook.md'), 'none', 'the allow was for alice only');
});

test('within one tier deny beats allow; several allows take the highest', async () => {
  await reset();
  await rule('group', editors, 'Docs', 'write');
  await rule('group', staff, 'Docs', 'read');
  assert.equal(lv(alice, 'Docs/x.md'), 'write', 'alice is in both groups: highest allow');
  assert.equal(lv(bob, 'Docs/x.md'), 'read');
  await rule('group', staff, 'Docs', 'write', 'deny'); // staff cannot write Docs
  assert.equal(lv(alice, 'Docs/x.md'), 'comment', 'deny in the same tier beats her group-editors allow: write is no longer possible');
  assert.equal(lv(bob, 'Docs/x.md'), 'read', 'bob only had read, a deny of write changes nothing');
});

test('deny write leaves read; deny comment leaves read', async () => {
  await reset();
  await rule('everyone', null, '', 'write');
  await rule('everyone', null, 'Archive', 'write', 'deny');
  assert.equal(lv(bob, 'Archive/old.md'), 'comment');
  await rule('everyone', null, 'Archive', 'comment', 'deny');
  assert.equal(lv(bob, 'Archive/old.md'), 'read');
});

test('globs: extension patterns and ** depth', async () => {
  await reset();
  await rule('everyone', null, '', 'write');
  await rule('everyone', null, '**/*.private.md', 'read', 'deny');
  await rule('everyone', null, 'Projects/**/draft-*', 'read', 'deny');
  assert.equal(lv(bob, 'a/b/c.private.md'), 'none');
  assert.equal(lv(bob, 'top.private.md'), 'none');
  assert.equal(lv(bob, 'a/b/c.md'), 'write');
  assert.equal(lv(bob, 'Projects/x/y/draft-1.md'), 'none');
  assert.equal(lv(bob, 'Projects/x/final.md'), 'write');
});

test('a folder rule covers everything below it (and only below)', async () => {
  await reset();
  await rule('user', bob.userId, 'Team', 'write');
  assert.equal(lv(bob, 'Team'), 'write');
  assert.equal(lv(bob, 'Team/deep/er/n.md'), 'write');
  assert.equal(lv(bob, 'Teams/n.md'), 'none', 'prefix of a name is not a folder match');
  assert.equal(lv(bob, 'Other/n.md'), 'none');
});

test('.obsidian is readable by everyone with access but read-only, unless a deeper rule says otherwise', async () => {
  await reset();
  await rule('user', bob.userId, 'Notes', 'write');
  assert.equal(lv(bob, '.obsidian/app.json'), 'read');
  assert.equal(lv(bob, '.obsidian/plugins/x/main.js'), 'read');
  await rule('user', bob.userId, '.obsidian/plugins', 'write');
  assert.equal(lv(bob, '.obsidian/plugins/x/data.json'), 'write');
  assert.equal(lv(bob, '.obsidian/app.json'), 'read');
  assert.equal(lv(admin, '.obsidian/app.json'), 'manage');
});

test('vaultAccessible follows read grants; rules of another vault do not leak', async () => {
  await reset();
  assert.equal(vaultAccessible(bob, V), false);
  await rule('group', staff, 'Shared', 'comment');
  assert.equal(vaultAccessible(bob, V), true);
  assert.equal(vaultAccessible(bob, 'other'), false);
  assert.equal(lv(bob, 'Shared/x.md'), 'comment');
});

test('case-insensitive matching and slash normalisation', async () => {
  await reset();
  await rule('everyone', null, '/Projects/', 'read');
  assert.equal(lv(bob, 'projects/a.md'), 'read');
  assert.equal(compileRule({ subjectType: 'everyone', subjectId: null, pattern: 'A/B/*/c', level: 'read', effect: 'allow' }).spec, 2);
  assert.ok(levelNum('manage') > levelNum('write'));
});
