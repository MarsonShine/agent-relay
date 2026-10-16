import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { probe, fixtureAccepted } from './process-probe.mts';
import { approvalConfig } from './approval-config.mts';

const action = process.argv[2];
const approval = approvalConfig(process.env.RELAY_M0_APPROVAL);
const root = resolve(process.env.RELAY_M0_ROOT ?? '.agent-relay/m0');
const workspace = join(root, 'workspace');
const binary = process.env.RELAY_CODEX_BIN;
const model = process.env.RELAY_CODEX_MODEL;
const allowed = ['setup','inspect','edit','resume','permission','cancel','invalid-effort','no-auth'];
if (!allowed.includes(action)) throw new Error('Action: ' + allowed.join('|'));
if (!binary || !model) throw new Error('Set RELAY_CODEX_BIN and RELAY_CODEX_MODEL explicitly.');
await mkdir(root, { recursive: true });
const statePath = join(root, 'state.json');
const schemaPath = join(root, 'result-schema.json');
const state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{"calls":0}'));

if (action === 'setup') {
  try { await access(statePath); throw new Error('Existing experiment: choose a new RELAY_M0_ROOT.'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(workspace);
  await writeFile(join(workspace, 'AGENTS.md'), '# Probe workspace\nOnly inspect or edit files in this fixture as requested. Never access external services or credentials. No subagents.\n');
  await writeFile(join(workspace, 'math.cjs'), 'exports.add = (a, b) => a - b;\n');
  await writeFile(join(workspace, 'check.cjs'), "const assert=require('node:assert/strict');const {add}=require('./math.cjs');assert.equal(add(2,3),5);console.log('PASS');\n");
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  await writeFile(schemaPath, JSON.stringify({type:'object',properties:{
    status:{type:'string'},summary:{type:'string'},files:{type:'array',items:{type:'string'}}
  },required:['status','summary','files'],additionalProperties:false}));
  await writeFile(statePath, JSON.stringify({calls:0}));
  console.log('Fixture initialized. No model called.');
  process.exit(0);
}

const raw = join(root, approval.mode === 'never' ? action : action + '-auto-review');
await mkdir(raw); // Refuse accidental repeat/overwrite of evidence.
const common = ['exec', '--ignore-user-config', '--json', '-m', model,
  '-c', 'model_reasoning_effort="low"', ...approval.args,
  '-s', action === 'inspect' || action === 'permission' ? 'read-only' : 'workspace-write',
  '-C', workspace, '--output-schema', schemaPath, '-o', join(raw, 'final.json')];
let args = [...common, '-'];
let env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PSMODULEPATH|LANG|LC_ALL|TERM|CI)$/i.test(key) || (/^CODEX_/.test(key) && key !== 'CODEX_API_KEY')));
let input = '';
if (action === 'inspect') input = 'Read math.cjs and check.cjs, run node check.cjs, identify the violated contract and expected repair. Do not edit files. Return the requested JSON.';
if (action === 'edit') input = 'Inspect math.cjs and check.cjs. Explain the arithmetic contract briefly, fix math.cjs so addition works for finite numbers, then run node check.cjs. Do not edit the checker. Return JSON.';
if (action === 'resume') {
  if (!state.sessionId) throw new Error('Run edit first.');
  // Global exec options precede resume; child options differ from first invocation.
  args = ['exec','--ignore-user-config','-s','workspace-write','-C',workspace,
    ...approval.args,'-c','model_reasoning_effort="low"',
    'resume','--json','-m',model,'--output-schema',schemaPath,'-o',join(raw,'final.json'),state.sessionId,'-'];
  input = 'Continue the same fixture. Add a new check to check.cjs asserting add(-2,3) === 1. Preserve the earlier assertion. Run node check.cjs. State what the preceding implementation fixed. Return JSON.';
}
if (action === 'permission') input = 'This is an intentional read-only permission probe. Attempt exactly once to create denied.txt with content probe via the file-write tool. Do not seek escalation or a workaround. Report whether the operation was denied, using JSON.';
if (action === 'cancel') {
  try { await access(join(workspace, 'heartbeat.json')); throw new Error('Existing heartbeat evidence; refusing stale cancellation observation.'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(workspace, 'heartbeat.cjs'), "const fs=require('node:fs');const tick=()=>fs.writeFileSync('heartbeat.json',JSON.stringify({pid:process.pid,at:Date.now()}));tick();const timer=setInterval(tick,50);setTimeout(()=>clearInterval(timer),30000);\n");
  input = 'Cancellation experiment. Run node heartbeat.cjs as a foreground command and wait. This trusted fixture writes heartbeat.json for at most 30 seconds. Do not modify the script or start background/detached processes. The parent controller will cancel after observing actual tool activity.';
}
if (action === 'invalid-effort') {
  args = ['exec','--ignore-user-config','--json','-m',model,'-c','model_reasoning_effort="invalid-m0-option"','-'];
  input = 'Return OK.';
}
if (action === 'no-auth') {
  const emptyHome = join(root, 'empty-codex-home');
  await mkdir(emptyHome);
  env = { ...env, CODEX_HOME: emptyHome };
  for (const key of Object.keys(env)) if (/^(OPENAI|CODEX)_API_KEY$/.test(key)) delete env[key];
  args = ['exec','--ignore-user-config','--json','-C',workspace,'-m',model,
    '-c','model_provider="m0_no_auth"',
    '-c','model_providers.m0_no_auth={name="M0 unauthenticated",base_url="https://api.openai.com/v1",env_key="RELAY_M0_ABSENT_KEY",wire_api="responses"}','-'];
  delete env.RELAY_M0_ABSENT_KEY;
  input = 'Return OK.';
}
if (action !== 'no-auth') {
  if (state.calls >= 6) throw new Error('Six-call experiment budget exhausted.');
  state.calls++;
  await writeFile(statePath, JSON.stringify(state, null, 2));
}
input += ' Use status completed only when the requested work succeeded; otherwise use blocked or denied.';
const before = await readFile(join(workspace, 'math.cjs'), 'utf8');
const abort = new AbortController();
let heartbeatObserved = false;
const heartbeatPath = join(workspace, 'heartbeat.json');
const watcher = action === 'cancel' ? setInterval(async () => {
  if (heartbeatObserved) return;
  try {
    const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8'));
    if (Number.isInteger(heartbeat.pid)) { heartbeatObserved = true; abort.abort(); }
  } catch {}
}, 50) : undefined;
const result = await probe(binary, args, {
  cwd: workspace, input, env, timeoutMs: 180000,
  signal: abort.signal,
});
clearInterval(watcher);
await writeFile(join(raw, 'stdout.jsonl'), result.stdout);
await writeFile(join(raw, 'stderr.txt'), result.stderr);
const summary: any = { ...result, approvalMode: approval.mode, events: undefined, stdout: undefined, stderr: undefined,
  eventTypes: [...new Set(result.events.map(e => e.type))],
  usage: result.events.findLast(e => e.type === 'turn.completed')?.usage ?? null,
  requestedModel: model, requestedReasoning: action === 'invalid-effort' ? 'invalid-m0-option' : action === 'no-auth' ? null : 'low',
  modelUsedVerified: false, schemaValid: false };
try {
  const final = JSON.parse(await readFile(join(raw,'final.json'),'utf8'));
  summary.agentStatus = final.status;
  summary.schemaValid = typeof final.status === 'string' && typeof final.summary === 'string' &&
    Array.isArray(final.files) && final.files.every((f: unknown) => typeof f === 'string') &&
    Object.keys(final).sort().join(',') === 'files,status,summary';
} catch {}
summary.mathUnchanged = before === await readFile(join(workspace, 'math.cjs'), 'utf8');
summary.check = spawnSync(process.execPath, ['check.cjs'], { cwd: workspace, encoding: 'utf8' }).status;
summary.deniedFileExists = await access(join(workspace,'denied.txt')).then(()=>true,()=>false);
summary.taskAccepted = ['edit','resume'].includes(action) ? fixtureAccepted(result.outcome, summary.agentStatus, summary.schemaValid, summary.check) : null;
if (action === 'edit' && result.outcome === 'turn_completed') {
  state.sessionId = result.events.find(e => e.type === 'thread.started')?.thread_id;
  if (!state.sessionId) throw new Error('No resumable session ID.');
  await writeFile(statePath, JSON.stringify(state,null,2));
}
if (action === 'cancel') {
  summary.heartbeatObserved = heartbeatObserved;
  summary.heartbeatStopped = false;
  summary.toolProcessStopped = false;
  if (heartbeatObserved) {
    const first = await readFile(heartbeatPath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 500));
    summary.heartbeatStopped = first === await readFile(heartbeatPath, 'utf8');
    try { process.kill(JSON.parse(first).pid, 0); }
    catch (error: any) { summary.toolProcessStopped = error.code === 'ESRCH'; }
  }
}
await writeFile(join(raw,'summary.json'), JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
