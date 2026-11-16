#!/usr/bin/env node
// Инструменты Yandex Cloud для робота каталога (без yc CLI).
// Сеть через node:https: глобальный fetch на этой машине нестабилен к *.yandex.net.
//
//   node yc/tools/yc.cjs whoami
//   node yc/tools/yc.cjs versions
//   node yc/tools/yc.cjs trigger
//   node yc/tools/yc.cjs deploy            (нужен yc/fn.zip)
//   node yc/tools/yc.cjs invoke '{"recheck":true}'
//
// Ключ: C:\Users\admin\Downloads\authorized_key.json (или env YC_KEY).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const KEY_FILE = process.env.YC_KEY || 'C:\\Users\\admin\\Downloads\\authorized_key.json';
const FUNCTION_ID = process.env.YC_FN || 'd4e6r7jqo4lc4pd989r9';
const TRIGGER_ID = process.env.YC_TRIGGER || 'a1sjnv9k7u94tdqs38er';
const FOLDER_ID = process.env.YC_FOLDER || '';
const SA_ID = process.env.YC_SA || '';
const FN_API = 'https://serverless-functions.api.cloud.yandex.net';
const TRIG_API = 'https://serverless-triggers.api.cloud.yandex.net';
const IAM_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers, data ? { 'content-length': Buffer.byteLength(data) } : {}),
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function requestRetry(method, url, body, headers, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await request(method, url, body, headers);
    } catch (e) {
      lastErr = e;
      console.log('network attempt ' + i + '/' + attempts + ' failed:', e.code || e.message);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

async function iamToken() {
  const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'PS256', kid: key.key_id || key.id, typ: 'JWT' };
  const payload = { aud: IAM_URL, iss: key.service_account_id, iat: now, exp: now + 3600 };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: key.private_key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const jwt = signingInput + '.' + b64url(signature);
  const r = await requestRetry('POST', IAM_URL, { jwt });
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { j = null; }
  if (r.status !== 200 || !j || !j.iamToken) {
    throw new Error('IAM token failed: ' + r.status + ' ' + r.text.slice(0, 400));
  }
  return j.iamToken;
}

async function api(method, url, body) {
  const token = await iamToken();
  const r = await requestRetry(method, url, body, { Authorization: 'Bearer ' + token });
  let json = null;
  try { json = r.text ? JSON.parse(r.text) : null; } catch (e) { json = { raw: r.text.slice(0, 500) }; }
  if (r.status < 200 || r.status >= 300) throw new Error(method + ' ' + url + ' -> ' + r.status + ' ' + JSON.stringify(json).slice(0, 700));
  return json;
}

async function activeVersion() {
  const j = await api('GET', FN_API + '/functions/v1/versions?functionId=' + FUNCTION_ID + '&pageSize=50');
  const list = j.versions || [];
  return list.find((v) => v.status === 'ACTIVE') || list[0] || null;
}

async function cmdVersions() {
  const j = await api('GET', FN_API + '/functions/v1/versions?functionId=' + FUNCTION_ID + '&pageSize=50');
  for (const v of j.versions || []) {
    console.log(v.id, v.status, v.runtime, v.createdAt, 'mem=' + (v.resources && v.resources.memory), 'timeout=' + v.executionTimeout);
  }
}

async function cmdTrigger() {
  const t = await api('GET', TRIG_API + '/triggers/v1/triggers/' + TRIGGER_ID);
  console.log(JSON.stringify(t, null, 2));
}

async function cmdDeploy() {
  const zipPath = path.join(__dirname, '..', 'fn.zip');
  if (!fs.existsSync(zipPath)) throw new Error('нет файла ' + zipPath + ' — соберите архив');
  const envFile = flag('env-file');
  const override = envFile ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : {};
  const cur = await activeVersion();
  if (!cur && !SA_ID) throw new Error('нет активной версии и не задан YC_SA — нечего взять за основу');
  const content = fs.readFileSync(zipPath).toString('base64');
  const body = {
    functionId: FUNCTION_ID,
    runtime: cur ? cur.runtime : 'nodejs22',
    entrypoint: cur ? cur.entrypoint : 'index.handler',
    resources: cur ? cur.resources : { memory: '268435456' },
    executionTimeout: cur ? cur.executionTimeout : '120s',
    serviceAccountId: cur ? cur.serviceAccountId : SA_ID,
    environment: Object.assign({}, cur ? cur.environment : {}, override),
    content,
  };
  if (cur && cur.connectivity) body.connectivity = cur.connectivity;
  if (cur && cur.secrets && cur.secrets.length) body.secrets = cur.secrets;
  if (cur && cur.logOptions) body.logOptions = cur.logOptions;
  console.log('deploy: base', cur ? 'version ' + cur.id : 'new function', 'zip', fs.statSync(zipPath).size, 'bytes', 'env keys', Object.keys(body.environment).length);
  const t0 = Date.now();
  const op = await api('POST', FN_API + '/functions/v1/versions', body);
  console.log('operation', op.id);
  // операции этой службы по прямому пути недоступны — ждём появления новой ACTIVE-версии
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const j = await api('GET', FN_API + '/functions/v1/versions?functionId=' + FUNCTION_ID + '&pageSize=50');
    const fresh = (j.versions || []).filter((v) => (!cur || v.id !== cur.id) && Date.parse(v.createdAt) >= t0 - 15000);
    const active = fresh.find((v) => v.status === 'ACTIVE');
    if (active) {
      console.log('deployed:', active.id, active.runtime, active.createdAt);
      return;
    }
    const bad = fresh.find((v) => v.status === 'ERROR');
    if (bad) throw new Error('version failed: ' + bad.id);
  }
  throw new Error('deploy timeout');
}

async function cmdFnCreate(name) {
  if (!FOLDER_ID) throw new Error('нужен YC_FOLDER');
  const j = await api('GET', FN_API + '/functions/v1/functions?folderId=' + FOLDER_ID);
  const found = (j.functions || []).find((f) => f.name === name);
  if (found) {
    console.log('function exists:', found.id, found.name);
    return;
  }
  const f = await api('POST', FN_API + '/functions/v1/functions', {
    folderId: FOLDER_ID,
    name,
    description: 'Каталог АН Союз: joywork XML -> JSON в Object Storage',
  });
  console.log('function created:', f.id, f.name);
}

async function cmdTriggerCreate(name) {
  if (!FOLDER_ID || !SA_ID) throw new Error('нужны YC_FOLDER и YC_SA');
  const j = await api('GET', TRIG_API + '/triggers/v1/triggers?folderId=' + FOLDER_ID);
  const found = (j.triggers || []).find((t) => t.name === name);
  if (found) {
    console.log('trigger exists:', found.id, found.name);
    return;
  }
  const t = await api('POST', TRIG_API + '/triggers/v1/triggers', {
    folderId: FOLDER_ID,
    name,
    rule: {
      timer: {
        cronExpression: '*/15 * * * ? *',
        invokeFunctionWithRetry: { functionId: FUNCTION_ID, serviceAccountId: SA_ID },
      },
    },
  });
  console.log('trigger created:', t.id || JSON.stringify(t).slice(0, 300));
}

async function cmdDumpEnv(file) {
  const cur = await activeVersion();
  if (!cur) throw new Error('активная версия не найдена');
  fs.writeFileSync(file, JSON.stringify(cur.environment || {}, null, 2));
  console.log('env of version', cur.id, 'saved to', file, 'keys:', Object.keys(cur.environment || {}).length);
}

async function cmdInvoke(arg) {
  // поддерживаем и JSON, и простые флаги: invoke recheck | invoke force
  let payload = {};
  const a = (arg || '').trim();
  if (a.startsWith('{')) payload = JSON.parse(a);
  else if (a) for (const k of a.split(/\s+/)) payload[k] = true;
  console.log('payload:', JSON.stringify(payload));
  const token = await iamToken();
  const r = await requestRetry('POST', 'https://functions.yandexcloud.net/' + FUNCTION_ID, payload, { Authorization: 'Bearer ' + token });
  console.log('HTTP', r.status, r.text.slice(0, 4000));
}


async function cmdFolder(id) {
  const j = await api('GET', 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/' + id);
  console.log(JSON.stringify(j));
}

async function cmdClouds() {
  const j = await api('GET', 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1/clouds');
  for (const c of j.clouds || []) console.log('cloud', c.id, c.name);
}
async function cmdFolders(cloudId) {
  const j = await api('GET', 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders?cloudId=' + cloudId);
  for (const f of j.folders || []) console.log('folder', f.id, f.name, f.status);
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'whoami') {
    const t = await iamToken();
    console.log('IAM token ok, length', t.length);
  } else if (cmd === 'versions') await cmdVersions();
  else if (cmd === 'trigger') await cmdTrigger();
  else if (cmd === 'deploy') await cmdDeploy();
  else if (cmd === 'fn-create') await cmdFnCreate(rest[0] || 'soyuz-catalog');
  else if (cmd === 'trigger-create') await cmdTriggerCreate(rest[0] || 'soyuz-catalog-timer');
  else if (cmd === 'dump-env') await cmdDumpEnv(rest[0] || 'env.json');
  else if (cmd === 'folder') await cmdFolder(rest[0] || '');
  else if (cmd === 'clouds') await cmdClouds();
  else if (cmd === 'folders') await cmdFolders(rest[0] || '');
  else if (cmd === 'invoke') await cmdInvoke(rest.join(' '));
  else console.log('команды: whoami | versions | trigger | deploy [--env-file=..] | fn-create | trigger-create | dump-env <file> | invoke [json]');
}

main().catch((e) => {
  console.error('ERROR', e.message);
  if (e.cause) console.error('cause:', e.cause.code || e.cause.message || e.cause);
  process.exit(1);
});
