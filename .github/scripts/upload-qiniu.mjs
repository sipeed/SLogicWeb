// Publish the exact Pages artifact to Kodo. Keep old objects for open tabs/rollback.
// Resources -> HTML -> sw.js: a new worker must never see an incomplete release.
import { createHash, createHmac } from 'node:crypto';
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

// Kodo's content ETag: SHA-1 for <=4 MiB, or SHA-1 of block digests above that.
export function qiniuEtag(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += 4194304) {
    blocks.push(createHash('sha1').update(data.subarray(offset, offset + 4194304)).digest());
  }
  const digest = blocks.length > 1
    ? createHash('sha1').update(Buffer.concat(blocks)).digest()
    : blocks[0] || createHash('sha1').digest();
  return q64(Buffer.concat([Buffer.from([blocks.length > 1 ? 0x96 : 0x16]), digest]));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const httpError = status => Object.assign(new Error('HTTP ' + status), {
  retryable: status === 408 || status === 429 || (status >= 500 && status < 600),
});
const invalid = message => Object.assign(new Error(message), { retryable: false });
async function responseJson(response, operation) {
  try { return await response.json(); }
  catch { throw new Error('invalid ' + operation + ' JSON response'); }
}

export async function uploadSite(dist, config, fetcher = fetch, pause = delay) {
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
  let uploaded = 0, skipped = 0;
  async function retry(operation, key, action) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await action(); }
      catch (error) {
        if (error.retryable === false || attempt === 3) {
          throw new Error(operation + ' failed for ' + key + ': ' + error.message);
        }
        // Names and status only; never log response bodies or signed headers.
        console.warn('retry ' + operation + ' ' + key + ' after attempt ' + attempt + ': ' + error.message);
        await pause(1000 * 2 ** (attempt - 1));
      }
    }
  }
  async function stat(key) {
    const path = '/stat/' + q64(bucket + ':' + key);
    const signature = q64(createHmac('sha1', secretKey).update(path + '\n').digest());
    return retry('stat', key, async () => {
      const response = await fetcher('https://rs-z2.qiniuapi.com' + path, {
        method: 'GET', headers: { Authorization: 'QBox ' + accessKey + ':' + signature },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch {}
        if (response.status === 612) return null; // Kodo: object does not exist.
        throw httpError(response.status);
      }
      const value = await responseJson(response, 'stat');
      if (!value || typeof value.hash !== 'string' || !Number.isSafeInteger(value.fsize) || value.fsize < 0 || typeof value.mimeType !== 'string'
        || !Number.isInteger(value.type) || value.type < 0 || value.type > 5
        || (value.status != null && value.status !== 0 && value.status !== 1)
        || (value['x-qn-meta'] != null && (typeof value['x-qn-meta'] !== 'object' || Array.isArray(value['x-qn-meta'])))) {
        throw invalid('invalid object metadata');
      }
      // Publishing must not undo a disable flag or an archive policy.
      if (value.status === 1) throw invalid('object is disabled');
      if (value.type === 2 || value.type === 3) throw invalid('object is archived; explicit storage policy review required');
      return value;
    });
  }
  async function upload(file) {
    const data = await readFile(file.path);
    const mime = MIME[extname(file.key).toLowerCase()] || 'application/octet-stream';
    // Query-stamped OTA modules and all unversioned entry points must revalidate.
    // Only content-addressed files are allowed a persistent browser cache.
    const immutable = !file.key.endsWith('.html') && !file.key.startsWith('ota/') && !file.key.startsWith('icons/') && (
      /-[A-Za-z0-9_-]{8,}\.[a-z0-9.]+$/.test(file.key) || /^pyodide\/[a-f0-9]{8,}\//.test(file.key)
    );
    if (immutable) {
      const existing = await stat(file.key);
      const canonicalHeaders = existing && ['contentEncoding', 'cacheControl', 'contentDisposition', 'contentLanguage', 'expires']
        .every(key => existing[key] == null || existing[key] === '');
      const noLifecycleChange = existing && ['expiration', 'transitionToARCHIVE', 'transitionToDeepArchive']
        .every(key => existing[key] == null || existing[key] === 0);
      if (existing && existing.hash === qiniuEtag(data) && existing.fsize === data.length && existing.mimeType === mime
        && Object.keys(existing['x-qn-meta'] || {}).length === 0 && canonicalHeaders && noLifecycleChange) {
        skipped++;
        return;
      }
    }
    const policy = q64(JSON.stringify({ scope: bucket + ':' + file.key, deadline: Math.floor(Date.now() / 1000) + 3600 }));
    const sign = q64(createHmac('sha1', secretKey).update(policy).digest());
    const form = new FormData();
    form.set('token', accessKey + ':' + sign + ':' + policy);
    form.set('key', file.key);
    if (!immutable) form.set('x-qn-meta-!Cache-Control', 'no-cache');
    form.set('file', new Blob([data], { type: mime }), 'file');
    await retry('upload', file.key, async () => {
      const response = await fetcher(host.href, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch {}
        throw httpError(response.status);
      }
      const result = await responseJson(response, 'upload');
      if (result.key !== file.key || typeof result.hash !== 'string' || !result.hash) throw invalid('invalid upload acknowledgement');
    });
    uploaded++;
  }
  async function uploadGroup(group) {
    // Bound cross-region traffic; stop queuing after failure and await in-flight work.
    let next = 0, failure;
    const results = await Promise.allSettled(Array.from({ length: Math.min(2, group.length) }, async () => {
      while (!failure && next < group.length) {
        try { await upload(group[next++]); }
        catch (error) { failure ||= error; throw error; }
      }
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  const assets = files.filter(f => !f.key.endsWith('.html') && f.key !== 'sw.js');
  const html = files.filter(f => f.key.endsWith('.html'));
  await uploadGroup(assets);
  await uploadGroup(html);
  await uploadGroup(files.filter(f => f.key === 'sw.js'));
  return { files: files.length, assets: assets.length, html: html.length, uploaded, skipped, bucket };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  uploadSite(process.argv[2] || 'dist', {
    accessKey: process.env.QINIU_ACCESS_KEY,
    secretKey: process.env.QINIU_SECRET_KEY,
    bucket: process.env.QINIU_BUCKET,
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
