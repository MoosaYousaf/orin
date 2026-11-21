const test = require('node:test');
const assert = require('node:assert/strict');
const { replySaved } = require('../scripts/finish-install-mac.cjs');

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
