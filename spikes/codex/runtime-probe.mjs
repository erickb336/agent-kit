// Real Codex process, deterministic local Responses server. No external model or delegated work.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.env.SAGE_CODEX_BIN ?? 'codex';
const baseline = process.argv.includes('--no-hooks');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
if (version.error || version.status !== 0) throw new Error('Codex binary unavailable; set SAGE_CODEX_BIN');
const root = mkdtempSync(join(tmpdir(), 'sage-codex-native-'));
const capture = join(root, 'capture.mjs');
const eventsFile = join(root, 'events.jsonl');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(capture, `import {readFileSync,appendFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const keys=['hook_event_name','session_id','turn_id','agent_id','agent_type','tool_name','tool_use_id','tool_input','tool_response','stop_hook_active'];
appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(Object.fromEntries(keys.filter(k=>k in input).map(k=>[k,input[k]])))+'\\n');
`);
let modelRequests = 0, catalogRequests = 0;
const server = http.createServer(async (req, res) => {
  // Consume but do not save prompts, authorization headers, or request bodies.
  for await (const ignored of req) { void ignored; }
  if (req.url.startsWith('/v1/models')) {
    catalogRequests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
  modelRequests++;
  const item = modelRequests === 1
    ? { type: 'function_call', call_id: 'sage-probe-call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf sage-hook-probe', login: false, max_output_tokens: 100 }) }
    : { type: 'message', id: 'sage-probe-message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: `sage-probe-${modelRequests}` } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: `sage-probe-${modelRequests}`, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const args = ['exec', '--strict-config', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-C', root, '-s', 'read-only', '--json'];
const config = {
  model_provider: 'sage_probe', model: 'gpt-5.4', cli_auth_credentials_store: 'ephemeral',
  'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.hooks': !baseline,
  'features.shell_snapshot': false, allow_login_shell: false,
};
for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
args.push('-c', `model_providers.sage_probe={name="Sage local probe",base_url="${base}",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
if (!baseline) {
  // Trust only this invocation's generated, fixed capture script. Approval/sandbox settings stay intact.
  args.push('--dangerously-bypass-hook-trust');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const command = `${quote(process.execPath)} ${quote(capture)}`;
    args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
  }
}
args.push('-');
const env = { ...process.env };
delete env.RUST_LOG;
for (const key of Object.keys(env)) {
  if (key.startsWith('CODEX_FLORA_CCA_') || ['CODEX_EXEC_SERVER_REMOTE_BASE_URL', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_ENVIRONMENT_ID'].includes(key)) delete env[key];
}
const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end('Sage deterministic runtime probe. Do not delegate.');
let output = '', stderr = '', timedOut = false;
child.stdout.on('data', data => output += data);
child.stderr.on('data', data => stderr += data);
const terminate = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 25000);
const kill = setTimeout(() => child.kill('SIGKILL'), 28000);
const result = await new Promise(resolve => {
  child.on('error', error => resolve({ error: error.message }));
  child.on('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(terminate); clearTimeout(kill);
server.closeAllConnections(); server.close();
writeFileSync(join(root, 'runtime.jsonl'), output);
writeFileSync(join(root, 'stderr.txt'), stderr);
const events = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const shellBefore = events.some(e => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Bash' && e.tool_input?.command === 'printf sage-hook-probe');
const shellAfter = events.some(e => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Bash');
const verified = result.code === 0 && modelRequests >= 2 && (baseline || (shellBefore && shellAfter));
const summary = { version: version.stdout.trim(), baseline, ...result, timedOut, catalogRequests, modelRequests, events: events.map(e => e.hook_event_name), verified, artifacts: root };
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!verified) process.exitCode = 1;
