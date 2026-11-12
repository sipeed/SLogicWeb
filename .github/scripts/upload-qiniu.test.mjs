import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { uploadSite } from './upload-qiniu.mjs';

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
function ack(key) { return { ok: true, json: async () => ({ key, hash: 'qiniu-etag' }) }; }

test('publishes actual bytes with WASM/module MIME; resources finish before HTML and SW', async t => {
  const root = await fixture(t);
  const completed = [], forms = new Map();
  const result = await uploadSite(root, config, async (url, { body, signal }) => {
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
  await assert.rejects(uploadSite(root, config, async (_, { body }) => {
    const key = body.get('key'); calls.push(key);
    return key.endsWith('.wasm') ? { ok: false, status: 503 } : ack(key);
  }), /upload failed.*wasm.*HTTP 503/);
  assert.equal(calls.filter(k => k.endsWith('.wasm')).length, 3);
  assert.equal(calls.some(k => k.endsWith('.html') || k === 'sw.js'), false);
});

test('invalid success body is a failure, not an upload acknowledgement', async t => {
  const root = await fixture(t);
  await assert.rejects(uploadSite(root, config, async () => ack('wrong-key')), /invalid upload acknowledgement/);
});

test('incomplete artifact or missing credentials cannot start any upload', async t => {
  const root = await fixture(t);
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error('unexpected fetch'); };
  await assert.rejects(uploadSite(root, { ...config, bucket: '' }, noFetch), /required/);
  await rm(join(root, 'ota/batch.html'));
  await assert.rejects(uploadSite(root, config, noFetch), /artifact missing ota\/batch.html/);
  assert.equal(calls, 0);
});

test('reupload reapplies mutable metadata and refuses a foreign credential recipient', async t => {
  const root = await fixture(t), controls = [];
  const fetcher = async (_, { body }) => { if (body.get('key') === 'sw.js') controls.push(body.get('x-qn-meta-!Cache-Control')); return ack(body.get('key')); };
  await uploadSite(root, config, fetcher);
  await uploadSite(root, config, fetcher);
  assert.deepEqual(controls, ['no-cache', 'no-cache']);
  await assert.rejects(uploadSite(root, { ...config, uploadHost: 'https://example.com' }, fetcher), /upload host/);
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
