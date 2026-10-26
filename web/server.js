#!/usr/bin/env node
/*
 * html2plugin web backend — the only thing the browser cannot do by itself:
 * commit the pasted page into inbox/ of the forge repo. Uses a repo-scoped
 * deploy key (web/.secrets/deploy_key, never committed), so the user needs no token.
 *
 * Endpoints (all JSON, CORS open, 4xx on errors because the proxy clamps 5xx):
 *   GET  /api/health                 -> { ok, repo, branch, git, ssh, key, clone }
 *   POST /api/generate               -> { slug, path, sha, baseTags }   body: { name, html?, url? }
 *   GET  /api/tags?slug=x            -> { tags: [...] }   (ls-remote; works even when api.github.com quota is gone)
 *   GET  /api/text?url=https://github.com/<repo>/releases/download/...  -> proxied text (REPORT.md / SHA256SUMS)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8000);
const REPO = process.env.H2P_REPO || 'robertcossey19/html2plugin';
const BRANCH = process.env.H2P_BRANCH || 'main';
const ROOT = __dirname;
const KEY = path.join(ROOT, '.secrets', 'deploy_key');
const WORK = path.join(ROOT, 'work');
const CLONE = path.join(WORK, 'repo');
const KNOWN = path.join(WORK, 'known_hosts');
const REMOTE = `git@github.com:${REPO}.git`;
const MAX_BODY = 8 * 1024 * 1024;

fs.mkdirSync(WORK, { recursive: true });
try { fs.chmodSync(KEY, 0o600); } catch (e) { /* missing key is reported by /api/health */ }

const sshCmd = `ssh -i "${KEY}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${KNOWN}" -o BatchMode=yes`;
const gitEnv = Object.assign({}, process.env, {
  GIT_SSH_COMMAND: sshCmd,
  GIT_AUTHOR_NAME: 'html2plugin web', GIT_AUTHOR_EMAIL: 'html2plugin-web@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'html2plugin web', GIT_COMMITTER_EMAIL: 'html2plugin-web@users.noreply.github.com',
  GIT_TERMINAL_PROMPT: '0',
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: gitEnv, cwd: opts.cwd || WORK, timeout: opts.timeout || 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd} ${args.join(' ')} failed: ${(stderr || err.message || '').toString().trim().slice(0, 600)}`; return reject(err); }
      resolve(stdout.toString());
    });
  });
}
const git = (args, opts) => run('git', args, opts);

async function ensureClone() {
  if (fs.existsSync(path.join(CLONE, '.git'))) {
    await git(['fetch', '--depth', '1', 'origin', BRANCH], { cwd: CLONE });
    await git(['reset', '--hard', `origin/${BRANCH}`], { cwd: CLONE });
    await git(['clean', '-fdq'], { cwd: CLONE });
    return;
  }
  fs.rmSync(CLONE, { recursive: true, force: true });
  await git(['clone', '--depth', '1', '--branch', BRANCH, '--single-branch', REMOTE, CLONE], { timeout: 180000 });
}

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

let chain = Promise.resolve();
function serialized(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

async function lsTags(prefix) {
  const out = await git(['ls-remote', '--tags', '--refs', REMOTE, `refs/tags/${prefix}*`]);
  return out.split('\n').filter(Boolean).map(l => l.split(/\s+/)[1].replace('refs/tags/', ''));
}

async function generate({ name, html, url }) {
  const slug = slugify(name);
  if (!slug) throw Object.assign(new Error('plugin name is empty after cleaning (letters, digits, hyphens)'), { status: 400 });
  const useUrl = !(html && html.trim());
  if (useUrl && !/^https?:\/\/\S+$/.test(String(url || '').trim())) throw Object.assign(new Error('paste the page HTML or give an http(s) URL'), { status: 400 });
  if (!useUrl && !/registerProcessor\s*\(/.test(html)) throw Object.assign(new Error('no registerProcessor( in the page: the AudioWorklet module must be inline (template literal, Blob or <script type="worklet">)'), { status: 400 });
  const rel = `inbox/${slug}.${useUrl ? 'url' : 'html'}`;
  const body = useUrl ? String(url).trim() + '\n' : html;

  return serialized(async () => {
    const baseTags = await lsTags(`${slug}-build-`);
    let sha = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !sha; attempt++) {
      try {
        await ensureClone();
        const abs = path.join(CLONE, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const existed = fs.existsSync(abs);
        fs.writeFileSync(abs, body);
        if (existed) {
          // byte-identical resubmission: push would be empty and the path-filtered workflow would not fire -> stamp it
          const same = await git(['status', '--porcelain', '--', rel], { cwd: CLONE });
          if (!same.trim()) fs.appendFileSync(abs, `\n<!-- html2plugin: resubmitted ${new Date().toISOString()} -->\n`);
        }
        await git(['add', rel], { cwd: CLONE });
        await git(['commit', '-q', '-m', `forge: ${slug}${existed ? ' (replace)' : ''}\n\nsubmitted through the html2plugin web app`], { cwd: CLONE });
        await git(['push', 'origin', `HEAD:${BRANCH}`], { cwd: CLONE });
        sha = (await git(['rev-parse', 'HEAD'], { cwd: CLONE })).trim();
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500)); }
    }
    if (!sha) throw lastErr;
    return { slug, path: rel, sha, baseTags, repo: REPO, branch: BRANCH };
  });
}

function send(res, status, obj, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large (8 MB max)'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function health() {
  const out = { ok: false, repo: REPO, branch: BRANCH, key: fs.existsSync(KEY), git: false, ssh: false, clone: false, error: null };
  try { out.git = (await run('git', ['--version'])).trim(); } catch (e) { out.error = e.message; }
  try { await run('ssh', ['-V']); out.ssh = true; } catch (e) { out.ssh = /OpenSSH/.test(e.message); }
  try { await lsTags(''); out.clone = true; } catch (e) { out.error = e.message; }
  out.ok = Boolean(out.key && out.git && out.ssh && out.clone);
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  try {
    if (u.pathname === '/api/health') return send(res, 200, await health());
    if (u.pathname === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await generate(body));
    }
    if (u.pathname === '/api/tags') {
      const slug = slugify(u.searchParams.get('slug'));
      return send(res, 200, { tags: await lsTags(slug ? `${slug}-build-` : '') });
    }
    if (u.pathname === '/api/text') {
      const target = u.searchParams.get('url') || '';
      if (!target.startsWith(`https://github.com/${REPO}/releases/download/`)) return send(res, 400, { error: 'only release assets of the forge repo' });
      const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'html2plugin-web' } });
      if (!r.ok) return send(res, 404, { error: `upstream ${r.status}` });
      const text = await r.text();
      return send(res, 200, text.slice(0, 400000), 'text/plain');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status && e.status < 500 ? e.status : 422;
    return send(res, status, { error: String(e.message || e) });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`html2plugin web backend on :${PORT} -> ${REMOTE} (${BRANCH})`);
  health().then(h => console.log('health', JSON.stringify(h))).catch(() => {});
});
