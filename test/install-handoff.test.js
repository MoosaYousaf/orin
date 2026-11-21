const test = require('node:test');
const assert = require('node:assert/strict');
const { replySaved, pruneBackups } = require('../scripts/finish-install-mac.cjs');

test('installation handoff waits for the completed reply to the current user message', () => {
  const config = { threadId: 't', userMessageId: 'u', marker: 'Ready to finish installation.' };
  const user = { id: 'u', role: 'user' };
  const reply = { role: 'assistant', parts: [{ type: 'text', text: config.marker }] };
  const data = messages => ({ threads: [{ id: 't', messages }] });
  assert.equal(replySaved(data([user]), config), false);
  assert.equal(replySaved(data([user, reply]), config), true);
  assert.equal(replySaved(data([user, { ...reply, stopped: true }]), config), false);
  assert.equal(replySaved(data([user, { ...reply, error: 'interrupted' }]), config), false);
  assert.equal(replySaved(data([user, { ...reply, parts: [{ type: 'text', text: 'Still working' }] }]), config), false);
  assert.equal(replySaved(data([user, reply, { role: 'user', id: 'next' }]), config), false);
  assert.equal(replySaved(data([user, reply]), { ...config, threadId: 'other' }), false);
});

test('installation keeps only the newest backup and leaves other apps alone', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-backups-'));
  try {
    const names = ['.orin-previous-aaaa-1111.app', '.orin-previous-bbbb-2222.app', '.orin-previous-cccc-3333.app', 'Orin.app', 'Other.app', '.orin-previous-notes.txt'];
    for (const name of names) fs.mkdirSync(path.join(dir, name));
    const keep = path.join(dir, '.orin-previous-cccc-3333.app');
    assert.deepEqual(pruneBackups(keep).map(f => path.basename(f)).sort(), ['.orin-previous-aaaa-1111.app', '.orin-previous-bbbb-2222.app']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.orin-previous-cccc-3333.app', '.orin-previous-notes.txt', 'Orin.app', 'Other.app']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
