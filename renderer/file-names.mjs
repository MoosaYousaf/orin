// Code fence languages to file extensions, for snippet downloads.
const EXTENSIONS = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  json: 'json', jsonl: 'jsonl', html: 'html', css: 'css', scss: 'scss', csv: 'csv', tsv: 'tsv', markdown: 'md', md: 'md', yaml: 'yaml', yml: 'yml', toml: 'toml',
  sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', ruby: 'rb', rb: 'rb',
  php: 'php', xml: 'xml', svg: 'svg', mermaid: 'mermaid', mmd: 'mermaid', text: 'txt', txt: 'txt', plaintext: 'txt', diff: 'diff', dockerfile: 'Dockerfile', makefile: 'Makefile', lua: 'lua', r: 'r', dart: 'dart', pine: 'pine', pinescript: 'pine', 'pine-script': 'pine', pinescript5: 'pine', pinescript6: 'pine', pine5: 'pine', pine6: 'pine', solidity: 'sol', elixir: 'ex', erlang: 'erl', haskell: 'hs', julia: 'jl', perl: 'pl', powershell: 'ps1', ps1: 'ps1', batch: 'bat', vue: 'vue', svelte: 'svelte', graphql: 'graphql', glsl: 'glsl', hlsl: 'hlsl'
};
export const LABELS = { html: 'HTML', css: 'CSS', json: 'JSON', csv: 'CSV', tsv: 'TSV', sql: 'SQL', svg: 'SVG', xml: 'XML', go: 'Go', js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', py: 'Python', sh: 'Shell', md: 'Markdown', rs: 'Rust', rb: 'Ruby', cs: 'C#', cpp: 'C++', kt: 'Kotlin', yml: 'YAML', yaml: 'YAML', txt: 'Text', mermaid: 'Mermaid', pine: 'Pine Script' };

// The file name for a snippet: a name in the fence info (```python app.py or title="app.py"), else snippet.<ext>.
export function snippetName(language, meta = '', text = '') {
  const named = meta.match(/(?:title|file(?:name)?)=["']?([^"'\s]+)/)?.[1] || meta.split(/\s+/).find(t => /^[\w.\-/]+\.[a-z0-9]+$/i.test(t));
  if (named) return named.split('/').pop();
  if (/^[\w.\-/]+\.[a-z0-9]+$/i.test(language)) return language.split('/').pop();
  if (/^\s*\/\/@version=\d+/m.test(text)) {
    const title = text.match(/\b(?:indicator|strategy|library)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/)?.[1];
    const stem = title?.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 90);
    return `${stem || 'snippet'}.pine`;
  }
  const extension = EXTENSIONS[language?.toLowerCase()] || (language && /^[a-z0-9]{1,8}$/i.test(language) ? language.toLowerCase() : 'txt');
  return /^[A-Z]/.test(extension) ? extension : `snippet.${extension}`;
}

