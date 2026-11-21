const test = require('node:test');
const assert = require('node:assert/strict');

test('download names preserve file names, map Pine Script aliases, and recognize unlabeled Pine scripts', async () => {
  const { snippetName } = await import('../renderer/file-names.mjs');
  for (const language of ['pine', 'pinescript', 'pine-script', 'pinescript6', 'PineScript']) assert.equal(snippetName(language), 'snippet.pine');
  assert.equal(snippetName('pinescript', 'KeyLevels.pine'), 'KeyLevels.pine');
  assert.equal(snippetName('python', 'title="app.py"'), 'app.py');
  assert.equal(snippetName('KeyLevels.pine'), 'KeyLevels.pine');
  assert.equal(snippetName('', '', '//@version=6\nindicator("Key Levels")\nplot(close)'), 'Key_Levels.pine');
  assert.equal(snippetName('text', '', '//@version=5\nindicator(title="Sessions")'), 'Sessions.pine');
  assert.equal(snippetName('solidity'), 'snippet.sol');
  assert.equal(snippetName('dockerfile'), 'Dockerfile');
  assert.equal(snippetName(''), 'snippet.txt');
});
