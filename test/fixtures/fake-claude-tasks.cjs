#!/usr/bin/env node
// Acts as Claude Code 2.1.314 with background tasks, as measured live: background_tasks_changed carries the full list,
// a finished task sends task_notification and then a wake-up turn (system init, assistant, result) while stdin is open,
// and stop_task stops a task with no wake-up turn.
// Messages: "bg <ms>" starts a task that ends after <ms>; "hold" starts one that runs until stopped;
// "pid" replies with this process id; "slow" starts a turn that only an interrupt ends.
const readline = require('node:readline');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
const session_id = 'fake-tasks';
const tasks = new Map();
let n = 0, slow = false;
const list = () => out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks.values()].map(t => ({ task_id: t.id, task_type: 'local_bash', description: t.description })) });
// Like Claude Code, text streams as deltas; the full assistant message repeats it.
const say = text => { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }); out({ type: 'assistant', message: { content: [{ type: 'text', text }] } }); };
const reply = text => { say(text); out({ type: 'result', subtype: 'success', result: text, session_id }); };
function start(ms) {
  const id = `task${++n}`;
  tasks.set(id, { id, description: `sleep ${n}` });
  list();
  out({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash', description: `sleep ${n}`, is_backgrounded: true });
  if (ms) setTimeout(() => {
    if (!tasks.delete(id)) return;
    out({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } });
    out({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', summary: `Background command "sleep ${n}" completed (exit code 0)` });
    list();
    out({ type: 'system', subtype: 'init', session_id });
    reply('finished');
  }, ms);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const event = JSON.parse(line);
  if (event.type === 'user') {
    const [word, arg] = String(event.message.content).split(' ');
    out({ type: 'system', subtype: 'init', session_id });
    if (word === 'bg' || word === 'hold') { start(word === 'bg' ? Number(arg) : 0); reply(`started pid=${process.pid}`); }
    else if (word === 'slow') { slow = true; say('working'); }
    else reply(`pid=${process.pid}`);
  } else if (event.type === 'control_request') {
    const { request_id, request } = event;
    if (request.subtype === 'stop_task' && tasks.delete(request.task_id)) {
      out({ type: 'system', subtype: 'task_updated', task_id: request.task_id, patch: { status: 'killed' } });
      out({ type: 'system', subtype: 'task_notification', task_id: request.task_id, status: 'stopped', summary: 'stopped' });
      list();
      out({ type: 'control_response', response: { subtype: 'success', request_id, response: {} } });
    } else if (request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id, response: {} } });
      // The stopped turn ends a little later, as a real model call does.
      if (slow) { slow = false; setTimeout(() => { say('late text of the stopped turn'); out({ type: 'result', subtype: 'error_during_execution', session_id }); }, 300); }
    } else out({ type: 'control_response', response: { subtype: 'error', request_id, error: 'unknown' } });
  }
});
