#!/usr/bin/env node
// Вызов MCP-инструментов Tilda из скрипта (чтобы не гонять большие HTML через чат).
//   node yc/tools/tilda.cjs list
//   node yc/tools/tilda.cjs call <tool> <args.json>
// Токен: env TILDA_MCP_TOKEN или файл yc/tools/.tilda-token (в git не попадает).

const fs = require('node:fs');
const path = require('node:path');

const URL_MCP = 'https://tilda.ru/api/mcp/';
const TOKEN = process.env.TILDA_MCP_TOKEN ||
  (fs.existsSync(path.join(__dirname, '.tilda-token')) ? fs.readFileSync(path.join(__dirname, '.tilda-token'), 'utf8').trim() : '');
const PROTO = '2025-06-18';

async function rpc(payload) {
  const r = await fetch(URL_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + TOKEN,
      'mcp-protocol-version': PROTO,
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return { status: r.status, text };
}

function parse(text) {
  // streamable HTTP может вернуть SSE: строки "data: {...}"
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1].slice(5).trim()); } catch (e) { return null; }
}

async function init() {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'soyuz-tools', version: '1.0' } } });
  return r;
}

async function main() {
  const [cmd, tool, argsFile] = process.argv.slice(2);
  if (!TOKEN) throw new Error('нет токена: env TILDA_MCP_TOKEN или yc/tools/.tilda-token');
  if (cmd === 'probe') {
    const r = await init();
    console.log('init', r.status, r.text.slice(0, 400));
    return;
  }
  if (cmd === 'list') {
    await init();
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    console.log('status', r.status);
    console.log(r.text.slice(0, 3000));
    return;
  }
  if (cmd === 'call') {
    const args = argsFile ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : {};
    await init();
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } });
    const j = parse(r.text);
    console.log('status', r.status);
    console.log('raw len', r.text.length);
    console.log(j ? JSON.stringify(j).slice(0, 1200) : r.text.slice(0, 1200));
    return;
  }
  console.log('команды: probe | list | call <tool> <args.json>');
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
