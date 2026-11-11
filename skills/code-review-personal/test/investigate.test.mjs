import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueIds, parseOutput, slug } from '../investigate.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(TEST_DIR, '..', 'investigate.mjs');
const FAKE_PI = path.join(TEST_DIR, 'fake-pi.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo }).toString().trim();
}

// A repo with a base commit and one PR commit on top. Returns { repo, base, fake }.
function makeRepo({ ignore = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test-'));
  const repo = path.join(dir, 'repo');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(fake);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const a = 2;\nconst b = a + 1;\n');
  git(repo, 'commit', '-q', '-am', 'pr');
  if (ignore) fs.appendFileSync(path.join(repo, '.git/info/exclude'), 'temp-pr-review/\n');
  return { repo, base, fake };
}

function cli(ctx, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ctx.repo,
    env: { ...process.env, CODE_REVIEW_PERSONAL_PI_BIN: FAKE_PI, FAKE_PI_DIR: ctx.fake, ...env },
  });
  return { code: r.status, out: JSON.parse(r.stdout.toString()), stderr: r.stderr.toString() };
}

function behave(ctx, model, behavior) {
  fs.writeFileSync(path.join(ctx.fake, `${slug(model)}.behavior`), behavior);
}

function calls(ctx) {
  const file = path.join(ctx.fake, 'calls.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => {
    const [model, message] = l.split('|');
    return { model, message };
  });
}

async function waitDone(ctx, round, env = {}) {
  for (let i = 0; i < 60; i++) {
    const r = cli(ctx, ['wait', '--round', String(round), '--timeout', '1'], env);
    if (r.out.status !== 'running') return r.out;
  }
  throw new Error('round never finished');
}

const roundDir = (ctx, n) => path.join(ctx.repo, 'temp-pr-review', `round-${n}`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('parseOutput takes the last json block, accepts unfenced JSON, rejects bad output', () => {
  assert.equal(parseOutput('```json\n{"findings":[{"t":1}]}\n```\nx\n```json\n{"findings":[{"t":2}]}\n```').findings[0].t, 2);
  assert.deepEqual(parseOutput('  {"findings": []}  ').findings, []);
  assert.equal(parseOutput('no json'), null);
  assert.equal(parseOutput('```json\n{"other": 1}\n```'), null);
});

test('parseOutput ignores ``` quoted inside JSON strings and falls back to an earlier valid block', () => {
  const quoted = 'Notes.\n```json\n{"findings": [{"evidence": "the last fenced ```json block is cut at the first ```"}]}\n```\n';
  assert.equal(parseOutput(quoted).findings[0].evidence, 'the last fenced ```json block is cut at the first ```');
  const lastBroken = '```json\n{"findings": [{"t": 1}]}\n```\n```json\n{"findings": [,]}\n```\n';
  assert.equal(parseOutput(lastBroken).findings[0].t, 1);
  assert.deepEqual(parseOutput('```json\r\n{"findings": []}\r\n```\r\n').findings, []);
});

test('slug replaces characters that are unsafe in file names', () => {
  assert.equal(slug('openrouter/z-ai/glm-5.3-flash'), 'openrouter_z-ai_glm-5.3-flash');
});

test('runs all models in parallel, returns fast, uses slugs on disk and original IDs in results', async () => {
  const ctx = makeRepo();
  const models = ['openrouter/a/one', 'openrouter/b/two'];
  models.forEach((m) => behave(ctx, m, 'slow_ok'));
  fs.mkdirSync(path.join(ctx.repo, 'temp-pr-review'));
  fs.writeFileSync(path.join(ctx.repo, 'temp-pr-review/pr.md'), 'PR TITLE MARKER');
  fs.writeFileSync(path.join(ctx.repo, 'temp-pr-review/prior.md'), 'PRIOR MARKER');
  const brief = path.join(ctx.fake, 'brief.md');
  fs.writeFileSync(brief, 'BRIEF MARKER');

  const started = Date.now();
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', models.join(','), '--brief', brief]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out, { status: 'running', round: 1 });
  assert.ok(Date.now() - started < 2000, 'run should return immediately');

  const done = await waitDone(ctx, 1);
  // Both slow models ran at the same time: total well under 2 × 3 s.
  assert.ok(Date.now() - started < 5500, 'models should run in parallel');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.results.map((x) => x.model), models);
  assert.ok(done.results.every((x) => x.ok && x.findings.length === 1));
  assert.ok(fs.existsSync(path.join(roundDir(ctx, 1), 'openrouter_a_one.json')));

  const prompt = fs.readFileSync(path.join(roundDir(ctx, 1), 'prompt.md'), 'utf8');
  for (const marker of ['# Role', 'BRIEF MARKER', 'PR TITLE MARKER', 'temp-pr-review/round-1/diff.patch', 'PRIOR MARKER']) {
    assert.ok(prompt.includes(marker), `prompt should include ${marker}`);
  }
  assert.ok(fs.readFileSync(path.join(roundDir(ctx, 1), 'diff.patch'), 'utf8').includes('const b = a + 1;'));
});

test('a model that times out twice is reported as failed, retried with the same model', async () => {
  const ctx = makeRepo();
  const env = { CODE_REVIEW_PERSONAL_TIMEOUT_SEC: '1' };
  behave(ctx, 'm/slow', 'timeout');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/slow,m/fine'], env);
  const done = await waitDone(ctx, 1, env);
  const slow = done.results.find((x) => x.model === 'm/slow');
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /timeout, then timeout/);
  assert.equal(done.results.find((x) => x.model === 'm/fine').ok, true);
  assert.deepEqual(calls(ctx).filter((c) => c.model === 'm/slow').length, 2);
});

test('invalid JSON is retried once with the same model and a nudge', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'invalid_then_ok');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const done = await waitDone(ctx, 1);
  assert.equal(done.results[0].ok, true);
  const c = calls(ctx);
  assert.equal(c.length, 2);
  assert.ok(c.every((x) => x.model === 'm/x'), 'retry must use the same model');
  assert.match(c[1].message, /Return only the JSON block/);
  assert.doesNotMatch(c[0].message, /Return only the JSON block/);
});

test('output with several JSON blocks uses the last one', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'multi');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const done = await waitDone(ctx, 1);
  assert.equal(done.results[0].findings[0].title, 'last');
});

test('valid JSON with a non-zero exit counts as success; a crash twice fails', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/exit1', 'exit1_valid');
  behave(ctx, 'm/crash', 'crash');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/exit1,m/crash']);
  const done = await waitDone(ctx, 1);
  assert.equal(done.results.find((x) => x.model === 'm/exit1').ok, true);
  const crash = done.results.find((x) => x.model === 'm/crash');
  assert.equal(crash.ok, false);
  assert.match(crash.reason, /exit code 2, then exit code 2/);
  assert.equal(calls(ctx).filter((c) => c.model === 'm/exit1').length, 1);
});

test('wait reports running with finished/pending, then done', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/slow', 'slow_ok');
  behave(ctx, 'm/fast', 'ok');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/slow,m/fast']);
  // Poll instead of a fixed sleep, so a slow machine doesn't make this flaky.
  for (let i = 0; i < 50 && !fs.existsSync(path.join(roundDir(ctx, 1), 'm_fast.json')); i++) await sleep(100);
  const mid = cli(ctx, ['wait', '--round', '1', '--timeout', '0']).out;
  assert.equal(mid.status, 'running');
  assert.deepEqual(mid.finished, ['m/fast']);
  assert.deepEqual(mid.pending, ['m/slow']);
  assert.equal((await waitDone(ctx, 1)).status, 'done');
});

test('a killed runner is reported as died; a second run skips finished models', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/a', 'ok');
  behave(ctx, 'm/b', 'hang');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/a,m/b']);
  for (let i = 0; i < 40 && !fs.existsSync(path.join(roundDir(ctx, 1), 'm_a.json')); i++) await sleep(100);
  const runner = Number(fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8'));
  const orphan = Number(fs.readFileSync(path.join(ctx.fake, 'm_b.pid'), 'utf8'));
  process.kill(runner, 'SIGKILL');
  await sleep(200);
  assert.equal(cli(ctx, ['wait', '--round', '1', '--timeout', '0']).out.status, 'died');
  assert.equal(alive(orphan), true, 'pi outlives a SIGKILLed runner');

  behave(ctx, 'm/b', 'ok');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/a,m/b']);
  await sleep(300);
  assert.equal(alive(orphan), false, 'a new run kills the orphaned pi first');
  const done = await waitDone(ctx, 1);
  assert.ok(done.results.every((x) => x.ok));
  assert.equal(calls(ctx).filter((c) => c.model === 'm/a').length, 1, 'finished model must not run again');
});

test('stop kills pi processes whose runner already died', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'hang');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const piPidFile = path.join(ctx.fake, 'm_x.pid');
  for (let i = 0; i < 40 && !fs.existsSync(piPidFile); i++) await sleep(100);
  await sleep(200);
  process.kill(Number(fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8')), 'SIGKILL');
  const orphan = Number(fs.readFileSync(piPidFile, 'utf8'));
  assert.deepEqual(cli(ctx, ['stop']).out, { stopped: 0 });
  await sleep(300);
  assert.equal(alive(orphan), false);
});

test('a missing pi binary fails the model cleanly instead of crashing the runner', async () => {
  const ctx = makeRepo();
  const env = { CODE_REVIEW_PERSONAL_PI_BIN: path.join(ctx.fake, 'no-such-pi') };
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x'], env);
  const done = await waitDone(ctx, 1, env);
  assert.equal(done.status, 'done');
  assert.equal(done.results[0].ok, false);
  assert.match(done.results[0].reason, /spawn failed/);
});

test('retrying a round whose models all failed calls the models again', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'crash');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  assert.equal((await waitDone(ctx, 1)).results[0].ok, false);
  behave(ctx, 'm/x', 'ok');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const done = await waitDone(ctx, 1);
  assert.equal(done.results[0].ok, true);
  assert.equal(calls(ctx).length, 3);
});

test('wait rejects a non-numeric timeout', () => {
  const ctx = makeRepo();
  fs.mkdirSync(roundDir(ctx, 1), { recursive: true });
  fs.writeFileSync(path.join(roundDir(ctx, 1), 'models.json'), '[]');
  assert.equal(cli(ctx, ['wait', '--round', '1', '--timeout', 'abc']).out.error, 'bad_args');
});

test('an unreadable --brief fails before anything is written', () => {
  const ctx = makeRepo();
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--brief', path.join(ctx.fake, 'missing.md')]);
  assert.equal(r.out.error, 'bad_args');
  assert.equal(fs.existsSync(roundDir(ctx, 1)), false);
});

test('run while a runner is alive does not start a second one', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'slow_ok');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const pid = fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8');
  const again = cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  assert.equal(again.out.status, 'running');
  assert.equal(fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8'), pid);
  await waitDone(ctx, 1);
  assert.equal(calls(ctx).length, 1);
});

test('a diff over 200 KB is refused and names the largest files', () => {
  const ctx = makeRepo();
  fs.writeFileSync(path.join(ctx.repo, 'src/big.txt'), 'x'.repeat(100) + '\n'.repeat(1) + 'line\n'.repeat(60000));
  git(ctx.repo, 'add', '.');
  git(ctx.repo, 'commit', '-q', '-m', 'big');
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base]);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, 'diff_too_large');
  assert.match(r.out.message, /Please make the PR smaller/);
  assert.match(r.out.message, /src\/big\.txt/);
  assert.equal(fs.existsSync(roundDir(ctx, 1)), false);
});

test('lockfiles do not count toward the size limit', async () => {
  const ctx = makeRepo();
  fs.mkdirSync(path.join(ctx.repo, 'web'));
  fs.writeFileSync(path.join(ctx.repo, 'web/package-lock.json'), '"dep",\n'.repeat(60000));
  git(ctx.repo, 'add', '.');
  git(ctx.repo, 'commit', '-q', '-m', 'deps');
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.ok(!fs.readFileSync(path.join(roundDir(ctx, 1), 'diff.patch'), 'utf8').includes('package-lock'));
  await waitDone(ctx, 1);
});

test('verify mode reviews only the fix commits, with the fixed-issues list and verdicts', async () => {
  const ctx = makeRepo();
  const prHead = git(ctx.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ctx.repo, 'src/a.js'), 'const a = 2;\nconst b = a + 1;\nconst c = b * 2;\n');
  git(ctx.repo, 'commit', '-q', '-am', 'round 1 fixes');
  fs.mkdirSync(path.join(ctx.repo, 'temp-pr-review'));
  const fixed = path.join(ctx.repo, 'temp-pr-review/fixed-round-1.md');
  fs.writeFileSync(fixed, 'R1-1 | M | src/a.js:3 | FIXED LIST MARKER');
  fs.writeFileSync(path.join(ctx.repo, 'temp-pr-review/prior.md'), 'PRIOR MARKER');
  behave(ctx, 'm/x', 'verdicts');

  const r = cli(ctx, ['run', '--round', '2', '--mode', 'verify', '--since', prHead, '--fixed', fixed, '--models', 'm/x']);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const diff = fs.readFileSync(path.join(roundDir(ctx, 2), 'diff.patch'), 'utf8');
  assert.ok(diff.includes('const c = b * 2;'), 'fix commit is in the diff');
  assert.ok(!diff.includes('-const a = 1;'), 'the earlier PR change is not');
  const prompt = fs.readFileSync(path.join(roundDir(ctx, 2), 'prompt.md'), 'utf8');
  assert.ok(prompt.includes('You verify fixes'), 'uses the verify template');
  assert.ok(prompt.includes('FIXED LIST MARKER'));
  assert.ok(!prompt.includes('PRIOR MARKER'), 'verify rounds do not need the full history');

  const done = await waitDone(ctx, 2);
  assert.deepEqual(done.results[0].verdicts.map((v) => [v.id, v.fixed]), [['R1-1', true], ['R1-2', false]]);
  const text = spawnSync(process.execPath, [SCRIPT, 'wait', '--round', '2', '--format', 'text'], { cwd: ctx.repo }).stdout.toString();
  assert.match(text, /verdict R1-1: fixed/);
  assert.match(text, /verdict R1-2: NOT FIXED \(still fails\)/);
});

// A repo with a PR commit and a fix commit on top, ready for a verify round.
function makeVerifyRepo(fixedText) {
  const ctx = makeRepo();
  ctx.prHead = git(ctx.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ctx.repo, 'src/a.js'), 'const a = 2;\nconst b = a + 1;\nconst c = b * 2;\n');
  git(ctx.repo, 'commit', '-q', '-am', 'round 1 fixes');
  fs.mkdirSync(path.join(ctx.repo, 'temp-pr-review'));
  ctx.fixed = path.join(ctx.repo, 'temp-pr-review/fixed-round-1.md');
  fs.writeFileSync(ctx.fixed, fixedText);
  return ctx;
}

const verifyArgs = (ctx) => ['run', '--round', '2', '--mode', 'verify', '--since', ctx.prHead, '--fixed', ctx.fixed, '--models', 'm/x'];

test('parseOutput validates per mode: full needs findings, verify needs verdicts', () => {
  const verdictsOnly = '```json\n{"verdicts": [{"id": "R1-1", "fixed": true}]}\n```';
  const findingsOnly = '```json\n{"findings": []}\n```';
  assert.equal(parseOutput(verdictsOnly), null);
  assert.deepEqual(parseOutput(verdictsOnly, 'verify').findings, []);
  assert.equal(parseOutput(findingsOnly, 'verify'), null);
  assert.deepEqual(issueIds('R1-1 | x\nR1-2 | see R1-1\nR10-3'), ['R1-1', 'R1-2', 'R10-3']);
});

test('a verify answer with verdicts but no findings is accepted', async () => {
  const ctx = makeVerifyRepo('R1-1 | M | src/a.js:3 | title | evidence | change');
  behave(ctx, 'm/x', 'verdicts_only');
  cli(ctx, verifyArgs(ctx));
  const done = await waitDone(ctx, 2);
  assert.equal(done.results[0].ok, true);
  assert.deepEqual(done.results[0].findings, []);
  assert.equal(done.results[0].verdicts[0].fixed, false);
  assert.equal(calls(ctx).length, 1);
});

test('a verify answer without verdicts is retried, then fails', async () => {
  const ctx = makeVerifyRepo('R1-1 | M | src/a.js:3 | title | evidence | change');
  behave(ctx, 'm/x', 'ok');
  cli(ctx, verifyArgs(ctx));
  const done = await waitDone(ctx, 2);
  assert.equal(done.results[0].ok, false);
  assert.equal(calls(ctx).length, 2);
  assert.match(calls(ctx)[1].message, /Return only the JSON block/);
});

test('issues a model gave no verdict for are reported as missing', async () => {
  const ctx = makeVerifyRepo('R1-1 | …\nR1-2 | …\nR1-3 | …');
  behave(ctx, 'm/x', 'verdicts');
  cli(ctx, verifyArgs(ctx));
  const done = await waitDone(ctx, 2);
  assert.deepEqual(done.results[0].missingVerdicts, ['R1-3']);
  const text = spawnSync(process.execPath, [SCRIPT, 'wait', '--round', '2', '--format', 'text'], { cwd: ctx.repo }).stdout.toString();
  assert.match(text, /missing verdicts: R1-3/);
});

test('wait --format text skips malformed findings instead of failing', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'null_finding');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  await waitDone(ctx, 1);
  const r = spawnSync(process.execPath, [SCRIPT, 'wait', '--round', '1', '--format', 'text'], { cwd: ctx.repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /L undefined undefined:undefined real/);
});

test('verify mode requires --since and --fixed, and rejects unknown modes', () => {
  const ctx = makeRepo();
  assert.equal(cli(ctx, ['run', '--round', '2', '--mode', 'verify', '--fixed', 'x.md']).out.error, 'bad_args');
  assert.equal(cli(ctx, ['run', '--round', '2', '--mode', 'verify', '--since', ctx.base]).out.error, 'bad_args');
  assert.equal(cli(ctx, ['run', '--round', '2', '--mode', 'quick', '--base', ctx.base]).out.error, 'bad_args');
  const missing = cli(ctx, ['run', '--round', '2', '--mode', 'verify', '--since', ctx.base, '--fixed', path.join(ctx.fake, 'nope.md')]);
  assert.equal(missing.out.error, 'bad_args');
  assert.equal(fs.existsSync(roundDir(ctx, 2)), false);
});

test('an empty diff is refused', () => {
  const ctx = makeRepo();
  const r = cli(ctx, ['run', '--round', '1', '--base', 'HEAD']);
  assert.equal(r.out.error, 'empty_diff');
});

test('a lockfile-only change is refused with its own error', () => {
  const ctx = makeRepo();
  const before = git(ctx.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ctx.repo, 'go.sum'), 'x\n');
  git(ctx.repo, 'add', '.');
  git(ctx.repo, 'commit', '-q', '-m', 'deps');
  assert.equal(cli(ctx, ['run', '--round', '1', '--base', before]).out.error, 'lockfiles_only');
});

test('stop and run never kill a process that merely reuses a recorded PID', async () => {
  const ctx = makeRepo();
  const dir = roundDir(ctx, 1);
  fs.mkdirSync(dir, { recursive: true });
  // An unrelated, live process group leader stands in for a reused PID.
  const { spawn } = await import('node:child_process');
  const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dir, 'runner.pid'), String(stranger.pid));
    fs.writeFileSync(path.join(dir, 'm_x.pi.pid'), String(stranger.pid));
    assert.deepEqual(cli(ctx, ['stop']).out, { stopped: 0 });
    await sleep(200);
    assert.equal(alive(stranger.pid), true, 'stop must not kill it');

    fs.writeFileSync(path.join(dir, 'm_x.pi.pid'), String(stranger.pid));
    cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
    // run prints "running" either way; only a finished round proves it didn't
    // mistake the stranger for a live runner and skip starting one.
    assert.equal((await waitDone(ctx, 1)).status, 'done', 'run must not mistake it for a live runner');
    assert.equal(calls(ctx).length, 1);
    assert.equal(alive(stranger.pid), true, 'run must not kill it');
  } finally {
    process.kill(-stranger.pid, 'SIGKILL');
  }
});

test('unexpected errors still produce a JSON error object', () => {
  const ctx = makeRepo();
  // Passes the temp-dir checks, then mkdir of round-1 fails because it's a file.
  fs.mkdirSync(path.join(ctx.repo, 'temp-pr-review'));
  fs.writeFileSync(path.join(ctx.repo, 'temp-pr-review/round-1'), 'a file, not a folder');
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base]);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, 'internal_error');
});

test('refuses and writes nothing when temp-pr-review/ is not ignored', () => {
  const ctx = makeRepo({ ignore: false });
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base]);
  assert.equal(r.out.error, 'temp_dir_not_ignored');
  assert.equal(fs.existsSync(path.join(ctx.repo, 'temp-pr-review')), false);
});

test('refuses when the repo tracks temp-pr-review/', () => {
  const ctx = makeRepo();
  fs.mkdirSync(path.join(ctx.repo, 'temp-pr-review'));
  fs.writeFileSync(path.join(ctx.repo, 'temp-pr-review/real.txt'), 'tracked');
  git(ctx.repo, 'add', '-f', 'temp-pr-review/real.txt');
  git(ctx.repo, 'commit', '-q', '-m', 'tracked');
  const r = cli(ctx, ['run', '--round', '1', '--base', ctx.base]);
  assert.equal(r.out.error, 'temp_dir_tracked');
});

test('rejects bad --models values', () => {
  const ctx = makeRepo();
  assert.equal(cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'a,b,c,d,e,f']).out.error, 'bad_args');
  assert.equal(cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'a,a']).out.error, 'bad_args');
  assert.equal(cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'x/a,x_a']).out.error, 'bad_args');
  assert.equal(cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'x/Bar,x/bar']).out.error, 'bad_args');
});

test('stop kills the runner and its pi processes', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'hang');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const piPidFile = path.join(ctx.fake, 'm_x.pid');
  for (let i = 0; i < 40 && !fs.existsSync(piPidFile); i++) await sleep(100);
  const runner = Number(fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8'));
  const pi = Number(fs.readFileSync(piPidFile, 'utf8'));
  assert.deepEqual(cli(ctx, ['stop']).out, { stopped: 1 });
  await sleep(500);
  assert.equal(alive(runner), false);
  assert.equal(alive(pi), false);
  assert.deepEqual(cli(ctx, ['stop']).out, { stopped: 0 });
});

test('deleting temp-pr-review/ makes the runner exit and kill pi', async () => {
  const ctx = makeRepo();
  behave(ctx, 'm/x', 'hang');
  cli(ctx, ['run', '--round', '1', '--base', ctx.base, '--models', 'm/x']);
  const piPidFile = path.join(ctx.fake, 'm_x.pid');
  for (let i = 0; i < 40 && !fs.existsSync(piPidFile); i++) await sleep(100);
  const runner = Number(fs.readFileSync(path.join(roundDir(ctx, 1), 'runner.pid'), 'utf8'));
  const pi = Number(fs.readFileSync(piPidFile, 'utf8'));
  fs.rmSync(path.join(ctx.repo, 'temp-pr-review'), { recursive: true, force: true });
  await sleep(3000);
  assert.equal(alive(runner), false);
  assert.equal(alive(pi), false);
});
