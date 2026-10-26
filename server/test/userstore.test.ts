import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrations.js';
import { SqlUserStore, type UserStore } from '../src/db/userstore.js';
import type { Db } from '../src/db/types.js';
import { toPgSql } from '../src/db/postgres.js';

/**
 * The same suite runs on SQLite (always) and PostgreSQL (when TEST_DATABASE_URL points at
 * an empty, disposable database).
 */
const targets: [string, string][] = [['sqlite', 'sqlite::memory:']];
if (process.env.TEST_DATABASE_URL) targets.push(['postgres', process.env.TEST_DATABASE_URL]);

for (const [name, url] of targets) {
  describe(`UserStore (${name})`, () => {
    let db: Db;
    let store: UserStore;
    before(async () => {
      db = await openDb(url);
      if (name === 'postgres') {
        for (const t of ['sessions', 'user_group_members', 'identities', 'user_groups', 'users', 'schema_migrations']) {
          await db.run(`DROP TABLE IF EXISTS ${t} CASCADE`);
        }
      }
      await migrate(db);
      store = new SqlUserStore(db);
    });
    after(async () => db.close());

    test('migrations are idempotent', async () => {
      assert.deepEqual(await migrate(db), []);
    });

    test('users: create, lookup (case-insensitive), update, delete', async () => {
      const u = await store.createUser({ username: '  Alice ', email: 'Alice@Example.COM', isAdmin: true, passwordHash: 'h' });
      assert.equal(u.username, 'alice');
      assert.equal(u.email, 'alice@example.com');
      assert.equal(u.isAdmin, true);
      assert.equal(u.disabled, false);
      assert.equal((await store.getUserByUsername('ALICE'))?.id, u.id);
      assert.equal((await store.getUserByEmail('alice@example.com'))?.id, u.id);
      await assert.rejects(store.createUser({ username: 'alice' }), 'duplicate username');
      const upd = await store.updateUser(u.id, { displayName: 'Alice A.', disabled: true });
      assert.equal(upd?.displayName, 'Alice A.');
      assert.equal(upd?.disabled, true);
      assert.equal(await store.countAdmins(), 0, 'disabled admins do not count');
      assert.equal(await store.deleteUser(u.id), true);
      assert.equal(await store.getUser(u.id), undefined);
    });

    test('owner = oldest enabled admin', async () => {
      const a = await store.createUser({ username: 'own-a', isAdmin: true });
      await new Promise((r) => setTimeout(r, 5));
      await store.createUser({ username: 'own-b', isAdmin: true });
      assert.equal((await store.getOwner())?.id, a.id);
      await store.updateUser(a.id, { disabled: true });
      assert.equal((await store.getOwner())?.username, 'own-b');
    });

    test('identities link to one user and are unique per issuer+subject', async () => {
      const u = await store.createUser({ username: 'ident' });
      await store.linkIdentity(u.id, 'oidc', 'https://idp.example', 'sub-1');
      assert.equal((await store.findByIdentity('oidc', 'https://idp.example', 'sub-1'))?.id, u.id);
      assert.equal(await store.findByIdentity('oidc', 'https://other', 'sub-1'), undefined);
      await assert.rejects(store.linkIdentity(u.id, 'oidc', 'https://idp.example', 'sub-1'));
      assert.equal((await store.listIdentities(u.id)).length, 1);
    });

    test('groups and membership; deleting a user or group cleans memberships', async () => {
      const g = await store.createGroup({ name: 'Editors' });
      const u1 = await store.createUser({ username: 'g-u1' });
      const u2 = await store.createUser({ username: 'g-u2' });
      await store.addMember(g.id, u1.id);
      await store.addMember(g.id, u1.id); // idempotent
      await store.addMember(g.id, u2.id);
      assert.deepEqual((await store.listMembers(g.id)).map((u) => u.username), ['g-u1', 'g-u2']);
      assert.equal((await store.getGroupByName('editors'))?.id, g.id);
      await store.deleteUser(u2.id);
      assert.equal((await store.listMembers(g.id)).length, 1);
      assert.equal((await store.listGroupsOfUser(u1.id))[0].name, 'Editors');
      await store.deleteGroup(g.id);
      assert.equal((await store.listGroupsOfUser(u1.id)).length, 0);
    });

    test('syncUserGroups only touches idp-sourced memberships', async () => {
      const [ga, gb, gc] = await Promise.all(['sync-a', 'sync-b', 'sync-c'].map((name) => store.createGroup({ name })));
      const u = await store.createUser({ username: 'sync-user' });
      await store.addMember(ga.id, u.id, 'local'); // manual: must survive
      await store.syncUserGroups(u.id, [gb.id, gc.id], 'idp');
      assert.deepEqual((await store.listGroupsOfUser(u.id)).map((g) => g.name), ['sync-a', 'sync-b', 'sync-c']);
      await store.syncUserGroups(u.id, [gc.id], 'idp'); // IdP dropped b
      assert.deepEqual((await store.listGroupsOfUser(u.id)).map((g) => g.name), ['sync-a', 'sync-c']);
      await store.syncUserGroups(u.id, [], 'idp');
      assert.deepEqual((await store.listGroupsOfUser(u.id)).map((g) => g.name), ['sync-a']);
    });

    test('sessions: create, revoke, revoke-all-except, expiry', async () => {
      const u = await store.createUser({ username: 'sess' });
      const s1 = await store.createSession({ userId: u.id, ttlMs: 60_000, userAgent: 'ua' });
      const s2 = await store.createSession({ userId: u.id, ttlMs: 60_000 });
      const dead = await store.createSession({ userId: u.id, ttlMs: -1000 });
      assert.equal((await store.listSessions(u.id)).length, 2, 'expired session is not listed');
      assert.equal(await store.revokeSession(s1.id), true);
      assert.equal(await store.revokeSession(s1.id), false, 'already revoked');
      assert.ok((await store.getSession(s1.id))?.revokedAt);
      assert.equal(await store.revokeUserSessions(u.id, s2.id), 1, 'only the still-unrevoked expired one; s2 is the exception');
      const s3 = await store.createSession({ userId: u.id, ttlMs: 60_000 });
      assert.equal(await store.revokeUserSessions(u.id, s2.id), 1);
      assert.equal((await store.getSession(s3.id))?.revokedAt !== null, true);
      assert.equal((await store.getSession(s2.id))?.revokedAt, null);
      assert.ok(dead.id);
      await store.deleteUser(u.id);
      assert.equal(await store.getSession(s2.id), undefined, 'sessions go with the user');
    });

    test('transactions roll back on error and serialise', async () => {
      await assert.rejects(
        db.tx(async (t) => {
          await t.run(`INSERT INTO users (id, username, created_at, updated_at) VALUES ('tx1', 'tx-user', 'x', 'x')`);
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.equal(await store.getUserByUsername('tx-user'), undefined);
      // a query issued while a transaction is open must not leak into it
      const slow = db.tx(async (t) => {
        await t.run(`INSERT INTO users (id, username, created_at, updated_at) VALUES ('tx2', 'tx-two', 'x', 'x')`);
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('rollback');
      });
      const outside = store.countUsers();
      await assert.rejects(slow);
      await outside;
      assert.equal(await store.getUserByUsername('tx-two'), undefined);
    });
  });
}

test('toPgSql numbers placeholders', () => {
  assert.equal(toPgSql('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
});
