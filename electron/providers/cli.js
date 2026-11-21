const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { replayPrompt } = require('./transcript');
const codexServer = require('./codex-server');
const copilotAcp = require('./copilot-acp');
const usage = require('./usage');
const { Draft } = require('../draft');
const { ClaudeSession } = require('./claude-session');

// Apps opened from Finder get a minimal PATH, so look where CLIs and npx are usually installed.
function searchPath() {
  const home = process.env.HOME || '';
  const nvm = (() => { try { return fs.readdirSync(path.join(home, '.nvm/versions/node')).reverse().map(v => path.join(home, '.nvm/versions/node', v, 'bin')); } catch { return []; } })();
  return [...new Set([path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), ...(process.env.PATH || '').split(path.delimiter), ...nvm, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))];
}

const located = new Map();
function cliPath(name, refresh = false) {
  if (!refresh && located.has(name)) return located.get(name);
  const found = searchPath().map(d => path.join(d, name)).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  located.set(name, found);
  return found;
}

// OAuth configs are resolved by Mcp.claudeConfigs after the user's Orin sign-in. Unresolved ones stay out.
function claudeMcpConfig(servers) {
  const mcpServers = {};
  for (const s of servers) {
    if (s.transport === 'stdio') mcpServers[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
    else if (!s.oauth) mcpServers[s.name] = { type: 'http', url: s.url, headers: s.headers || {} };
  }
  return { mcpServers };
}

// The prompt always goes through stdin, so prompt text can never be parsed as a CLI option.
function command(cli, { sessionId, model = '', effort = '', mode = 'auto', mcpConfig, system = '' }) {
  const modelArgs = model ? ['--model', model] : [];
  if (cli === 'claude') {
    // The prompt goes to stdin as a stream-json message, and permission prompts and questions come back as control requests.
    // In "ask" Orin shows the permission prompts; in the other modes it denies them, as the CLI does without a person.
    const permission = { ask: ['--permission-mode', 'default'], default: ['--permission-mode', 'default'], read: ['--permission-mode', 'plan'], auto: ['--permission-mode', 'acceptEdits'], full: ['--permission-mode', 'bypassPermissions'] }[mode];
    return ['-p', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...permission, ...modelArgs, ...(effort ? ['--effort', effort] : []), ...(sessionId ? ['--resume', sessionId] : []), ...(mcpConfig ? ['--mcp-config', mcpConfig] : []), ...(system ? ['--append-system-prompt', system] : [])];
  }
  if (cli === 'codex') {
    const access = { default: [], read: ['--sandbox', 'read-only', '-c', 'approval_policy="never"'], auto: ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'], full: ['--dangerously-bypass-approvals-and-sandbox'] }[mode];
    // --search is a top-level option: the model's own web search tool, which needs no sandbox network access.
    return ['--search', 'exec', '--json', '--skip-git-repo-check', ...access, ...modelArgs, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), ...(sessionId ? ['resume', sessionId] : []), '-'];
  }
  if (cli === 'gemini') {
    const access = { default: ['--approval-mode', 'default'], read: ['--approval-mode', 'plan'], auto: ['--approval-mode', 'auto_edit'], full: ['--approval-mode', 'yolo'] }[mode];
    return ['-p', '', '--output-format', 'stream-json', ...access, ...modelArgs, ...(sessionId ? ['--resume', sessionId] : [])];
  }
  if (cli === 'copilot') {
    const access = { default: [], read: ['--deny-tool=write', '--deny-tool=shell'], auto: ['--allow-tool=write'], full: ['--allow-all'] }[mode];
    // Copilot accepts a caller-chosen session id, so a new session can be resumed by that same id later.
    return ['--output-format', 'json', '--no-ask-user', '--disable-client-telemetry', ...access, ...modelArgs, ...copilotAcp.effortArgs(model, effort), '--session-id', sessionId];
  }
  throw new Error('Unknown CLI.');
}

const asText = value => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text ?? '').join('\n') : JSON.stringify(value ?? ''));

// Applies one JSON event from a CLI to the draft. Returns a session id when the event carries one.
function apply(cli, event, draft) {
  if (cli === 'claude') {
    if (event.type === 'system' && event.subtype === 'init') return event.session_id;
    if (event.type === 'prompt_suggestion' && event.suggestion) draft.suggestions = [...new Set([...draft.suggestions, event.suggestion.trim()])];
    if (event.type === 'stream_event') {
      const e = event.event;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && draft.last('text')) draft.parts.push({ type: 'text', text: '' });
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') draft.write('text', e.delta.text);
      if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') draft.write('thinking', e.delta.thinking);
    } else if (event.type === 'assistant') {
      // The main agent's last call shows how full the context is. Subagent calls have their own context.
      const u = event.message?.usage;
      if (u && !event.parent_tool_use_id) draft.usage = { used: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0), window: draft.usage?.window ?? null };
      // Text already arrived as deltas; only tool calls are taken from the full message.
      for (const block of event.message?.content || []) if (block.type === 'tool_use') draft.tool({ id: block.id, name: block.name, input: block.input });
    } else if (event.type === 'user') {
      for (const block of event.message?.content || []) if (block.type === 'tool_result') draft.toolResult(block.tool_use_id, { output: asText(block.content), isError: !!block.is_error });
    } else if (event.type === 'result') {
      if (event.is_error) {
        const message = asText(event.result) || (event.errors || []).join('\n') || 'Claude Code reported an error.';
        if (event.error === 'authentication_failed' || signedOut('claude', message)) throw signInError(PRESET_NAMES.claude);
        throw new Error(message);
      }
      if (!draft.hasText() && event.result) draft.write('text', event.result);
      const window = Math.max(0, ...Object.values(event.modelUsage || {}).map(m => m.contextWindow || 0));
      if (draft.usage && window) draft.usage.window = window;
      return event.session_id;
    }
  } else if (cli === 'codex') {
    if (event.type === 'thread.started') return event.thread_id;
    const item = event.item || {};
    if (event.type === 'item.started' && item.type === 'command_execution') draft.tool({ id: item.id, name: 'Command', input: item.command });
    if (event.type === 'item.completed') {
      if (item.type === 'agent_message') draft.write('text', (draft.last('text') ? '\n\n' : '') + (item.text || ''));
      else if (item.type === 'reasoning') draft.write('thinking', item.text || '');
      else if (item.type === 'command_execution') { draft.tool({ id: item.id, name: 'Command', input: item.command }); draft.toolResult(item.id, { output: item.aggregated_output || '', isError: item.exit_code ? item.exit_code !== 0 : false }); }
      else if (item.type === 'file_change') { draft.tool({ id: item.id, name: 'File change', input: item.changes }); draft.toolResult(item.id, { output: item.status || 'applied' }); }
      else if (item.type === 'mcp_tool_call') { draft.tool({ id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments }); draft.toolResult(item.id, { output: asText(item.result?.content), isError: item.status === 'failed' }); }
    }
    if (event.type === 'turn.failed') throw new Error(event.error?.message || 'Codex turn failed.');
    if (event.type === 'error') throw new Error(event.message || 'Codex error.');
  } else if (cli === 'gemini') {
    if (event.type === 'init') return event.session_id;
    // Gemini streams assistant text as delta chunks; non-delta messages replace the block.
    if (event.type === 'message' && event.role === 'assistant') draft.write('text', event.content || '', !!event.delta);
    if (event.type === 'tool_use') draft.tool({ id: event.tool_id, name: event.tool_name || 'Tool', input: event.parameters });
    if (event.type === 'tool_result') draft.toolResult(event.tool_id, { output: asText(event.output ?? event.error?.message), isError: event.status === 'error' });
    if (event.type === 'error') throw new Error(event.message || 'Gemini error.');
    if (event.type === 'result' && event.status === 'error') throw new Error(event.error?.message || 'Gemini run failed.');
  } else if (cli === 'copilot') {
    const d = event.data || {};
    if (event.type === 'assistant.message_start' && draft.last('text')?.text) draft.parts.push({ type: 'text', text: '' });
    else if (event.type === 'assistant.message_delta') { draft.streamed.add(d.messageId); draft.write('text', d.deltaContent); }
    else if (event.type === 'assistant.reasoning_delta') draft.write('thinking', d.deltaContent);
    else if (event.type === 'assistant.message') {
      if (d.content && !draft.streamed.has(d.messageId)) draft.write('text', (draft.last('text')?.text ? '\n\n' : '') + d.content);
      for (const t of d.toolRequests || []) draft.tool({ id: t.toolCallId, name: t.name, input: t.arguments });
    } else if (event.type === 'tool.execution_start') draft.tool({ id: d.toolCallId, name: d.toolName, input: d.arguments });
    else if (event.type === 'tool.execution_complete') draft.toolResult(d.toolCallId, { output: asText(d.result?.content ?? d.error?.message ?? d.error), isError: d.success === false });
    else if (/error$/.test(event.type) && !event.ephemeral) throw new Error(d.message || d.error?.message || 'GitHub Copilot reported an error.');
  }
  return null;
}

// A signed-out CLI fails its turn with one of these messages. Codex patterns are guesses from its error texts.
const SIGNED_OUT = {
  claude: /OAuth session expired|Not logged in|Please run \/login|Login expired|Failed to authenticate|Invalid API key · Please run/i,
  codex: /Not logged in|codex login|401 Unauthorized|refresh token .*(expired|already been used|revoked)|token_expired|re-?authenticate/i
};
const PRESET_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const signedOut = (cli, text) => !!SIGNED_OUT[cli]?.test(String(text || ''));
function signInError(name) {
  return Object.assign(new Error(`${name} is signed out or its sign-in expired. Select Sign in and finish the page in your browser. Orin then sends your message again.`), { signIn: true });
}
// The CLI's own browser sign-in. Only CLIs with a non-interactive login command are listed.
const LOGIN = { claude: ['auth', 'login', '--claudeai'], codex: ['login'] };
function login(cli, { signal } = {}) {
  const executable = cliPath(cli);
  if (!executable || !LOGIN[cli]) return Promise.reject(new Error('This CLI has no sign-in command Orin can run. Sign in from Terminal.'));
  const child = track(spawn(executable, LOGIN[cli], { cwd: os.homedir(), env: { ...process.env, PATH: searchPath().join(path.delimiter), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], signal }));
  let output = '';
  const keep = chunk => { output = (output + chunk).slice(-4000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(output.trim().split('\n').at(-1) || `Sign-in exited with code ${code}.`))));
  });
}


// Codex and Copilot do not stream context usage; their session files have it after the turn.
async function run(options) {
  let session = options.thread.sessionId;
  const result = await runTurn({ ...options, onSession: id => { session = id; options.onSession(id); } });
  if (!options.draft.usage && !result.stopped) options.draft.usage = usage.fromSession(options.preset.cli, session);
  return result;
}

// How long a turn waits for the output pipes after the CLI exits.
const EXIT_GRACE_MS = 400;

// Claude Code runs in a ClaudeSession that can outlive the turn; see claude-session.js.
const sessions = new Map(); // thread id -> ClaudeSession

async function claudeTurn({ preset, thread, input, resume, system, cwd, env, executable, mcpServers, draft, signal, onSession, approve, question, background }) {
  const key = JSON.stringify([thread.model || '', thread.effort || '', thread.mode, cwd, system || '', mcpServers || []]);
  let session = thread.id ? sessions.get(thread.id) : null;
  // A wake-up turn that began while this message was being prepared ends first; its reply is saved before this one.
  while (session?.busy) {
    await session.turnEnded();
    if (signal.aborted) return { stopped: true };
    session = sessions.get(thread.id);
  }
  // The same process takes the next message while it is open, with the same settings and session. While its tasks run,
  // it is kept even when the connector config changed (a refreshed token): the runner blocks setting changes then.
  const reusable = session?.open && !thread.replay && session.sessionId && session.sessionId === resume && (session.key === key || session.tasks.length > 0);
  if (session && !reusable) {
    if (session.open && session.tasks.length) throw new Error('Background tasks are running in this conversation. Stop them first.');
    session.closeInput(); session.kill();
    session = null;
  }
  if (!session) {
    let configDir, mcpConfig;
    if (mcpServers?.length) {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-mcp-'));
      mcpConfig = path.join(configDir, 'config.json');
      fs.writeFileSync(mcpConfig, JSON.stringify(claudeMcpConfig(mcpServers)), { mode: 0o600 });
    }
    const cleanup = () => { if (configDir) fs.rmSync(configDir, { recursive: true, force: true }); };
    let child;
    try { child = track(spawn(executable, command('claude', { ...thread, sessionId: resume, mcpConfig, system }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })); }
    catch (error) { cleanup(); throw error; }
    const id = thread.id;
    session = new ClaudeSession({
      child, key, sessionId: resume, name: preset.name, cleanup,
      hooks: { ...background, onClose: s => { if (id && sessions.get(id) === s) sessions.delete(id); background?.onClose?.(s); } },
      apply: (event, d) => apply('claude', event, d),
      fail: error => (signedOut('claude', error.message) && !error.signIn ? signInError(preset.name) : error)
    });
    if (id) sessions.set(id, session);
  }
  return session.send(input, { draft, signal, mode: thread.mode, approve, question, onSession });
}
// The background tasks of a conversation's open Claude Code process, and actions on them.
function background(threadId) {
  const session = sessions.get(threadId);
  return session?.alive ? { tasks: session.tasks, busy: session.busy, stopTask: id => session.stopTask(id), end: () => { session.closeInput(); session.kill(); } } : null;
}

function runTurn({ preset, thread, history, prompt, system, cwd, mcpServers, draft, signal, onSession, approve, question, background: hooks }) {
  const executable = cliPath(preset.cli);
  if (!executable) throw new Error(`${preset.name} is not installed or not on PATH.`);
  let resume = thread.replay ? null : thread.sessionId;
  const input = thread.replay || (!thread.sessionId && history.length) ? replayPrompt(history, prompt) : prompt;
  const env = { ...process.env, PATH: searchPath().join(path.delimiter), NO_COLOR: '1', COPILOT_AUTO_UPDATE: 'false' };
  if (preset.cli === 'claude') return claudeTurn({ preset, thread, input, resume, system, cwd, env, executable, mcpServers, draft, signal, onSession, approve, question, background: hooks });
  if (preset.cli === 'codex' && thread.mode === 'ask') return codexServer.run({ executable, env, cwd, input, resume, model: thread.model, effort: thread.effort, draft, signal, onSession, approve, question });
  if (preset.cli === 'copilot' && thread.mode === 'ask') return copilotAcp.run({ executable, env, cwd, input, resume, model: thread.model, effort: thread.effort, draft, signal, onSession, approve });
  if (preset.cli === 'copilot' && !resume) { resume = crypto.randomUUID(); onSession(resume); }
  const child = track(spawn(executable, command(preset.cli, { ...thread, sessionId: resume, system }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let pending = '', stderr = '', failure = null;
  const handle = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { if (!signal.aborted) draft.write('text', line + '\n'); return; }
    try { const session = apply(preset.cli, event, draft); if (session) onSession(session); }
    catch (error) { failure ||= error; }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    lines.forEach(handle);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const stop = () => {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    kill.unref(); child.once('exit', () => clearTimeout(kill));
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  // 'close' waits for every holder of the output pipes. A background process that the agent started (a dev server,
  // `npm start`) inherits them, so the turn also ends shortly after the CLI exits. Orin leaves such processes running.
  return new Promise((resolve, reject) => {
    let done = false, timer = null;
    const finish = (code, killedBy) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      handle(pending); pending = '';
      child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data');
      child.stderr.destroy(); child.unref();
      child.stdout.destroy();
      if (signal.aborted) resolve({ stopped: true });
      else if (failure) reject(signedOut(preset.cli, failure.message) && !failure.signIn ? signInError(preset.name) : failure);
      else if (code === 0) resolve({});
      else reject(signedOut(preset.cli, stderr) ? signInError(preset.name) : new Error(stderr.trim() || `${preset.name} exited with ${killedBy || `code ${code}`}.`));
    };
    child.on('error', reject);
    child.on('exit', (code, killedBy) => { timer = setTimeout(() => finish(code, killedBy), EXIT_GRACE_MS); });
    child.on('close', finish);
  });
}

// One short request without a session, tools, or files, for helper text such as suggested replies.
// It runs in the temporary folder with read-only access and low effort, and returns the reply text.
// Claude Code: --tools '' also removes ToolSearch, so the user's MCP tools would go in full (~85k tokens a call);
// --strict-mcp-config loads none.
function completeArgs(cli, model) {
  if (cli === 'codex') return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"', ...(model ? ['--model', model] : []), '-'];
  if (cli === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', 'Return only the requested short answer.', '--no-session-persistence', ...(model ? ['--model', model] : [])];
  return command(cli, { model, effort: 'low', mode: 'read', sessionId: cli === 'copilot' ? crypto.randomUUID() : undefined });
}
function complete({ preset, model = '', prompt, signal }) {
  const executable = cliPath(preset.cli);
  if (!executable) return Promise.reject(new Error(`${preset.name} is not installed.`));
  const draft = new Draft();
  const env = { ...process.env, PATH: searchPath().join(path.delimiter), NO_COLOR: '1', COPILOT_AUTO_UPDATE: 'false' };
  const child = track(spawn(executable, completeArgs(preset.cli, model), { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], signal }));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) { try { apply(preset.cli, JSON.parse(line), draft); } catch {} }
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      try { if (pending.trim()) apply(preset.cli, JSON.parse(pending), draft); } catch {}
      const text = draft.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (text.trim()) resolve(text); else reject(new Error(`${preset.name} exited with code ${code}.`));
    });
  });
}

const children = new Set();
function track(child) { children.add(child); child.once('exit', () => children.delete(child)); child.once('error', () => children.delete(child)); return child; }
function closeAll() { for (const child of children) child.kill('SIGKILL'); children.clear(); sessions.clear(); }

module.exports = { closeAll, background, claudeMcpConfig, searchPath, cliPath, command, apply, run, complete, completeArgs, login, signedOut, LOGIN };
