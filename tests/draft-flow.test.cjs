const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const declarations = source.slice(source.indexOf('const DRAFT_STORAGE_PREFIX='), source.indexOf('const VAPID_PUBLIC_KEY='));
const functions = source.slice(source.indexOf('function draftStateFor('), source.indexOf('function loadXlsx()'));
const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const activityId = '33333333-3333-4333-8333-333333333333';

function setup(upsert = async () => ({ error: null }), initialStorage = []) {
  const values = new Map(initialStorage);
  const writes = [];
  const status = { textContent: '' };
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const context = {
    localStorage: storage,
    user: { id: userId }, profile: { role: 'engineer' }, selectedProject: projectId,
    pendingChange: task => task.actual !== task.originalActual,
    $: () => status,
    document: { querySelector: () => status, addEventListener() {} },
    window: { addEventListener() {} },
    db: { from(table) {
      assert.equal(table, 'activity_drafts');
      return {
        upsert(rows, options) {
          writes.push({ type: 'upsert', rows, options });
          return upsert(rows);
        },
        delete() {
          return { eq() { return this; }, in(column, ids) {
            writes.push({ type: 'delete', column, ids });
            return Promise.resolve({ error: null });
          } };
        }
      };
    } },
    setTimeout, clearTimeout, console
  };
  const api = vm.runInNewContext(`${declarations}\n${functions}\n({ draftStateFor, restoredActual, queueDraftChange, flushDraft })`, context);
  return { ...api, values, writes, status };
}

test('an edit is backed up immediately and then saved for its owner', async () => {
  const app = setup();
  const task = { id: activityId, originalActual: 0, actual: 42 };
  app.queueDraftChange(task);
  const key = `obra-em-dia-draft-v1:${userId}:${projectId}`;
  assert.equal(JSON.parse(app.values.get(key))[activityId], 42);
  assert.equal(app.writes.length, 0);
  assert.equal(await app.flushDraft(app.draftStateFor(userId, projectId)), true);
  assert.equal(app.writes[0].rows[0].user_id, userId);
  assert.equal(app.writes[0].rows[0].project_id, projectId);
  assert.equal(app.writes[0].rows[0].actual_pct, 42);
  assert.equal(app.values.has(key), false);
  assert.match(app.status.textContent, /Rascunho salvo/);
});

test('a saved server draft is restored and a pending local edit takes precedence', () => {
  const app = setup();
  const state = app.draftStateFor(userId, projectId);
  const serverValues = new Map([[activityId, 42]]);
  assert.equal(app.restoredActual(activityId, 0, serverValues, state), 42);
  state.recent.set(activityId, 60);
  assert.equal(app.restoredActual(activityId, 0, serverValues, state), 60);
  state.recent.set(activityId, null);
  assert.equal(app.restoredActual(activityId, 0, serverValues, state), 0);
});

test('an interrupted save is restored after a page reload', () => {
  const key = `obra-em-dia-draft-v1:${userId}:${projectId}`;
  const app = setup(undefined, [[key, JSON.stringify({ [activityId]: 55 })]]);
  const state = app.draftStateFor(userId, projectId);
  assert.equal(app.restoredActual(activityId, 0, new Map(), state), 55);
});

test('resetting to the submitted value removes the private draft', async () => {
  const app = setup();
  const task = { id: activityId, originalActual: 0, actual: 42 };
  app.queueDraftChange(task);
  await app.flushDraft(app.draftStateFor(userId, projectId));
  task.actual = 0;
  app.queueDraftChange(task);
  await app.flushDraft(app.draftStateFor(userId, projectId));
  assert.equal(app.writes[1].type, 'delete');
  assert.equal(app.writes[1].column, 'activity_id');
  assert.deepEqual(Array.from(app.writes[1].ids), [activityId]);
});

test('an edit made during a save is written after the older value', async () => {
  let releaseFirst;
  let requests = 0;
  const app = setup(async () => {
    requests++;
    if(requests === 1)await new Promise(resolve => { releaseFirst = resolve; });
    return { error: null };
  });
  const task = { id: activityId, originalActual: 0, actual: 42 };
  app.queueDraftChange(task);
  const saving = app.flushDraft(app.draftStateFor(userId, projectId));
  task.actual = 60;
  app.queueDraftChange(task);
  releaseFirst();
  await saving;
  assert.deepEqual(app.writes.map(write => write.rows[0].actual_pct), [42, 60]);
});

test('a response started before saving cannot replace the latest edit', async () => {
  const app = setup();
  const task = { id: activityId, originalActual: 0, actual: 42 };
  app.queueDraftChange(task);
  await app.flushDraft(app.draftStateFor(userId, projectId));
  assert.equal(app.draftStateFor(userId, projectId).pending.size, 0);
  assert.equal(app.restoredActual(activityId, 0, new Map(), app.draftStateFor(userId, projectId)), 42);
});
