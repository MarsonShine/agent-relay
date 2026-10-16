import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { probe, fixtureAccepted } from './process-probe.mts';

const action = process.argv[2];
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

const raw = join(root, action);
await mkdir(raw); // Refuse accidental repeat/overwrite of evidence.
const common = ['exec', '--ignore-user-config', '--json', '-m', model,
  '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"',
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
    '-c','approval_policy="never"','-c','model_reasoning_effort="low"',
    'resume','--json','-m',model,'--output-schema',schemaPath,'-o',join(raw,'final.json'),state.sessionId,'-'];
  input = 'Continue the same fixture. Add a new check to check.cjs asserting add(-2,3) === 1. Preserve the earlier assertion. Run node check.cjs. State what the preceding implementation fixed. Return JSON.';
}
if (action === 'permission') input = 'This is an intentional read-only permission probe. Attempt exactly once to create denied.txt with content probe via the file-write tool. Do not seek escalation or a workaround. Report whether the operation was denied, using JSON.';
if (action === 'cancel') input = 'Cancellation experiment. Run a foreground shell command that invokes node -e "setInterval(()=>{},1000)" and waits. Do not use background or detached processes. The parent controller will cancel this run. Do not edit files.';
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
const result = await probe(binary, args, {
  cwd: workspace, input, env, timeoutMs: 180000,
  cancelWhen: action === 'cancel' ? e =>
    e.type === 'turn.started' : undefined,
});
await writeFile(join(raw, 'stdout.jsonl'), result.stdout);
await writeFile(join(raw, 'stderr.txt'), result.stderr);
const summary: any = { ...result, events: undefined, stdout: undefined, stderr: undefined,
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
await writeFile(join(raw,'summary.json'), JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
