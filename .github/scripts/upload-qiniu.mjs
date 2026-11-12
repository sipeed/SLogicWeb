// Publish the exact Pages artifact to Kodo. Keep old objects for open tabs/rollback.
// Resources -> HTML -> sw.js: a new worker must never see an incomplete release.
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.zip': 'application/zip', '.map': 'application/json',
  '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
// Qiniu expects URL-safe base64 with padding (Node's base64url omits it).
const q64 = value => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

export async function uploadSite(dist, config, fetcher = fetch) {
  const { accessKey, secretKey, bucket, uploadHost = 'https://up-z2.qiniup.com' } = config;
  if (!accessKey || !secretKey || !bucket) throw new Error('QINIU_ACCESS_KEY, QINIU_SECRET_KEY and QINIU_BUCKET are required');
  // Only Qiniu receives credentials. Test transports can replace fetcher without
  // weakening this production host check.
  const host = new URL(uploadHost);
  if (host.protocol !== 'https:' || host.hostname !== 'up-z2.qiniup.com' || host.port || host.username || host.password || host.pathname !== '/' || host.search || host.hash) {
    throw new Error('upload host must be https://up-z2.qiniup.com (z2 bucket)');
  }
  async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('refusing symlink: ' + path);
      if (entry.isDirectory()) out.push(...await walk(path));
      else if (entry.isFile()) out.push({ path, key: relative(dist, path).split(sep).join('/') });
    }
    return out;
  }
  const files = await walk(dist);
  const keys = new Set(files.map(f => f.key));
  for (const key of ['index.html', 'ota-redirect.html', 'ota/index.html', 'ota/batch.html', 'ota/firmware.json', 'sw.js', 'manifest.webmanifest']) {
    if (!keys.has(key)) throw new Error('artifact missing ' + key);
  }
  if (!files.some(f => f.key.endsWith('.wasm'))) throw new Error('artifact missing Pyodide WASM');
  async function upload(file) {
    const policy = q64(JSON.stringify({ scope: bucket + ':' + file.key, deadline: Math.floor(Date.now() / 1000) + 3600 }));
    const sign = q64(createHmac('sha1', secretKey).update(policy).digest());
    const form = new FormData();
    form.set('token', accessKey + ':' + sign + ':' + policy);
    form.set('key', file.key);
    // Query-stamped OTA modules and all unversioned entry points must revalidate.
    // Only content-addressed files are allowed a persistent browser cache.
    const immutable = !file.key.endsWith('.html') && !file.key.startsWith('ota/') && !file.key.startsWith('icons/') && (
      /-[A-Za-z0-9_-]{8,}\.[a-z0-9.]+$/.test(file.key) || /^pyodide\/[a-f0-9]{8,}\//.test(file.key)
    );
    if (!immutable) form.set('x-qn-meta-!Cache-Control', 'no-cache');
    form.set('file', new Blob([await readFile(file.path)], { type: MIME[extname(file.key).toLowerCase()] || 'application/octet-stream' }), 'file');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetcher(host.href, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (result.key !== file.key || typeof result.hash !== 'string' || !result.hash) throw new Error('invalid upload acknowledgement');
        return;
      } catch (error) { lastError = error; }
    }
    // Never print response bodies, policy tokens, or credential-bearing headers.
    throw new Error('upload failed for ' + file.key + ': ' + lastError.message);
  }
  async function uploadGroup(group) {
    // Await every in-flight upload before reporting failure; do not advance phases.
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, group.length) }, async (_, i) => {
      for (let n = i; n < group.length; n += 8) await upload(group[n]);
    }));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  const assets = files.filter(f => !f.key.endsWith('.html') && f.key !== 'sw.js');
  const html = files.filter(f => f.key.endsWith('.html'));
  await uploadGroup(assets);
  await uploadGroup(html);
  await uploadGroup(files.filter(f => f.key === 'sw.js'));
  return { files: files.length, assets: assets.length, html: html.length, bucket };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  uploadSite(process.argv[2] || 'dist', {
    accessKey: process.env.QINIU_ACCESS_KEY,
    secretKey: process.env.QINIU_SECRET_KEY,
    bucket: process.env.QINIU_BUCKET,
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
