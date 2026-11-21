// One Claude Code process per conversation. Stdin stays open while the agent's background tasks run, so the user's next
// message goes into the same process (never a second process on the same session), and the turns that the CLI starts
// by itself when a task ends (wake-up turns) reach the conversation as new replies.
// Measured with Claude Code 2.1.314: `background_tasks_changed` carries the full task list; a finished task sends
// `task_notification` and, while stdin is open, a wake-up turn starts at once with `system init`; `stop_task` stops a
// task with status "stopped" and starts no wake-up turn.

const DECLINED = 'The user declined this tool call.';
const NOT_ASKED = 'This access mode does not allow actions that need approval. The user can choose Ask first to approve them.';
const SKIPPED = 'The user skipped the questions.';

const EXIT_GRACE_MS = 400; // how long a turn waits for the output pipes after the CLI exits
// close: after the last task ends, how long stdin stays open for a wake-up turn or the next message.
// maxWait: the longest idle wait for background tasks; then Orin stops them.
// discard: after a stop, events of the interrupted turn are dropped until its result, for at most this long.
// Tests make them shorter.
const TIMING = { close: 5000, maxWait: 30 * 60 * 1000, discard: 10000 };
const TURN_START = new Set(['stream_event', 'assistant', 'user']);

class ClaudeSession {
  // apply(event, draft) returns a session id or throws; fail(error) maps sign-in errors; hooks get tasks and wake-up turns.
  constructor({ child, key, sessionId, name, apply, fail, hooks = {}, cleanup = () => {}, timing = {} }) {
    Object.assign(this, { child, key, sessionId, name, apply, fail, hooks, cleanup });
    this.timing = { ...TIMING, ...timing };
    this.turn = null; // { draft, signal, mode, approve, question, onSession, settle, failure, aborted }
    this.tasks = []; // [{ id, type, description, startedAt }]
    this.notices = []; // task_notification summaries since the last turn, for the wake-up reply's note
    this.asking = new Map(); // request_id -> cancel
    this.requests = new Map(); // our control request_id -> resolve
    this.waiters = []; // resolves when the current turn ends
    this.alive = true;
    this.discardUntil = 0;
    this.pending = '';
    this.stderr = '';
    this.closeTimer = null;
    this.waitTimer = null;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (this.pending + chunk).split('\n');
      this.pending = lines.pop();
      lines.forEach(line => this.handle(line));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    // 'close' waits for every holder of the output pipes. A process that the agent started without the CLI's
    // background option (a dev server) inherits them, so the session ends shortly after the CLI exits.
    let exitTimer = null;
    child.on('exit', (code, killedBy) => { exitTimer = setTimeout(() => this.ended(code, killedBy), EXIT_GRACE_MS); });
    child.on('close', code => { clearTimeout(exitTimer); this.ended(code); });
    child.on('error', error => this.ended(null, null, error));
  }

  get open() { return this.alive && this.child.stdin.writable; }
  get busy() { return !!this.turn; }
  turnEnded() { return this.turn ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  release() { const waiters = this.waiters; this.waiters = []; waiters.forEach(resolve => resolve()); }

  // Sends one user message and resolves when its result arrives.
  send(input, turn) {
    if (this.turn) return Promise.reject(new Error('This conversation is already running.'));
    clearTimeout(this.closeTimer); clearTimeout(this.waitTimer); this.waitTimer = null;
    this.notices = [];
    const done = new Promise((resolve, reject) => this.bind({ ...turn, settle: (error, result) => (error ? reject(error) : resolve(result)) }));
    const message = { type: 'user', message: { role: 'user', content: input } };
    // Right after a stop, the message waits for the interrupted turn's result, so the two turns' events never mix.
    if (this.discardUntil > Date.now()) { this.queued = message; this.flushTimer = setTimeout(() => this.flush(), this.discardUntil - Date.now()); }
    else this.write(message);
    return done;
  }
  flush() {
    clearTimeout(this.flushTimer);
    this.discardUntil = 0;
    const message = this.queued;
    this.queued = null;
    if (message) this.write(message);
  }
  bind(turn) {
    this.turn = { ...turn, failure: null };
    if (!turn.signal) return;
    const abort = () => this.abortTurn();
    turn.signal.addEventListener('abort', abort, { once: true });
    this.turn.unlisten = () => turn.signal.removeEventListener('abort', abort);
    if (turn.signal.aborted) abort();
  }
  write(message) { if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(request) {
    if (!this.open) return Promise.reject(new Error('The session has ended.'));
    const request_id = `orin-${Math.random().toString(36).slice(2)}`;
    const answer = new Promise(resolve => this.requests.set(request_id, resolve));
    this.write({ type: 'control_request', request_id, request });
    return answer.then(response => { if (response.subtype === 'error') throw new Error(response.error || `${request.subtype} failed.`); return response.response; });
  }
  stopTask(taskId) { return this.request({ subtype: 'stop_task', task_id: String(taskId) }); }
  closeInput() { clearTimeout(this.closeTimer); clearTimeout(this.waitTimer); if (this.child.stdin.writable) this.child.stdin.end(); }
  kill() {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    kill.unref(); this.child.once('exit', () => clearTimeout(kill));
  }

  // A stop keeps the process when background tasks run in it: the turn is interrupted, and the tasks keep running.
  abortTurn() {
    const turn = this.turn;
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    if (!this.tasks.length) { this.kill(); return; }
    this.request({ subtype: 'interrupt' }).catch(() => {});
    this.discardUntil = Date.now() + this.timing.discard;
    this.endTurn();
  }

  handle(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { if (this.turn && !this.turn.aborted) this.turn.draft.write('text', line + '\n'); return; }
    if (event.type === 'control_request' || event.type === 'control_cancel_request') { this.control(event); return; }
    if (event.type === 'control_response') {
      const id = event.response?.request_id;
      this.requests.get(id)?.(event.response); this.requests.delete(id);
      return;
    }
    if (event.type === 'system' && event.subtype === 'background_tasks_changed') { this.setTasks(event.tasks); return; }
    if (event.type === 'system' && event.subtype === 'task_notification') { if (event.status !== 'stopped' && event.summary) this.notices.push(String(event.summary)); return; }
    if (this.discardUntil) {
      const old = event.type === 'result' || Date.now() <= this.discardUntil;
      if (event.type === 'result' || !old) this.flush();
      if (old) return;
    }
    // The CLI starts a turn by itself after a task notification.
    if (!this.turn && ((event.type === 'system' && event.subtype === 'init') || TURN_START.has(event.type))) this.wake();
    const turn = this.turn;
    if (!turn) return;
    try { const session = this.apply(event, turn.draft); if (session) { this.sessionId = session; turn.onSession?.(session); } }
    catch (error) { turn.failure ||= error; }
    if (event.type === 'result') this.endTurn();
  }

  wake() {
    clearTimeout(this.closeTimer); clearTimeout(this.waitTimer); this.waitTimer = null;
    let turn = null;
    try { turn = this.hooks.onWake?.({ notices: this.notices }); } catch {}
    this.notices = [];
    // Without a listener the wake-up turn is read and dropped, so its events never mix into the next turn.
    this.bind(turn || { draft: { write() {}, tool() {}, toolResult() {}, setStatus() {}, hasText: () => true, parts: [], suggestions: [] }, mode: 'auto', settle() {} });
  }

  endTurn() {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.unlisten?.();
    for (const cancel of this.asking.values()) cancel();
    this.asking.clear();
    if (turn.aborted) turn.settle(null, { stopped: true });
    else if (turn.failure) turn.settle(this.fail(turn.failure));
    else turn.settle(null, {});
    this.idle();
    this.release();
  }

  // Between turns: wait while tasks run (up to the longest wait), else close stdin so the CLI exits.
  idle() {
    if (this.turn || !this.alive) return;
    clearTimeout(this.closeTimer);
    if (this.tasks.length) {
      if (!this.waitTimer) this.waitTimer = setTimeout(() => this.expire(), this.timing.maxWait);
      return;
    }
    clearTimeout(this.waitTimer); this.waitTimer = null;
    this.closeTimer = setTimeout(() => { if (!this.turn && !this.tasks.length) this.closeInput(); }, this.timing.close);
  }
  async expire() {
    this.waitTimer = null;
    if (this.turn || !this.tasks.length) return;
    const count = this.tasks.length;
    await Promise.allSettled(this.tasks.map(t => this.stopTask(t.id)));
    this.hooks.onExpire?.({ count, minutes: Math.round(this.timing.maxWait / 60000) });
    if (!this.turn) this.closeInput();
  }

  setTasks(list) {
    const before = new Map(this.tasks.map(t => [t.id, t]));
    this.tasks = (Array.isArray(list) ? list : []).filter(t => t?.task_id).map(t => before.get(t.task_id) ? { ...before.get(t.task_id), description: String(t.description || '') }
      : { id: String(t.task_id), type: String(t.task_type || 'task'), description: String(t.description || ''), startedAt: Date.now() });
    this.hooks.onTasks?.(this.tasks);
    if (!this.turn) this.idle();
  }

  control(event) {
    if (event.type === 'control_cancel_request') { this.asking.get(event.request_id)?.(); this.asking.delete(event.request_id); return; }
    const { request_id, request = {} } = event;
    const reply = response => this.write({ type: 'control_response', response: { request_id, ...response } });
    if (request.subtype !== 'can_use_tool') { reply({ subtype: 'error', error: `Orin does not handle ${request.subtype} requests.` }); return; }
    const turn = this.turn;
    const allow = updatedInput => reply({ subtype: 'success', response: { behavior: 'allow', updatedInput } });
    const deny = message => reply({ subtype: 'success', response: { behavior: 'deny', message } });
    if (!turn || turn.aborted) { deny(NOT_ASKED); return; }
    const { draft } = turn, callId = request.tool_use_id;
    draft.tool({ id: callId, name: request.tool_name, input: request.input });
    // AskUserQuestion takes its answers in updatedInput.answers, keyed by question text.
    if (request.tool_name === 'AskUserQuestion' && turn.question) {
      const questions = request.input?.questions || [];
      draft.setStatus(callId, 'pending');
      const { decision, cancel } = turn.question({ callId, questions: questions.map((q, i) => ({ ...q, id: String(i) })) });
      this.asking.set(request_id, cancel);
      decision.then(answers => {
        this.asking.delete(request_id);
        draft.setStatus(callId, answers ? 'running' : 'denied');
        if (answers) allow({ ...request.input, answers: Object.fromEntries(questions.map((q, i) => [q.question, answers[String(i)].join(', ')])) });
        else deny(SKIPPED);
      });
      return;
    }
    if (!turn.approve || turn.mode !== 'ask') { draft.setStatus(callId, 'denied'); deny(NOT_ASKED); return; }
    draft.setStatus(callId, 'pending');
    const { decision, cancel } = turn.approve({ callId, name: request.tool_name, tool: request.display_name || request.tool_name, input: request.input, description: request.description, blockedPath: request.blocked_path });
    this.asking.set(request_id, cancel);
    decision.then(answer => {
      this.asking.delete(request_id);
      draft.setStatus(callId, answer === 'deny' ? 'denied' : 'running');
      if (answer === 'deny') deny(DECLINED); else allow(request.input);
    });
  }

  ended(code, killedBy, error) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.closeTimer); clearTimeout(this.waitTimer); clearTimeout(this.flushTimer);
    this.discardUntil = 0;
    this.handle(this.pending); this.pending = '';
    this.child.stdout.removeAllListeners('data'); this.child.stderr.removeAllListeners('data');
    this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
    for (const resolve of this.requests.values()) resolve({ subtype: 'error', error: 'The session has ended.' });
    this.requests.clear();
    const turn = this.turn;
    if (turn) {
      this.turn = null;
      turn.unlisten?.();
      for (const cancel of this.asking.values()) cancel();
      this.asking.clear();
      if (turn.aborted) turn.settle(null, { stopped: true });
      else if (turn.failure) turn.settle(this.fail(turn.failure));
      else if (error) turn.settle(error);
      else if (code === 0) turn.settle(null, {});
      else turn.settle(this.fail(new Error(this.stderr.trim() || `${this.name} exited with ${killedBy || `code ${code}`}.`)));
    }
    if (this.tasks.length) { this.tasks = []; this.hooks.onTasks?.([]); }
    this.release();
    this.cleanup();
    this.hooks.onClose?.(this);
  }
}

module.exports = { ClaudeSession, TIMING };
