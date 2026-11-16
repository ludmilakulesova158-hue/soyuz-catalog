import crypto from 'node:crypto';
import zlib from 'node:zlib';

const BUCKET = process.env.BUCKET || 'soyuz-catalog-data';
const FEED_URL = process.env.FEED_URL || 'https://joywork.ru/feeds/14794.xml';
const HOST = 'storage.yandexcloud.net';
const REGION = 'ru-central1';
const AKEY = process.env.AWS_ACCESS_KEY_ID || '';
const ASECRET = process.env.AWS_SECRET_ACCESS_KEY || '';
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'ludmilakulesova158-hue/soyuz-catalog';
const GH_BRANCH = process.env.GH_BRANCH || 'main';

// ---------------- GitHub (резервная копия данных) ----------------
async function ghApi(method, path, body) {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'soyuz-catalog-bot',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`GitHub ${method} ${path} -> ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function syncGitHub(objects, cards, meta) {
  if (!GH_TOKEN) {
    console.log('GH_TOKEN не задан — синхронизация с GitHub пропущена');
    return { skipped: true };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ref = await ghApi('GET', `/repos/${GH_REPO}/git/ref/heads/${GH_BRANCH}`);
      const parentSha = ref.object.sha;
      const parent = await ghApi('GET', `/repos/${GH_REPO}/git/commits/${parentSha}`);
      const baseTree = parent.tree.sha;

      const treeNow = await ghApi('GET', `/repos/${GH_REPO}/git/trees/${baseTree}?recursive=1`);
      const existing = new Set(
        (treeNow.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith('data/objects/')).map((t) => t.path)
      );

      const alive = new Set();
      const entries = [];
      for (const o of objects) {
        const p = 'data/objects/' + o.id + '.json';
        alive.add(p);
        entries.push({ path: p, mode: '100644', type: 'blob', content: JSON.stringify(o) });
      }
      entries.push({ path: 'data/cards.json', mode: '100644', type: 'blob', content: JSON.stringify(cards) });
      entries.push({ path: 'data/meta.json', mode: '100644', type: 'blob', content: JSON.stringify(meta, null, 2) });
      for (const p of existing) {
        if (!alive.has(p)) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      }

      const newTree = await ghApi('POST', `/repos/${GH_REPO}/git/trees`, { base_tree: baseTree, tree: entries });
      if (newTree.sha === baseTree) {
        console.log('github sync: tree unchanged, commit skipped');
        return { skipped: true, reason: 'tree unchanged' };
      }
      const newCommit = await ghApi('POST', `/repos/${GH_REPO}/git/commits`, {
        message: `catalog update ${meta.generated}`,
        tree: newTree.sha,
        parents: [parentSha],
      });
      await ghApi('PATCH', `/repos/${GH_REPO}/git/refs/heads/${GH_BRANCH}`, { sha: newCommit.sha, force: false });

      console.log('github sync ok:', newCommit.sha, entries.length, 'entries');
      return { commit: newCommit.sha, entries: entries.length, deleted: existing.size - alive.size };
    } catch (e) {
      console.log('github sync attempt ' + attempt + ' failed:', e.message);
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------------- SigV4 ----------------
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function sign(method, path, query, body, extraHeaders) {
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
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + ASECRET, dateStamp), REGION), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const auth = 'AWS4-HMAC-SHA256 Credential=' + AKEY + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const out = Object.assign({}, headers, { Authorization: auth });
  delete out.host;
  return out;
}

async function s3(method, key, opts = {}) {
  const qs = opts.query
    ? '?' + Object.keys(opts.query).map((k) => enc(k) + '=' + enc(String(opts.query[k]))).join('&')
    : '';
  const headers = sign(method, '/' + BUCKET + (key ? '/' + key : ''), opts.query || {}, opts.body || '', opts.headers || {});
  const r = await fetch('https://' + HOST + '/' + BUCKET + (key ? '/' + key : '') + qs, {
    method,
    headers,
    body: opts.body || undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

const put = (key, data, cache) =>
  s3('PUT', key, {
    body: data,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=' + cache },
  });

// то же, но тело сжато gzip: браузер распаковывает прозрачно по Content-Encoding
const putGzip = (key, data, cache) =>
  s3('PUT', key, {
    body: zlib.gzipSync(Buffer.from(data), { level: 9 }),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'cache-control': 'public, max-age=' + cache,
    },
  });

// ---------------- служебные чтения ----------------
const getJSON = async (key) => {
  const r = await s3('GET', key, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch (e) { return null; }
};
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---------------- фид ----------------
const txt = (block, tag) => {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].replace(/\r/g, '').trim() : '';
};
const num = (s) => {
  if (!s) return null;
  const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const int = (s) => { const v = num(s); return v === null ? null : Math.round(v); };
const nested = (block, tag) => {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
  if (!m) return { value: null, unit: '' };
  return { value: num(txt(m[1], 'value')), unit: txt(m[1], 'unit') };
};
const attrId = (attrs) => {
  const m = attrs.match(/internal-id\s*=\s*"([^"]+)"/);
  return m ? m[1].trim() : '';
};
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/&amp;nbsp;/g, ' ').replace(/&amp;shy;/g, '');

function feedSources(url) {
  const list = [url];
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/\./g, '-');
    list.push(`https://${host}.translate.goog${u.pathname}${u.search}?_x_tr_sl=auto&_x_tr_tl=ru&_x_tr_hl=ru`);
  } catch (e) { /* url уже в списке */ }
  return list;
}

async function fetchFeed(url, etag) {
  const sources = feedSources(url);
  let lastErr;
  for (const src of sources) {
    for (let i = 0; i < 2; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      try {
        const headers = { 'user-agent': 'soyuz-catalog-bot/1.0' };
        if (etag && src === sources[0]) headers['if-none-match'] = etag;
        const res = await fetch(src, { headers, signal: AbortSignal.timeout(45000) });
        if (res.status === 304) {
          console.log('feed not modified (304), nothing to do');
          return { notModified: true, etag };
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (!(text.length > 1000 && text.includes('<offer'))) throw new Error('not a feed (' + text.length + ')');
        console.log('feed via', src);
        return { text, etag: res.headers.get('etag') || '' };
      } catch (e) {
        lastErr = e;
        console.log('feed attempt failed:', src.slice(0, 60), e.message);
      }
    }
  }
  throw lastErr || new Error('feed fetch failed');
}

// ---------------- парсинг ----------------
const CAT_LABEL = {
  'квартира': 'квартира',
  'дом с участком': 'дом',
  'коттедж': 'коттедж',
  'таунхаус': 'таунхаус',
  'часть дома': 'часть дома',
  'участок': 'участок',
  'дача': 'дача',
  'комната': 'комната',
  'гараж': 'гараж',
  'коммерческая': 'коммерческая',
};
const LOT_CATS = new Set(['участок']);

function parseOffer(attrs, body) {
  const id = attrId(attrs);
  if (!id) return null;

  const locBlock = (body.match(/<location>([\s\S]*?)<\/location>/) || ['', ''])[1];
  const priceBlock = (body.match(/<price>([\s\S]*?)<\/price>/) || ['', ''])[1];
  const agentBlock = (body.match(/<sales-agent>([\s\S]*?)<\/sales-agent>/) || ['', ''])[1];

  const type = txt(body, 'type');
  const cat = txt(body, 'category');
  const apartments = /^true$|^1$|^да$/i.test(txt(body, 'apartments'));
  const studio = /^true$|^1$|^да$/i.test(txt(body, 'studio'));

  const priceVal = num(txt(priceBlock, 'value'));
  const pricePeriod = txt(priceBlock, 'period') || txt(body, 'period');

  const area = nested(body, 'area');
  const living = nested(body, 'living-space');
  const kitchen = nested(body, 'kitchen-space');
  const lot = nested(body, 'lot-area');

  const city = txt(locBlock, 'locality-name');
  const street = txt(locBlock, 'address');
  const district = txt(locBlock, 'district');
  const addr = [city, street].filter(Boolean).join(', ');

  const rooms = int(txt(body, 'rooms')) ?? int(txt(body, 'rooms-offered'));
  const floor = int(txt(body, 'floor'));
  const floors = int(txt(body, 'floors-total'));

  const imgs = [...body.matchAll(/<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/g)].map((m) => m[1].trim());
  const seen = new Set();
  const photos = [];
  const plans = [];
  for (const u of imgs) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    (/_pl\.(jpe?g|png|webp|avif)$/i.test(u) ? plans : photos).push(u);
  }
  const ph = [...photos, ...plans];

  const video = txt(body, 'youtube-video-review-url') || (txt(body, 'video-review').startsWith('http') ? txt(body, 'video-review') : '');

  let descrRaw = txt(body, 'description').replace(/^\s*Арт\.\s*[\w-]+\s*[.:]?\s*/i, '');
  const descr = descrRaw.split(/\n\s*\n+/).map((p) => p.replace(/\n+/g, ' ').trim()).filter(Boolean);

  const phoneRaw = txt(agentBlock, 'phone').replace(/[^\d+]/g, '');
  const phone = phoneRaw.startsWith('8') && phoneRaw.length === 11 ? '+7' + phoneRaw.slice(1) : phoneRaw;

  const fmt = (v) => String(v).replace('.', ',');
  const areaLabel = LOT_CATS.has(cat)
    ? (lot.value !== null ? (lot.unit === 'сотка' ? `${fmt(lot.value)} сот.` : `${fmt(lot.value)} ${lot.unit || ''}`.trim()) : (area.value !== null ? `${fmt(area.value)} м²` : ''))
    : (area.value !== null ? `${fmt(area.value)} м²` : '');

  const catLabel = apartments ? 'апартаменты' : (studio && !rooms ? 'студия' : (CAT_LABEL[cat] || cat || 'объект'));
  const roomsLabel = rooms && cat !== 'комната' ? `${rooms}-комн.` : '';
  const title = `${roomsLabel ? roomsLabel + ' ' : ''}${catLabel}${areaLabel ? ', ' + areaLabel : ''}`;

  return {
    id,
    type: type === 'аренда' ? 'аренда' : 'продажа',
    cat: catLabel,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    price: priceVal,
    currency: txt(priceBlock, 'currency') || 'RUB',
    addr: esc(addr),
    city: esc(city),
    district: esc(district),
    region: esc(txt(locBlock, 'region')),
    lat: num(txt(locBlock, 'latitude')),
    lng: num(txt(locBlock, 'longitude')),
    rooms: studio && !rooms ? 0 : rooms,
    studio,
    area: area.value,
    area_living: living.value,
    area_kitchen: kitchen.value,
    area_lot: lot.value,
    area_lot_unit: lot.unit,
    floor,
    floors,
    renov: esc(txt(body, 'renovation')),
    house: { type: esc(txt(body, 'building-type')), year: int(txt(body, 'built-year')) },
    toilet: esc(txt(body, 'toilet')),
    bathroom: esc(txt(body, 'bathroom-unit')),
    balcony: esc(txt(body, 'balcony')),
    lift: esc(txt(body, 'lift')),
    utilities: {
      gas: esc(txt(body, 'gas-supply')),
      elec: esc(txt(body, 'electricity-supply')),
      water: esc(txt(body, 'water-supply')),
      sewer: esc(txt(body, 'sewerage-supply')),
    },
    mortgage: esc(txt(body, 'mortgage')),
    cadastral: esc(txt(body, 'cadastral-number')),
    deal_status: esc(txt(body, 'deal-status')),
    commercial_type: esc(txt(body, 'commercial-type')),
    rent: type === 'аренда'
      ? { period: esc(pricePeriod), pledge: esc(txt(body, 'rent-pledge')), commission: esc(txt(body, 'commission')), agent_fee: esc(txt(body, 'agent-fee')) }
      : null,
    photos: ph,
    video: esc(video),
    agent: {
      name: esc(txt(agentBlock, 'name')),
      org: esc(txt(agentBlock, 'organization')),
      url: txt(agentBlock, 'url'),
      email: txt(agentBlock, 'email'),
      phone,
      photo: txt(agentBlock, 'photo'),
    },
    descr,
    created: txt(body, 'creation-date'),
    updated: txt(body, 'last-update-date') || txt(body, 'creation-date'),
  };
}

// ---------------- main ----------------
export async function handler(event) {
  const started = Date.now();
  try {
    return await run(event, started);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log('ERROR', msg);
    try {
      await s3('PUT', 'status.json', {
        body: JSON.stringify({ checkedAt: new Date().toISOString(), result: 'error', error: msg }),
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (e2) { console.log('error heartbeat failed:', e2.message); }
    return { statusCode: 200, body: JSON.stringify({ result: 'error', error: msg, ms: Date.now() - started }) };
  }
}

async function run(event, started) {
  let ev = event;
  if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch (e) { ev = {}; } }
  ev = ev || {};
  let flags = ev;
  if (typeof ev.body === 'string') {
    try { flags = Object.assign({}, ev, JSON.parse(ev.body)); } catch (e) { /* body не JSON */ }
  }
  const force = !!(flags.force || (flags.queryStringParameters && flags.queryStringParameters.force));

  const prev = await s3('GET', 'meta.json', { headers: { 'cache-control': 'no-cache' } });
  let prevGen = null;
  let prevEtag = '';
  if (prev.ok) {
    try {
      const pm = JSON.parse(prev.text);
      prevGen = pm.generated || null;
      prevEtag = pm.feedEtag || '';
    } catch (e) { prevGen = null; prevEtag = ''; }
  }

  // суточная страховка: раз в 24 ч читаем фид, игнорируя ETag, но с обычным сравнением по хешам.
  // заодно защищает от случая, когда сервер фида отдаёт 304 при реальных изменениях.
  const manifestPrev = await getJSON('manifest.json');
  const lastRecheck = manifestPrev && manifestPrev.recheckAt ? Date.parse(manifestPrev.recheckAt) : 0;
  const recheck = !force && (!!(flags.recheck || (flags.queryStringParameters && flags.queryStringParameters.recheck)) ||
    !(Date.now() - lastRecheck < 24 * 3600 * 1000));
  if (recheck) console.log('recheck: daily full feed read (ignore ETag)');

  let feed = await fetchFeed(FEED_URL, force || recheck ? '' : prevEtag);
  const heartbeat = async (result, extra, gen) => {
    try {
      await s3('PUT', 'status.json', {
        body: JSON.stringify(Object.assign({ checkedAt: new Date().toISOString(), result, generated: gen || prevGen }, extra || {})),
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (e) {
      console.log('heartbeat failed:', e.message);
    }
  };

  // фид не изменился, но осталось неподтверждённое резкое сокращение базы —
  // перечитываем фид полностью и проверяем ещё раз (редкий путь)
  let refetchForPending = false;
  if (feed.notModified) {
    const pendingNow = await getJSON('pending.json');
    if (pendingNow && pendingNow.gen === prevGen) {
      console.log('pending drop check on stable feed — refetching full feed');
      feed = await fetchFeed(FEED_URL, '');
      refetchForPending = true;
    }
  }

  if (feed.notModified) {
    await heartbeat('nochange');
    return { statusCode: 200, body: JSON.stringify({ result: 'nochange', reason: '304', ms: Date.now() - started }) };
  }

  const xml = feed.text || '';
  const genMatch = xml.match(/<generation-date>([^<]+)<\/generation-date>/);
  const generated = genMatch ? new Date(genMatch[1]).toISOString() : new Date().toISOString();

  // пропускаем, только если не изменилась ни дата генерации, ни ETag:
  // правка объекта без смены generation-date не должна теряться
  const sameEtag = !prevEtag || feed.etag === prevEtag;
  if (!force && !recheck && prevGen === generated && sameEtag && !refetchForPending) {
    console.log('no changes, feed generated =', generated);
    await heartbeat('nochange');
    return { statusCode: 200, body: JSON.stringify({ result: 'nochange', generated, ms: Date.now() - started }) };
  }

  const offers = [...xml.matchAll(/<offer\b([^>]*)>([\s\S]*?)<\/offer>/g)];
  if (!offers.length) throw new Error('feed has 0 offers — abort');
  const objects = offers.map((m) => parseOffer(m[1], m[2])).filter(Boolean);
  if (!objects.length) throw new Error('parsed 0 objects — abort');

  // резкое сокращение базы: принимаем автоматически, если оно подтвердилось вторым прогоном
  let hold = null;
  const pendingPrev = await getJSON('pending.json');
  if (!force && prevGen && prev.ok) {
    let prevMeta = null;
    try { prevMeta = JSON.parse(prev.text); } catch (e) { prevMeta = null; }
    if (prevMeta && prevMeta.count && objects.length < prevMeta.count * 0.5) {
      const same = pendingPrev && pendingPrev.gen === generated && pendingPrev.count === objects.length;
      const strikes = same ? (pendingPrev.strikes || 0) + 1 : 1;
      if (strikes < 2) {
        await put('pending.json', JSON.stringify({
          gen: generated, count: objects.length, prevCount: prevMeta.count,
          strikes, since: new Date().toISOString(),
        }), 60);
        const outHold = { result: 'hold', reason: 'mass removal not confirmed yet', generated, count: objects.length, prevCount: prevMeta.count, strikes, ms: Date.now() - started };
        await heartbeat('hold', { count: objects.length, prevCount: prevMeta.count, strikes }, generated);
        console.log(JSON.stringify(outHold));
        return { statusCode: 200, body: JSON.stringify(outHold) };
      }
      hold = { from: prevMeta.count, to: objects.length, strikes };
      console.log('mass removal confirmed twice — accepting', JSON.stringify(hold));
    }
  }

  const cards = objects
    .map((o) => ({
      id: o.id, type: o.type, cat: o.cat, title: o.title, price: o.price,
      addr: o.addr, district: o.district, city: o.city, lat: o.lat, lng: o.lng,
      rooms: o.rooms, studio: o.studio, area: o.area, ak: o.area_kitchen, floor: o.floor, floors: o.floors,
      renov: o.renov, ph: o.photos[0] || '', upd: o.updated,
    }))
    .sort((a, b) => (a.type === b.type ? (b.upd || '').localeCompare(a.upd || '') : (a.type === 'продажа' ? -1 : 1)));

  const cats = {};
  for (const o of objects) cats[o.cat] = (cats[o.cat] || 0) + 1;
  const meta = {
    generated,
    source: FEED_URL,
    feedEtag: feed.etag || '',
    count: objects.length,
    sale: objects.filter((o) => o.type === 'продажа').length,
    rent: objects.filter((o) => o.type === 'аренда').length,
    cats,
  };

  // запись: только изменившиеся объекты -> cards -> meta -> manifest (manifest последним)
  const canDiff = !!(manifestPrev && manifestPrev.v === 1 && manifestPrev.objects && !force);
  const prevHashes = canDiff ? manifestPrev.objects : {};

  const nextHashes = {};
  const changed = [];
  for (const o of objects) {
    const body = JSON.stringify(o);
    const h = sha1(body);
    nextHashes[o.id] = h;
    if (prevHashes[o.id] !== h) changed.push({ key: 'objects/' + o.id + '.json', body });
  }

  let failed = 0;
  let written = 0;
  const queue = changed.slice();
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      const r = await put(item.key, item.body, 21600);
      if (r.ok) written++; else { failed++; console.log('put failed', item.key, r.status, r.text.slice(0, 120)); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed) throw new Error('object upload failed: ' + failed);

  // удалить файлы объектов, выпавших из фида
  let removed = 0;
  if (canDiff) {
    for (const id of Object.keys(prevHashes)) {
      if (!(id in nextHashes)) {
        const d = await s3('DELETE', 'objects/' + id + '.json');
        if (d.ok) removed++;
      }
    }
  }

  // полная сверка с хранилищем: при первом запуске, принудительно и раз в сутки
  let reconciled = 0;
  const recAt = manifestPrev && manifestPrev.reconciledAt ? Date.parse(manifestPrev.reconciledAt) : 0;
  const needReconcile = !canDiff || !(Date.now() - recAt < 24 * 3600 * 1000);
  let reconciledAt = manifestPrev && manifestPrev.reconciledAt ? manifestPrev.reconciledAt : null;
  if (needReconcile) {
    const list = await s3('GET', '', { query: { 'list-type': '2', prefix: 'objects/' }, headers: { 'cache-control': 'no-cache' } });
    if (list.ok) {
      const alive = new Set(Object.keys(nextHashes).map((id) => 'objects/' + id + '.json'));
      const keys = [...list.text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      for (const k of keys) {
        if (!alive.has(k)) { const d = await s3('DELETE', k); if (d.ok) reconciled++; }
      }
      reconciledAt = new Date().toISOString();
    }
  }

  const cardsBody = JSON.stringify(cards);
  const rc = await putGzip('cards.json', cardsBody, 60);
  if (!rc.ok) throw new Error('cards.json upload failed: ' + rc.status + ' ' + rc.text.slice(0, 200));
  const metaBody = JSON.stringify(meta, null, 2);
  const rm = await put('meta.json', metaBody, 60);
  if (!rm.ok) throw new Error('meta.json upload failed: ' + rm.status + ' ' + rm.text.slice(0, 200));

  const manifest = {
    v: 1,
    gen: generated,
    count: objects.length,
    objects: nextHashes,
    cards: sha1(cardsBody),
    meta: sha1(metaBody),
    reconciledAt,
    recheckAt: recheck ? new Date().toISOString() : ((manifestPrev && manifestPrev.recheckAt) || null),
    at: new Date().toISOString(),
  };
  const rmn = await put('manifest.json', JSON.stringify(manifest), 60);
  if (!rmn.ok) throw new Error('manifest.json upload failed: ' + rmn.status + ' ' + rmn.text.slice(0, 200));

  // снять отложенное решение: сокращение либо подтверждено, либо не подтвердилось
  if (pendingPrev) {
    const dp = await s3('DELETE', 'pending.json');
    if (!dp.ok && dp.status !== 404) console.log('pending cleanup:', dp.status);
  }

  // резервная копия в GitHub: один коммит на обновление, встроенный контент через Trees API
  let gh = null;
  try {
    gh = await syncGitHub(objects, cards, meta);
  } catch (e) {
    console.log('github sync error:', e.message);
    gh = { error: e.message };
  }

  const out = { result: 'updated', generated, count: objects.length, sale: meta.sale, rent: meta.rent, written, removed, reconciled, failed, hold, gh, ms: Date.now() - started };
  await heartbeat('updated', { count: objects.length, written, removed, reconciled, failed }, generated);
  console.log(JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
}
