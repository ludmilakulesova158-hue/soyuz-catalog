#!/usr/bin/env node
// S3-инструменты для бакета каталога (Yandex Object Storage, SigV4 по статическому ключу).
// Ключ: C:\Users\admin\Downloads\soyuz-static-key.txt (строки ID=... и SECRET=...), или env S3KEY.
//
//   node yc/tools/s3.cjs whoami
//   node yc/tools/s3.cjs mkdir <bucket>
//   node yc/tools/s3.cjs cors <bucket>
//   node yc/tools/s3.cjs acl <bucket> public-read
//   node yc/tools/s3.cjs ls <bucket> [prefix]
//   node yc/tools/s3.cjs put <bucket> <key> <file> [cacheSeconds]
//   node yc/tools/s3.cjs get <bucket> <key>
//   node yc/tools/s3.cjs rm <bucket> <key>

const crypto = require('node:crypto');
const fs = require('node:fs');

const HOST = 'storage.yandexcloud.net';
const REGION = 'ru-central1';
const KEY_FILE = process.env.S3KEY || 'C:\\Users\\admin\\Downloads\\soyuz-static-key.txt';

function keys() {
  const text = fs.readFileSync(KEY_FILE, 'utf8');
  const id = (text.match(/^\s*ID\s*=\s*(.+)$/m) || [])[1];
  const secret = (text.match(/^\s*SECRET\s*=\s*(.+)$/m) || [])[1];
  if (!id || !secret) throw new Error('в файле ключа нет ID= или SECRET=');
  return { id: id.trim(), secret: secret.trim() };
}

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function sign(method, path, query, body, extraHeaders) {
  const { id, secret } = keys();
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const headers = Object.assign({ host: HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }, extraHeaders || {});
  const sorted = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sorted.map((k) => k + ':' + String(headers[k]).trim() + '\n').join('');
  const signedHeaders = sorted.join(';');
  const canonicalQuery = Object.keys(query || {})
    .map((k) => [enc(k), enc(String(query[k]))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('&');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + REGION + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), REGION), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const auth = 'AWS4-HMAC-SHA256 Credential=' + id + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const out = Object.assign({}, headers, { Authorization: auth });
  delete out.host;
  return out;
}

async function s3(method, bucket, key, opts = {}) {
  const qs = opts.query
    ? '?' + Object.keys(opts.query).map((k) => enc(k) + '=' + enc(String(opts.query[k]))).join('&')
    : '';
  const p = '/' + (bucket || '') + (key ? '/' + key : '');
  const headers = sign(method, p, opts.query || {}, opts.body || '', opts.headers || {});
  const r = await fetch('https://' + HOST + p + qs, {
    method,
    headers,
    body: opts.body || undefined,
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  if (cmd === 'whoami') {
    const r = await s3('GET', '', '');
    const buckets = [...r.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
    console.log('status', r.status, 'buckets:', buckets.join(', ') || '(нет)');
  } else if (cmd === 'mkdir') {
    const r = await s3('PUT', a, '', { headers: { 'x-amz-acl': 'public-read' } });
    console.log('create bucket', r.status, r.ok ? 'ok' : r.text.slice(0, 300));
  } else if (cmd === 'acl') {
    const r = await s3('PUT', a, '', { query: { acl: '' }, headers: { 'x-amz-acl': b || 'public-read' } });
    console.log('acl', r.status, r.ok ? 'ok' : r.text.slice(0, 300));
  } else if (cmd === 'cors') {
    const xml = '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>';
    const r = await s3('PUT', a, '', { query: { cors: '' }, body: xml, headers: { 'content-type': 'application/xml' } });
    console.log('cors', r.status, r.ok ? 'ok' : r.text.slice(0, 300));
  } else if (cmd === 'ls') {
    const r = await s3('GET', a, '', { query: { 'list-type': '2', prefix: b || '' } });
    const keys = [...r.text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    console.log('status', r.status, 'objects', keys.length);
    for (const k of keys.slice(0, 20)) console.log(' ', k);
  } else if (cmd === 'put') {
    const file = fs.readFileSync(c);
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (d) headers['cache-control'] = 'public, max-age=' + d;
    const r = await s3('PUT', a, b, { body: file, headers });
    console.log('put', b, r.status, r.ok ? 'ok' : r.text.slice(0, 300));
  } else if (cmd === 'get') {
    const r = await s3('GET', a, b);
    console.log('status', r.status);
    console.log(r.text.slice(0, 500));
  } else if (cmd === 'rm') {
    const r = await s3('DELETE', a, b);
    console.log('rm', b, r.status);
  } else {
    console.log('команды: whoami | mkdir | acl | cors | ls | put | get | rm');
  }
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
