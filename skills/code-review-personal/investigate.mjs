#!/usr/bin/env node
// Runs the investigator models for one review round in parallel, in the background.
// Subcommands: run, wait, stop. Each prints exactly one JSON object to stdout.
// See SKILL.md for how the review master uses it.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(SCRIPT);
const TEMP_NAME = 'temp-pr-review';
const DEFAULT_MODELS = [
  'openrouter/z-ai/glm-5.3-flash',
  'openrouter/deepseek/deepseek-v4-pro-0813',
  'openrouter/anthropic/claude-haiku-5.5',
];
const MAX_DIFF_BYTES = 200 * 1024;
const PI_BIN = process.env.CODE_REVIEW_PERSONAL_PI_BIN || 'pi';
const TIMEOUT_MS = Number(process.env.CODE_REVIEW_PERSONAL_TIMEOUT_SEC || 600) * 1000;
const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'Cargo.lock', 'Gemfile.lock',
  'Podfile.lock', 'poetry.lock', 'uv.lock', 'composer.lock', 'go.sum', 'Package.resolved',
];
const PI_FLAGS = [
  '-p', '--no-session', '--no-approve', '--no-mcp', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--tools', 'read,grep,find,ls',
];
const BASE_MESSAGE = 'Follow the attached instructions.';
const JSON_NUDGE = 'Return only the JSON block from the contract.';

// ---------- helpers ----------

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(error, message) {
  print({ error, message });
  process.stderr.write(`${error}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail('bad_args', `unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail('bad_args', `missing value for ${a}`);
    args[a.slice(2)] = next;
    i++;
  }
  return args;
}

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024, ...opts });
}

function repoRoot() {
  try {
    return git(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim();
  } catch {
    fail('not_a_repo', 'Run this from inside a git repository.');
  }
}

export function slug(model) {
  return model.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

// Write to a temp file and rename, so readers never see a half-written file.
function writeAtomic(file, data) {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
}

// Kills pi processes left behind by a runner that died without cleaning up.
function killOrphans(roundDir) {
  if (!fs.existsSync(roundDir)) return;
  for (const entry of fs.readdirSync(roundDir)) {
    if (!entry.endsWith('.pi.pid')) continue;
    const file = path.join(roundDir, entry);
    const pid = readPid(file);
    if (isAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(file, { force: true });
  }
}

function roundNumber(args) {
  const n = Number(args.round);
  if (!Number.isInteger(n) || n < 1) fail('bad_args', '--round must be a positive integer');
  return n;
}

// Takes the last fenced ```json block, or the whole output if there is none.
export function parseOutput(text) {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
  const candidate = blocks.length ? blocks[blocks.length - 1][1] : text.trim();
  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.findings)) return null;
  return obj;
}

// Splits a unified diff into per-file sizes, largest first.
function largestFiles(diff, count) {
  const sizes = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const m = chunk.match(/^diff --git a\/(.+?) b\//);
    if (m) sizes.push({ file: m[1], bytes: Buffer.byteLength(chunk) });
  }
  return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

// ---------- run ----------

function cmdRun(args) {
  const root = repoRoot();
  const n = roundNumber(args);
  if (!args.base) fail('bad_args', '--base <sha> is required');
  const models = args.models ? args.models.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_MODELS;
  if (models.length < 1 || models.length > 5) fail('bad_args', '--models needs 1 to 5 entries');
  if (new Set(models).size !== models.length) fail('bad_args', '--models has duplicates');
  if (new Set(models.map(slug)).size !== models.length) fail('bad_args', '--models has entries that map to the same file name');

  if (git(root, ['ls-files', TEMP_NAME]).toString().trim()) {
    fail('temp_dir_tracked', `The repo tracks files under ${TEMP_NAME}/, so it can't be used as the temp dir.`);
  }
  try {
    git(root, ['check-ignore', '-q', `${TEMP_NAME}/`]);
  } catch {
    fail('temp_dir_not_ignored', `${TEMP_NAME}/ is not git-ignored. Add it to .git/info/exclude first.`);
  }

  const temp = path.join(root, TEMP_NAME);
  const roundDir = path.join(temp, `round-${n}`);
  const pidFile = path.join(roundDir, 'runner.pid');
  if (isAlive(readPid(pidFile))) {
    print({ status: 'running', round: n });
    return;
  }

  const excludes = LOCKFILES.map((f) => `:(exclude,glob)**/${f}`);
  let diff;
  try {
    diff = git(root, ['diff', args.base, 'HEAD', '--', ...excludes]).toString();
  } catch (e) {
    fail('git_diff_failed', String(e.stderr || e.message).trim());
  }
  const size = Buffer.byteLength(diff);
  if (size === 0) fail('empty_diff', `No changes between ${args.base} and HEAD (lockfiles not counted).`);
  if (size > MAX_DIFF_BYTES) {
    const top = largestFiles(diff, 3).map((f) => `${f.file} (${kb(f.bytes)})`).join(', ');
    fail('diff_too_large', `PR diff is ${kb(size)}; the limit is ${kb(MAX_DIFF_BYTES)}. Please make the PR smaller. Largest files: ${top}.`);
  }

  // Build the prompt first, so a bad --brief fails before anything is written.
  const prompt = buildPrompt(temp, n, args.brief);
  fs.mkdirSync(roundDir, { recursive: true });
  killOrphans(roundDir);
  // A new runner retries failed models, so drop old failures and the done marker.
  for (const entry of fs.readdirSync(roundDir)) {
    if (entry.endsWith('.failed') || entry === 'done') fs.rmSync(path.join(roundDir, entry), { force: true });
  }
  fs.writeFileSync(path.join(roundDir, 'diff.patch'), diff);
  fs.writeFileSync(path.join(roundDir, 'models.json'), JSON.stringify(models.map((model) => ({ model, slug: slug(model) }))));
  fs.writeFileSync(path.join(roundDir, 'prompt.md'), prompt);

  const log = fs.openSync(path.join(roundDir, 'runner.log'), 'a');
  const child = spawn(process.execPath, [SCRIPT, '_runner', '--round', String(n)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  print({ status: 'running', round: n });
}

function buildPrompt(temp, n, briefPath) {
  const parts = [fs.readFileSync(path.join(SKILL_DIR, 'investigator.md'), 'utf8')];
  if (briefPath) {
    let brief;
    try {
      brief = fs.readFileSync(path.resolve(briefPath), 'utf8');
    } catch {
      fail('bad_args', `Can't read --brief file: ${briefPath}`);
    }
    parts.push(`# Brief from the user\n\n${brief}`);
  }
  const prMd = path.join(temp, 'pr.md');
  if (fs.existsSync(prMd)) parts.push(`# Pull request\n\n${fs.readFileSync(prMd, 'utf8')}`);
  parts.push(`# Diff to review\n\nThe full diff is in \`${TEMP_NAME}/round-${n}/diff.patch\`. Read it first.`);
  const prior = path.join(temp, 'prior.md');
  if (fs.existsSync(prior)) parts.push(`# Earlier findings and decisions\n\n${fs.readFileSync(prior, 'utf8')}`);
  return parts.join('\n\n---\n\n') + '\n';
}

// ---------- runner (internal, detached) ----------

async function cmdRunner(args) {
  const root = process.cwd();
  const n = roundNumber(args);
  const temp = path.join(root, TEMP_NAME);
  const roundDir = path.join(temp, `round-${n}`);
  const models = JSON.parse(fs.readFileSync(path.join(roundDir, 'models.json'), 'utf8'));
  const prompt = path.join(roundDir, 'prompt.md');
  const children = new Set();

  const killAll = () => {
    for (const c of children) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {}
    }
  };
  process.on('SIGTERM', () => {
    killAll();
    process.exit(143);
  });
  // Exit when the temp dir is deleted, so an aborted review stops calling models.
  const watch = setInterval(() => {
    if (!fs.existsSync(temp)) {
      killAll();
      process.exit(0);
    }
  }, 2000);

  const runPi = (model, attempt, nudge) =>
    new Promise((resolve) => {
      const out = path.join(roundDir, `${slug(model)}.attempt${attempt}.txt`);
      const outFd = fs.openSync(out, 'w');
      const errFd = fs.openSync(path.join(roundDir, `${slug(model)}.attempt${attempt}.stderr.txt`), 'w');
      const message = nudge ? `${BASE_MESSAGE} ${JSON_NUDGE}` : BASE_MESSAGE;
      const child = spawn(PI_BIN, [...PI_FLAGS, '--model', model, `@${prompt}`, message], {
        cwd: root,
        detached: true,
        stdio: ['ignore', outFd, errFd],
      });
      children.add(child);
      // Recorded so run/stop can kill it if this runner dies without cleaning up.
      const piPidFile = path.join(roundDir, `${slug(model)}.pi.pid`);
      if (child.pid) fs.writeFileSync(piPidFile, String(child.pid));
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, TIMEOUT_MS);
      // 'exit' can follow 'error'; closing the fds twice would crash the runner.
      const finish = (code, spawnError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        fs.rmSync(piPidFile, { force: true });
        fs.closeSync(outFd);
        fs.closeSync(errFd);
        const parsed = spawnError ? null : parseOutput(fs.readFileSync(out, 'utf8'));
        // Valid JSON counts as success even if pi exited non-zero.
        if (parsed) resolve({ ok: true, parsed });
        else if (spawnError) resolve({ ok: false, reason: `spawn failed: ${spawnError.message}` });
        else if (timedOut) resolve({ ok: false, reason: 'timeout' });
        else resolve({ ok: false, reason: code === 0 ? 'invalid JSON' : `exit code ${code}`, invalidJson: code === 0 });
      };
      child.on('error', (e) => finish(null, e));
      child.on('exit', (code) => finish(code));
    });

  await Promise.all(
    models.map(async ({ model, slug: s }) => {
      const ok = path.join(roundDir, `${s}.json`);
      const failed = path.join(roundDir, `${s}.failed`);
      if (fs.existsSync(ok)) return;
      const first = await runPi(model, 1, false);
      // Retry once, always with the same model.
      const result = first.ok ? first : await runPi(model, 2, first.invalidJson);
      if (result.ok) {
        writeAtomic(ok, JSON.stringify({ model, findings: result.parsed.findings, attempts: first.ok ? 1 : 2 }));
      } else {
        writeAtomic(failed, JSON.stringify({ model, reason: `${first.reason}, then ${result.reason}` }));
      }
    }),
  );

  clearInterval(watch);
  if (fs.existsSync(roundDir)) fs.writeFileSync(path.join(roundDir, 'done'), '');
}

// ---------- wait ----------

function roundStatus(roundDir) {
  const models = JSON.parse(fs.readFileSync(path.join(roundDir, 'models.json'), 'utf8'));
  const finished = [];
  const pending = [];
  const results = [];
  for (const { model, slug: s } of models) {
    const ok = path.join(roundDir, `${s}.json`);
    const failed = path.join(roundDir, `${s}.failed`);
    if (fs.existsSync(ok)) {
      finished.push(model);
      results.push({ model, ok: true, findings: JSON.parse(fs.readFileSync(ok, 'utf8')).findings });
    } else if (fs.existsSync(failed)) {
      finished.push(model);
      results.push({ model, ok: false, reason: JSON.parse(fs.readFileSync(failed, 'utf8')).reason });
    } else {
      pending.push(model);
    }
  }
  return { finished, pending, results };
}

function printWait(obj, args) {
  if (args.format !== 'text') return print(obj);
  const lines = [obj.status, (obj.finished ?? []).join(',')];
  if (obj.pending) lines.push(obj.pending.join(','));
  for (const r of obj.results ?? []) {
    lines.push(`== ${r.model} ${r.ok === false ? r.reason : ''}`.trimEnd());
    for (const f of r.findings ?? []) {
      lines.push(` ${f.logaf} ${f.category} ${f.file}:${f.line} ${f.title}`);
      lines.push(`    evidence: ${f.evidence}`);
      lines.push(`    fix: ${f.suggested_fix} [${f.confidence}]`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdWait(args) {
  if (args.format !== undefined && args.format !== 'text' && args.format !== 'json') fail('bad_args', '--format must be text or json');
  const root = repoRoot();
  const n = roundNumber(args);
  const timeoutSec = Number(args.timeout ?? 90);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) fail('bad_args', '--timeout must be a non-negative number of seconds');
  const timeoutMs = timeoutSec * 1000;
  const roundDir = path.join(root, TEMP_NAME, `round-${n}`);
  if (!fs.existsSync(path.join(roundDir, 'models.json'))) fail('no_round', `Round ${n} was never started.`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(path.join(roundDir, 'done'))) {
      const { results } = roundStatus(roundDir);
      printWait({ status: 'done', round: n, results }, args);
      return;
    }
    if (!isAlive(readPid(path.join(roundDir, 'runner.pid')))) {
      printWait({ status: 'died', round: n }, args);
      return;
    }
    if (Date.now() >= deadline) {
      const { finished, pending } = roundStatus(roundDir);
      printWait({ status: 'running', round: n, finished, pending }, args);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------- stop ----------

function cmdStop() {
  const temp = path.join(repoRoot(), TEMP_NAME);
  let stopped = 0;
  if (fs.existsSync(temp)) {
    for (const entry of fs.readdirSync(temp)) {
      if (!/^round-\d+$/.test(entry)) continue;
      const pid = readPid(path.join(temp, entry, 'runner.pid'));
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          stopped++;
        } catch {}
      }
      // Also catches pi processes whose runner already died.
      killOrphans(path.join(temp, entry));
    }
  }
  print({ stopped });
}

// ---------- main ----------

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'run') cmdRun(args);
  else if (cmd === '_runner') await cmdRunner(args);
  else if (cmd === 'wait') await cmdWait(args);
  else if (cmd === 'stop') cmdStop();
  else fail('bad_args', 'Usage: investigate.mjs run|wait|stop [options]');
}
