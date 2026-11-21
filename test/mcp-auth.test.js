const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Mcp, serverUrl } = require('../electron/mcp');
const { claudeMcpConfig, apply, command, signedOut } = require('../electron/providers/cli');
const { Draft } = require('../electron/draft');

test('OpenMarket documentation links become endpoints, without rewriting other servers', () => {
  assert.equal(serverUrl('https://mcp.openmarket.xyz/llms.txt'), 'https://mcp.openmarket.xyz/');
  assert.equal(serverUrl('https://mcp.openmarket.xyz/'), 'https://mcp.openmarket.xyz/');
  assert.equal(serverUrl('https://other.example/llms.txt'), 'https://other.example/llms.txt');
  let saved = false;
  const store = { data: { mcpServers: [{ transport: 'http', url: 'https://mcp.openmarket.xyz/llms.txt' }] }, save() { saved = true; } };
  new Mcp({ store });
  assert.equal(store.data.mcpServers[0].url, 'https://mcp.openmarket.xyz/');
  assert.equal(saved, true);
});

test('an expired Claude account sign-in fails with a sign-in error; other errors stay as they are', () => {
  assert.throws(() => apply('claude', { type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }, new Draft()), e => e.signIn === true && /Select Sign in/.test(e.message));
  assert.throws(() => apply('claude', { type: 'result', is_error: true, result: '', errors: ['Server is unavailable'] }, new Draft()), /Server is unavailable/);
});

test('Claude gets approved OAuth connectors and refreshed tokens through its private MCP config', async () => {
  let base, token = 'first-access', refreshes = 0;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/.well-known/oauth-protected-resource') return json(200, { resource: base + '/', authorization_servers: [base], scopes_supported: ['mcp:read'] });
    if (req.url === '/.well-known/oauth-authorization-server') return json(200, {
      issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    });
    if (req.url === '/register') return json(201, { ...JSON.parse(body), client_id: 'orin-test-client' });
    if (req.url === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token') { refreshes++; assert.equal(form.get('refresh_token'), 'test-refresh'); }
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh', scope: 'mcp:read' });
    }
    if (req.url === '/' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); return res.end();
      }
      const request = JSON.parse(body);
      calls.push(request.method);
      if (request.id == null) { res.writeHead(202); return res.end(); }
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'charts', version: '1' } }
        : { tools: [{ name: 'chart_status', description: 'Read chart status', inputSchema: { type: 'object', properties: {} } }] };
      return json(200, { jsonrpc: '2.0', id: request.id, result });
    }
    res.writeHead(405); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const values = {};
  const secrets = { get: key => values[key], set: (key, value) => { values[key] = value; } };
  const store = { data: { mcpServers: [{ id: 'charts', name: 'OpenMarkets', transport: 'http', url: base + '/', oauth: true, enabled: true }] } };
  const mcp = new Mcp({ store, secrets, onChange() {}, openExternal: async authorization => {
    const url = new URL(authorization);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'test-code');
    if (url.searchParams.has('state')) callback.searchParams.set('state', url.searchParams.get('state'));
    await fetch(callback);
  } });
  try {
    // Skip leaves the connector out of the turn and says why; Sign in runs the browser sign-in and includes it.
    const skipped = [];
    assert.deepEqual(await mcp.claudeConfigs({ signIn: async () => false, onSkip: (s, reason) => skipped.push(`${s.name}: ${reason}`) }), []);
    assert.deepEqual(skipped, ['OpenMarkets: sign-in skipped']);
    const asked = [];
    const signedIn = await mcp.claudeConfigs({ signIn: async s => { asked.push(s.name); return true; } });
    assert.deepEqual(asked, ['OpenMarkets']);
    assert.equal(signedIn[0].headers.Authorization, 'Bearer first-access');
    assert.equal(mcp.statuses().charts.state, 'connected');
    token = 'refreshed-access'; // The old access token is now rejected by the remote server.
    const configs = await mcp.claudeConfigs();
    assert.ok(refreshes >= 1);
    const config = claudeMcpConfig(configs).mcpServers.OpenMarkets;
    assert.deepEqual(config, { type: 'http', url: base + '/', headers: { Authorization: 'Bearer refreshed-access' } });
    assert.equal(store.data.mcpServers[0].oauth, true);
    assert.equal(store.data.mcpServers[0].headers, undefined);
    assert.ok(calls.includes('tools/list'));
    assert.deepEqual((await mcp.tools()).map(t => t.qualified), ['openmarkets__chart_status']);
    store.data.mcpServers[0].enabled = false;
    assert.deepEqual(await mcp.claudeConfigs(), []);
  } finally { await mcp.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Claude gets Orin instructions as a system prompt, and Codex gets its web search tool', () => {
  const claude = command('claude', { mode: 'full', system: 'Return files as fenced blocks.' });
  assert.equal(claude[claude.indexOf('--append-system-prompt') + 1], 'Return files as fenced blocks.');
  assert.ok(!command('claude', { mode: 'full' }).includes('--append-system-prompt'));
  assert.deepEqual(command('codex', { mode: 'auto' }).slice(0, 2), ['--search', 'exec']);
  assert.equal(signedOut('codex', 'Error: Not logged in. Run codex login.'), true);
  assert.equal(signedOut('codex', 'Rate limit reached'), false);
  assert.equal(signedOut('gemini', 'Not logged in'), false);
});

test('a signed-out Claude turn offers Sign in; after the CLI sign-in the same message runs again', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../electron/store');
  const { Runner } = require('../electron/runner');
  const cli = require('../electron/providers/cli');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-signin-')), bin = path.join(home, '.local/bin'), saved = process.env.HOME;
  fs.mkdirSync(bin, { recursive: true });
  // Signed out until `claude auth login --claudeai` runs. The reply reports whether Orin's instructions came as a system prompt.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), marker = path.join(process.env.HOME, 'signed-in');
const args = process.argv.slice(2);
if (args.join(' ') === 'auth login --claudeai') { fs.writeFileSync(marker, ''); process.exit(0); }
let input = '';
process.stdin.on('data', c => { input += c; if (input.includes('\\n')) reply(); });
let sent = false;
function reply() {
  if (sent) return; sent = true;
  const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  if (!fs.existsSync(marker)) out({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', session_id: 's1' });
  else out({ type: 'result', is_error: false, result: 'system=' + args.includes('--append-system-prompt') + ' inPrompt=' + /fenced code block/.test(input), session_id: 's1' });
  process.exit(0);
}
`, { mode: 0o755 });
  process.env.HOME = home;
  try {
    cli.cliPath('claude', true);
    const store = new Store(path.join(home, 'data.json'));
    const workspace = store.addWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'orin-signin-ws-')));
    const thread = store.addThread(workspace.id, { connectionId: 'claude-code', model: 'claude-opus-5-5', effort: '', mode: 'full' });
    let done;
    const runner = new Runner({ store, secrets: { get: () => null, has: () => false }, mcp: { enabledConfigs: () => [], claudeConfigs: async () => [] }, send: (c, v) => { if (c === 'run-state' && !v.running) done(v); } });
    const turn = async options => { const end = new Promise(r => { done = r; }); runner.start(thread.id, options); await end; return store.thread(thread.id).messages; };
    let messages = await turn({ text: 'split the indicator' });
    assert.equal(messages.at(-1).signIn, 'claude-code');
    assert.match(messages.at(-1).error, /Select Sign in/);
    await cli.login('claude');
    messages = await turn({ text: 'split the indicator', editMessageId: messages.at(-2).id });
    assert.equal(messages.length, 2);
    assert.equal(messages.at(-1).error, undefined);
    assert.equal(messages.at(-1).parts.at(-1).text, 'system=true inPrompt=false');
  } finally { process.env.HOME = saved; cli.cliPath('claude', true); }
});
