const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../electron/store');
const cli = require('../electron/providers/cli');
const { TIMING } = require('../electron/providers/claude-session');
const { Runner } = require('../electron/runner');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const textOf = message => message.parts.filter(p => p.type === 'text').map(p => p.text).join('');

// A runner on a fake Claude Code that has background tasks. `next` waits for an event the runner sends.
function setup({ mcp = { enabledConfigs: () => [], claudeConfigs: async () => [] } } = {}) {
  const home = tmp('orin-bg-home-'), bin = path.join(home, '.local/bin'), saved = process.env.HOME;
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-claude-tasks.cjs'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  process.env.HOME = home;
  cli.cliPath('claude', true);
  const store = new Store(path.join(home, 'data.json'));
  store.data.preferences.suggestReplies = false;
  const workspace = store.addWorkspace(tmp('orin-bg-ws-'));
  const thread = store.addThread(workspace.id, { connectionId: 'claude-code', model: '', effort: '', mode: 'auto' });
  const events = [], waiters = [];
  const send = (channel, value) => {
    events.push({ channel, value });
    for (const w of waiters.slice()) if (w.test(channel, value)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(value); }
  };
  const next = (test, ms = 4000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for an event')), ms);
    waiters.push({ test, resolve: v => { clearTimeout(timer); resolve(v); } });
  });
  const runner = new Runner({ store, secrets: { get: () => null, has: () => false }, mcp, send });
  const ended = () => next((c, v) => c === 'run-state' && v.threadId === thread.id && !v.running);
  const turn = async text => { const end = ended(); runner.start(thread.id, { text }); await end; return store.thread(thread.id).messages.at(-1); };
  const done = () => { cli.closeAll(); process.env.HOME = saved; cli.cliPath('claude', true); };
  return { store, runner, thread, events, next, ended, turn, done };
}

test('background tasks: a finished task wakes the session, and its reply is saved with a note', async () => {
  const saved = { ...TIMING };
  Object.assign(TIMING, { close: 200 });
  const t = setup();
  try {
    const tasks = t.next((c, v) => c === 'tasks' && v.tasks.length === 1);
    const first = await t.turn('bg 300');
    const wakeStart = t.next((c, v) => c === 'run-state' && v.running), wakeEnd = t.ended();
    assert.match(textOf(first), /^started pid=\d+$/);
    assert.equal((await tasks).tasks[0].description, 'sleep 1');
    assert.equal(Object.keys(t.runner.backgroundTasks()).length, 1);
    // The CLI starts the wake-up turn by itself; Orin shows it as a live run and saves it as a new reply.
    await wakeStart;
    await wakeEnd;
    const woke = t.store.thread(t.thread.id).messages.at(-1);
    assert.equal(textOf(woke), 'finished');
    assert.deepEqual(woke.woke.notices, ['Background command "sleep 1" completed (exit code 0)']);
    assert.deepEqual(t.runner.backgroundTasks(), {});
    // With no tasks left, stdin closes and the CLI exits.
    for (let i = 0; i < 40 && cli.background(t.thread.id); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(cli.background(t.thread.id), null);
  } finally { Object.assign(TIMING, saved); t.done(); }
});

test('background tasks: the next message goes into the same process, settings wait, and Stop ends a task without a wake-up', async () => {
  // Each turn gets a new connector config, as after a token refresh; the waiting process is still reused.
  let refresh = 0;
  const t = setup({ mcp: { enabledConfigs: () => [], claudeConfigs: async () => [{ name: 'docs', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${++refresh}` } }] } });
  try {
    const first = await t.turn('hold');
    const pid = textOf(first).split('=')[1];
    assert.throws(() => t.runner.setThreadSettings(t.thread.id, { mode: 'full' }), /Background tasks are running/);
    assert.throws(() => t.runner.start(t.thread.id, { text: 'again', editMessageId: first.id }), /Background tasks are running/);
    const second = await t.turn('pid');
    assert.equal(textOf(second), `pid=${pid}`, 'one process per conversation');
    const cleared = t.next((c, v) => c === 'tasks' && v.tasks.length === 0);
    await t.runner.stopTask(t.thread.id, Object.values(t.runner.backgroundTasks())[0][0].id);
    await cleared;
    const before = t.events.length;
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!t.events.slice(before).some(e => e.channel === 'run-state' && e.value.running), 'a stopped task starts no wake-up turn');
    assert.doesNotThrow(() => t.runner.setThreadSettings(t.thread.id, { mode: 'full' }));
  } finally { t.done(); }
});

test('background tasks: Stop of a reply keeps the process and its tasks; the longest wait stops the tasks', async () => {
  const saved = { ...TIMING };
  const t = setup();
  try {
    const first = await t.turn('hold');
    const pid = textOf(first).split('=')[1];
    const end = t.ended();
    t.runner.start(t.thread.id, { text: 'slow' });
    await t.next((c, v) => c === 'run-update' && v.parts.length);
    t.runner.stop(t.thread.id);
    await end;
    const stopped = t.store.thread(t.thread.id).messages.at(-1);
    assert.equal(stopped.stopped, true);
    assert.equal(Object.values(t.runner.backgroundTasks())[0].length, 1, 'the task still runs');
    // The interrupted turn's late events are dropped, not saved as a wake-up reply; the next message still reaches the same process.
    await new Promise(r => setTimeout(r, 300));
    assert.equal(t.store.thread(t.thread.id).messages.at(-1), stopped);
    assert.equal(textOf(await t.turn('pid')), `pid=${pid}`);
    assert.ok(!t.store.thread(t.thread.id).messages.some(m => textOf(m).includes('late text')));
    // A message sent at once after a stop waits for the interrupted turn's result, so the turns do not mix.
    const end2 = t.ended();
    t.runner.start(t.thread.id, { text: 'slow' });
    await t.next((c, v) => c === 'run-update' && v.parts.length);
    t.runner.stop(t.thread.id);
    await end2;
    assert.equal(textOf(await t.turn('pid')), `pid=${pid}`);
    assert.ok(!t.store.thread(t.thread.id).messages.some(m => textOf(m).includes('late text')));
    // After the longest wait, Orin stops the tasks and notes it under the last reply.
    Object.assign(TIMING, { maxWait: 300 });
    t.runner.endBackground(t.thread.id);
    await t.turn('hold');
    await t.next((c, v) => c === 'tasks' && v.tasks.length === 0, 3000);
    await new Promise(r => setTimeout(r, 50));
    assert.match(t.store.thread(t.thread.id).messages.at(-1).notes?.[0] || '', /^Orin stopped a background task after waiting \d+ minutes\.$/);
  } finally { Object.assign(TIMING, saved); t.done(); }
});

test('background tasks: a wake-up turn during the preparation of the next message is saved before that reply', async () => {
  let slow = false;
  const t = setup({ mcp: { enabledConfigs: () => [], claudeConfigs: async () => { if (slow) await new Promise(r => setTimeout(r, 800)); return []; } } });
  try {
    const first = await t.turn('bg 300');
    const pid = textOf(first).split('=')[1];
    slow = true;
    const last = await t.turn('pid');
    assert.equal(textOf(last), `pid=${pid}`);
    const roles = t.store.thread(t.thread.id).messages.map(m => `${m.role}:${textOf(m)}${m.woke ? ' (woke)' : ''}`);
    assert.deepEqual(roles, [`user:bg 300`, `assistant:started pid=${pid}`, 'user:pid', 'assistant:finished (woke)', `assistant:pid=${pid}`]);
  } finally { t.done(); }
});
