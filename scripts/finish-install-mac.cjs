// Run under launchd, outside Orin. A saved final reply is the handoff: never quit the app during its live turn.
// The private JSON config supplies dataFile, threadId, userMessageId, marker, staged, installed, and backup.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function replySaved(data, config) {
  const messages = data.threads?.find(t => t.id === config.threadId)?.messages || [];
  const lastUser = messages.findLast(m => m.role === 'user');
  const last = messages.at(-1);
  return lastUser?.id === config.userMessageId && last?.role === 'assistant' && !last.stopped && !last.error
    && last.parts?.some(p => p.type === 'text' && p.text.includes(config.marker));
}

// Only the newest backup stays: each update makes one, and each is about 360 MB.
// Runs after a successful install, so the backup that was just made is the one kept.
function pruneBackups(keep) {
  const dir = path.dirname(keep);
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!/^\.orin-previous-[0-9a-f-]+\.app$/.test(name) || file === keep) continue;
    fs.rmSync(file, { recursive: true, force: true });
    removed.push(file);
  }
  return removed;
}

async function finish(config) {
  const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', timeout: 120000 });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const saved = () => { try { return replySaved(JSON.parse(fs.readFileSync(config.dataFile, 'utf8')), config); } catch { return false; } };
  const executable = path.join(config.installed, 'Contents/MacOS/Orin');
  const running = () => execFileSync('/bin/ps', ['-axo', 'comm'], { encoding: 'utf8' }).split('\n').some(line => line.trim() === executable);
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  if (!fs.existsSync(path.join(config.staged, 'Contents/Resources/app.asar'))) throw new Error('The staged app is missing.');
  if (fs.existsSync(config.backup)) throw new Error('Backup destination already exists.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', config.staged]);
  log('Verified staged app. Waiting for the final reply to be saved.');
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!saved()) {
    if (Date.now() >= deadline) throw new Error('No completed handoff reply within 30 minutes. Orin was left open.');
    await sleep(2000);
  }
  log('Final reply saved. Giving the UI time to display it.');
  await sleep(15000);
  if (!saved()) throw new Error('The conversation changed after the handoff. Orin was left open.');
  if (running()) run('/usr/bin/osascript', ['-e', 'tell application "Orin" to quit']);
  for (let i = 0; running(); i++) {
    if (i >= 30) throw new Error('Orin did not quit normally. Nothing was replaced.');
    await sleep(1000);
  }
  log('Orin stopped normally. Installing verified build.');
  let backedUp = false, installedNew = false;
  try {
    if (fs.existsSync(config.installed)) { fs.renameSync(config.installed, config.backup); backedUp = true; }
    fs.renameSync(config.staged, config.installed); installedNew = true;
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', config.installed]);
    run('/usr/bin/open', [config.installed]);
    let started = false;
    for (let i = 0; i < 30; i++) { if (running()) { started = true; break; } await sleep(1000); }
    if (!started) throw new Error('The updated app did not start.');
    await sleep(5000);
    if (!running()) throw new Error('The updated app stopped immediately after launch.');
    // Keep the previous copy for recovery; it is hidden from Finder and Spotlight.
    log(`Installation complete. Updated Orin is running at ${config.installed}. Previous app: ${backedUp ? config.backup : 'none'}`);
    if (backedUp) for (const file of pruneBackups(config.backup)) log(`Removed older backup ${file}`);
  } catch (error) {
    // Restore only when no app is running, so rollback cannot interrupt a session.
    if (!running()) {
      if (installedNew) fs.renameSync(config.installed, config.staged);
      if (backedUp) { fs.renameSync(config.backup, config.installed); run('/usr/bin/open', [config.installed]); }
    }
    throw error;
  }
}

module.exports = { replySaved, pruneBackups };
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const unload = () => {
    if (config.launchLabel) try { execFileSync('/bin/launchctl', ['remove', config.launchLabel], { stdio: 'ignore' }); } catch {}
  };
  finish(config).then(unload, error => { console.error(`${new Date().toISOString()} ${error.stack || error}`); process.exitCode = 1; unload(); });
}
