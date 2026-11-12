import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { uploadSite, qiniuEtag } from './upload-qiniu.mjs';

const config = { accessKey: 'test-ak', secretKey: 'test-sk', bucket: 'test-bucket' };
const files = ['index.html', 'ota/index.html', 'ota/batch.html', 'ota/firmware.json', 'ota/src/app.mjs', 'sw.js', 'manifest.webmanifest', 'pyodide/123456abcdef/pyodide.asm.wasm', 'assets/main-12345678.js', 'icons/icon-maskable-512.png', 'ota-redirect.html'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'slogic-qiniu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), 'fixture:' + file);
  }
  return root;
}
function publish(dist, cfg, fetcher) {
  return uploadSite(dist, cfg, (url, init) => init.method === 'GET'
    ? Promise.resolve({ ok: false, status: 612 }) : fetcher(url, init), async () => {});
}
function ack(key) { return { ok: true, json: async () => ({ key, hash: 'qiniu-etag' }) }; }

test('publishes actual bytes with WASM/module MIME; resources finish before HTML and SW', async t => {
  const root = await fixture(t);
  const completed = [], forms = new Map();
  const result = await publish(root, config, async (url, { body, signal }) => {
    assert.equal(url, 'https://up-z2.qiniup.com/');
    assert.ok(signal instanceof AbortSignal);
    const key = body.get('key');
    if (key.endsWith('.html')) assert.equal(completed.filter(k => !k.endsWith('.html') && k !== 'sw.js').length, files.length - 5);
    if (key === 'sw.js') assert.equal(completed.length, files.length - 1);
    assert.equal(await body.get('file').text(), 'fixture:' + key);
    forms.set(key, body);
    await new Promise(resolve => setTimeout(resolve, key.endsWith('.wasm') ? 25 : 1));
    completed.push(key);
    return ack(key);
  });
  assert.equal(result.files, files.length);
  assert.equal(forms.get(files[7]).get('file').type, 'application/wasm');
  assert.equal(forms.get('ota/src/app.mjs').get('file').type, 'text/javascript');
  for (const key of files.slice(0, 7)) assert.equal(forms.get(key).get('x-qn-meta-!Cache-Control'), 'no-cache', key);
  assert.equal(forms.get('assets/main-12345678.js').get('x-qn-meta-!Cache-Control'), null);
  assert.equal(forms.get('icons/icon-maskable-512.png').get('x-qn-meta-!Cache-Control'), 'no-cache');
  for (const key of files.filter(k => k.endsWith('.html'))) assert.equal(forms.get(key).get('x-qn-meta-!Cache-Control'), 'no-cache', key);
  const token = forms.get('sw.js').get('token').split(':');
  const policy = JSON.parse(Buffer.from(token[2], 'base64url'));
  assert.equal(policy.scope, 'test-bucket:sw.js');
});

test('failed dependency retries, blocks HTML/SW, and returns failure', async t => {
  const root = await fixture(t), calls = [];
  await assert.rejects(publish(root, config, async (_, { body }) => {
    const key = body.get('key'); calls.push(key);
    return key.endsWith('.wasm') ? { ok: false, status: 503 } : ack(key);
  }), /upload failed.*wasm.*HTTP 503/);
  assert.equal(calls.filter(k => k.endsWith('.wasm')).length, 3);
  assert.equal(calls.some(k => k.endsWith('.html') || k === 'sw.js'), false);
});

test('invalid success body is a failure, not an upload acknowledgement', async t => {
  const root = await fixture(t);
  await assert.rejects(publish(root, config, async () => ack('wrong-key')), /invalid upload acknowledgement/);
});

test('incomplete artifact or missing credentials cannot start any upload', async t => {
  const root = await fixture(t);
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error('unexpected fetch'); };
  await assert.rejects(publish(root, { ...config, bucket: '' }, noFetch), /required/);
  await rm(join(root, 'ota/batch.html'));
  await assert.rejects(publish(root, config, noFetch), /artifact missing ota\/batch.html/);
  assert.equal(calls, 0);
});

test('reupload reapplies mutable metadata and refuses a foreign credential recipient', async t => {
  const root = await fixture(t), controls = [];
  const fetcher = async (_, { body }) => { if (body.get('key') === 'sw.js') controls.push(body.get('x-qn-meta-!Cache-Control')); return ack(body.get('key')); };
  await publish(root, config, fetcher);
  await publish(root, config, fetcher);
  assert.deepEqual(controls, ['no-cache', 'no-cache']);
  await assert.rejects(publish(root, { ...config, uploadHost: 'https://example.com' }, fetcher), /upload host/);
});


test('bare OTA directory redirect preserves query/hash and always stays on this site', async () => {
  const html = await readFile(new URL('./ota-redirect.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [search, hash] of [['', ''], ['?a=1.2&return=https://example.com', '#demo'], ['?demo=1', '#a%20b']]) {
    let destination;
    runInNewContext(script, { location: { search, hash, replace: value => { destination = value; } } });
    assert.equal(destination, '/ota/' + search + hash);
  }
  assert.match(html, /href="\/ota\/"/);
});

test('unchanged large WASM is verified and skipped instead of timing out on reupload', async t => {
  const root = await fixture(t), wasm = files[7];
  const data = Buffer.alloc(4194305, 0x61);
  await writeFile(join(root, wasm), data);
  let wasmUploads = 0;
  const result = await uploadSite(root, config, async (url, { method, body }) => {
    if (method === 'GET') {
      const entry = Buffer.from(new URL(url).pathname.slice('/stat/'.length), 'base64url').toString();
      return entry.endsWith(':' + wasm)
        ? { ok: true, status: 200, json: async () => ({ hash: 'lieGn00gWdbfwEIHaUpzu4drHeun', type: 0, fsize: data.length, mimeType: 'application/wasm', 'x-qn-meta': null }) }
        : { ok: false, status: 612 };
    }
    const key = body.get('key');
    if (key === wasm) { wasmUploads++; throw new Error('simulated WASM upload timeout'); }
    return ack(key);
  }, async () => {});
  assert.equal(wasmUploads, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.uploaded, files.length - 1);
});

// Fixed vectors cross-checked against the official Qiniu Python SDK's etag().
test('ETag covers empty, exact 4 MiB, multiple blocks and a partial final block', () => {
  for (const [size, want] of [[0, 'Fto5o-5ea0sNMlW_75VgGJCv2AcJ'], [4194304, 'FuwQ-vpd56Izwiom1JHzCIdrQa4_'], [4194305, 'lieGn00gWdbfwEIHaUpzu4drHeun'], [9437184, 'lo-Big7b5RTsoCkykeYLTTzo72ZD']]) {
    assert.equal(qiniuEtag(Buffer.alloc(size, 0x61)), want, String(size));
  }
});

function statKey(url) {
  assert.equal(new URL(url).origin, 'https://rs-z2.qiniuapi.com');
  const entry = Buffer.from(new URL(url).pathname.slice('/stat/'.length), 'base64url').toString();
  assert.ok(entry.startsWith('test-bucket:'));
  return entry.slice('test-bucket:'.length);
}
function metadata(key) {
  return { type: 0, hash: qiniuEtag(Buffer.from('fixture:' + key)), fsize: Buffer.byteLength('fixture:' + key), mimeType: key.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'x-qn-meta': null };
}

test('matching immutable objects skip, but mutable entry points always reapply metadata', async t => {
  const root = await fixture(t), lookedUp = [], posted = new Map();
  const result = await uploadSite(root, config, async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (init.method === 'GET') {
      assert.match(init.headers.Authorization, /^QBox test-ak:/);
      const key = statKey(url); lookedUp.push(key);
      return { ok: true, status: 200, json: async () => metadata(key) };
    }
    const key = init.body.get('key'); posted.set(key, init.body);
    return ack(key);
  }, async () => {});
  assert.deepEqual(new Set(lookedUp), new Set([files[7], 'assets/main-12345678.js']));
  assert.equal(result.skipped, 2);
  assert.equal(result.uploaded + result.skipped, files.length);
  for (const key of files.filter(k => !lookedUp.includes(k))) {
    assert.equal(posted.get(key).get('x-qn-meta-!Cache-Control'), 'no-cache', key);
  }
});

test('hash, size, MIME or cache mismatch forces upload of an existing object', async t => {
  for (const patch of [{ hash: 'different' }, { fsize: 1 }, { mimeType: 'application/octet-stream' }, { 'x-qn-meta': { '!Cache-Control': 'no-cache' } }]) {
    const root = await fixture(t), uploaded = [];
    await uploadSite(root, config, async (url, { method, body }) => {
      if (method === 'GET') {
        const key = statKey(url);
        return { ok: true, status: 200, json: async () => ({ ...metadata(key), ...patch }) };
      }
      uploaded.push(body.get('key')); return ack(body.get('key'));
    }, async () => {});
    assert.ok(uploaded.includes(files[7]), JSON.stringify(patch));
    assert.ok(uploaded.includes('assets/main-12345678.js'));
  }
});

test('stat permission errors fail immediately and block HTML/SW publication', async t => {
  const root = await fixture(t), posted = [], delays = [];
  await assert.rejects(uploadSite(root, config, async (_, { method, body }) => {
    if (method === 'GET') return { ok: false, status: 403 };
    posted.push(body.get('key')); return ack(body.get('key'));
  }, async ms => { delays.push(ms); }), /stat failed.*HTTP 403/);
  assert.deepEqual(delays, []);
  assert.equal(posted.some(k => k.endsWith('.html') || k === 'sw.js'), false);
});

test('transient stat failure backs off; an unreadable response never becomes a skip', async t => {
  const root = await fixture(t), delays = [];
  let wasmStats = 0;
  const result = await uploadSite(root, config, async (url, { method, body }) => {
    if (method === 'GET') {
      const key = statKey(url);
      if (key === files[7]) {
        wasmStats++;
        if (wasmStats === 1) return { ok: false, status: 429 };
      }
      return { ok: true, status: 200, json: async () => metadata(key) };
    }
    return ack(body.get('key'));
  }, async ms => { delays.push(ms); });
  assert.equal(wasmStats, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal(result.skipped, 2);
  await assert.rejects(uploadSite(root, config, async (_, { method, body }) => method === 'GET'
    ? { ok: true, status: 200, json: async () => ({ hash: 'missing fields' }) } : ack(body.get('key')), async () => {}), /invalid object metadata/);
});

test('missing objects upload with bounded network retries and exponential backoff', async t => {
  const root = await fixture(t), delays = [];
  let wasmUploads = 0;
  const result = await uploadSite(root, config, async (_, { method, body }) => {
    if (method === 'GET') return { ok: false, status: 612 };
    const key = body.get('key');
    if (key === files[7] && ++wasmUploads < 3) throw new Error('temporary connection timeout');
    return ack(key);
  }, async ms => { delays.push(ms); });
  assert.equal(wasmUploads, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(result.skipped, 0);
  assert.equal(result.uploaded, files.length);
});

test('network request concurrency is bounded at two', async t => {
  const root = await fixture(t);
  let active = 0, peak = 0;
  await uploadSite(root, config, async (_, { method, body }) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    return method === 'GET' ? { ok: false, status: 612 } : ack(body.get('key'));
  }, async () => {});
  assert.equal(peak, 2);
});

test('encoding, download headers and lifecycle overrides cannot qualify as unchanged', async t => {
  for (const patch of [{ contentEncoding: 'aws-chunked' }, { contentEncoding: 'gzip' }, { cacheControl: 'no-cache' }, { contentDisposition: 'attachment' }, { contentLanguage: 'en' }, { expires: 'tomorrow' }, { expiration: 1 }, { transitionToARCHIVE: 1 }, { transitionToDeepArchive: 1 }, { 'x-qn-meta': { '!Content-Encoding': 'aws-chunked' } }]) {
    const root = await fixture(t), posted = [];
    await uploadSite(root, config, async (url, { method, body }) => {
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ...metadata(statKey(url)), ...patch }) };
      posted.push(body.get('key')); return ack(body.get('key'));
    }, async () => {});
    assert.ok(posted.includes(files[7]), JSON.stringify(patch));
  }
});

test('disabled or archived objects fail closed without undoing their policies', async t => {
  for (const patch of [{ status: 1 }, { type: 2 }, { type: 3 }, { type: 2, restoreStatus: 2 }]) {
    const root = await fixture(t), posted = [];
    await assert.rejects(uploadSite(root, config, async (url, { method, body }) => {
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ...metadata(statKey(url)), ...patch }) };
      posted.push(body.get('key')); return ack(body.get('key'));
    }, async () => {}), /disabled|archived/);
    assert.equal(posted.some(k => k.endsWith('.html') || k === 'sw.js'), false);
  }
});

test('array custom metadata is rejected instead of being treated as absent', async t => {
  const root = await fixture(t);
  await assert.rejects(uploadSite(root, config, async (url, { method, body }) => method === 'GET'
    ? { ok: true, status: 200, json: async () => ({ ...metadata(statKey(url)), 'x-qn-meta': [] }) }
    : ack(body.get('key')), async () => {}), /invalid object metadata/);
});

test('non-JSON response text never appears in retry logs or errors', async t => {
  const root = await fixture(t), messages = [], original = console.warn;
  console.warn = (...args) => messages.push(args.join(' '));
  t.after(() => { console.warn = original; });
  for (const brokenStep of ['stat', 'upload']) {
    let caught;
    try {
      await uploadSite(root, config, async (_, { method, body }) => {
        if (brokenStep === 'stat' && method === 'GET') return new Response('auditbody', { status: 200 });
        if (method === 'GET') return { ok: false, status: 612 };
        if (brokenStep === 'upload') return new Response('auditbody', { status: 200 });
        return ack(body.get('key'));
      }, async () => {});
    } catch (error) { caught = error; }
    assert.ok(caught);
    assert.equal(messages.join('\n').includes('auditbody'), false);
    assert.equal(caught.message.includes('auditbody'), false);
  }
});
