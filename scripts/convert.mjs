// Конвертер XML-фида JoyWork -> компактный JSON для сайта.
// Запуск: node scripts/convert.mjs            (берёт FEED_URL, по умолчанию joywork)
//         node scripts/convert.mjs --file путь.xml   (локальный файл)
// Выход: data/cards.json, data/meta.json, data/objects/<id>.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const FEED_URL = process.env.FEED_URL || 'https://joywork.ru/feeds/14794.xml';

// ---------- утилиты ----------
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
const esc = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/&amp;nbsp;/g, ' ').replace(/&amp;shy;/g, '');

// ---------- маппинг категорий ----------
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

// ---------- парсинг одного объекта ----------
function parseOffer(attrs, body) {
  const id = attrId(attrs);
  if (!id) return null;

  const locBlock = (body.match(/<location>([\s\S]*?)<\/location>/) || ['', ''])[1];
  const priceBlock = (body.match(/<price>([\s\S]*?)<\/price>/) || ['', ''])[1];
  const agentBlock = (body.match(/<sales-agent>([\s\S]*?)<\/sales-agent>/) || ['', ''])[1];

  const type = txt(body, 'type');                     // продажа | аренда
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
  const lat = num(txt(locBlock, 'latitude'));
  const lng = num(txt(locBlock, 'longitude'));

  const rooms = int(txt(body, 'rooms')) ?? int(txt(body, 'rooms-offered'));
  const floor = int(txt(body, 'floor'));
  const floors = int(txt(body, 'floors-total'));

  // фотографии: _pl (планировки) в конец, без дублей
  const imgs = [...body.matchAll(/<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/g)].map(m => m[1].trim());
  const seen = new Set();
  const photos = [], plans = [];
  for (const u of imgs) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    (/_pl\.(jpe?g|png|webp|avif)$/i.test(u) ? plans : photos).push(u);
  }
  const ph = [...photos, ...plans];
  const main = ph[0] || '';

  const video = txt(body, 'youtube-video-review-url') || (txt(body, 'video-review').startsWith('http') ? txt(body, 'video-review') : '');

  // описание: убрать строку "Арт. N." в начале, разбить на абзацы
  let descrRaw = txt(body, 'description').replace(/^\s*Арт\.\s*[\w-]+\s*[.:]?\s*/i, '');
  const descr = descrRaw.split(/\n\s*\n+/).map(p => p.replace(/\n+/g, ' ').trim()).filter(Boolean);

  const phoneRaw = txt(agentBlock, 'phone').replace(/[^\d+]/g, '');
  const phone = phoneRaw.startsWith('8') && phoneRaw.length === 11 ? '+7' + phoneRaw.slice(1) : phoneRaw;

  const fmt = (v) => String(v).replace('.', ',');
  const areaLabel = LOT_CATS.has(cat)
    ? (lot.value !== null ? (lot.unit === 'сотка' ? `${fmt(lot.value)} сот.` : `${fmt(lot.value)} ${lot.unit || ''}`.trim()) : (area.value !== null ? `${fmt(area.value)} м²` : ''))
    : (area.value !== null ? `${fmt(area.value)} м²` : '');

  const catLabel = apartments ? 'апартаменты' : (studio && !rooms ? 'студия' : (CAT_LABEL[cat] || cat || 'объект'));
  const roomsLabel = rooms && cat !== 'комната' ? `${rooms}-комн.` : '';
  const title = `${roomsLabel ? roomsLabel + ' ' : ''}${catLabel}${areaLabel ? ', ' + areaLabel : ''}`;
  const titleCap = title.charAt(0).toUpperCase() + title.slice(1);

  const obj = {
    id,
    type: type === 'аренда' ? 'аренда' : 'продажа',
    cat: catLabel,
    title: titleCap,
    price: priceVal,
    currency: txt(priceBlock, 'currency') || 'RUB',
    addr: esc(addr),
    city: esc(city),
    district: esc(district),
    region: esc(txt(locBlock, 'region')),
    lat, lng,
    rooms: studio && !rooms ? 0 : rooms,
    studio,
    area: area.value,
    area_living: living.value,
    area_kitchen: kitchen.value,
    area_lot: lot.value,
    area_lot_unit: lot.unit,
    floor, floors,
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

  return obj;
}

// ---------- сборка ----------
async function main() {
  let xml;
  const fileArg = process.argv.indexOf('--file');
  if (fileArg > -1 && process.argv[fileArg + 1]) {
    xml = fs.readFileSync(process.argv[fileArg + 1], 'utf8');
    console.log('source: local file', process.argv[fileArg + 1]);
  } else {
    const res = await fetch(FEED_URL, { headers: { 'user-agent': 'soyuz-catalog-bot/1.0' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    xml = await res.text();
    console.log('source:', FEED_URL, `(${(xml.length / 1048576).toFixed(2)} MB)`);
  }

  const offers = [...xml.matchAll(/<offer\b([^>]*)>([\s\S]*?)<\/offer>/g)];
  console.log('offers in feed:', offers.length);
  if (offers.length === 0) throw new Error('feed has 0 offers — abort');

  const objects = [];
  for (const m of offers) {
    const o = parseOffer(m[1], m[2]);
    if (o) objects.push(o);
  }
  console.log('parsed objects:', objects.length);
  if (objects.length === 0) throw new Error('parsed 0 objects — abort');

  // защита от битого фида: если объектов стало меньше половины — не обновляем
  const prevPath = path.join(DATA, 'meta.json');
  if (fs.existsSync(prevPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      if (prev.count && objects.length < prev.count * 0.5) {
        throw new Error(`object count dropped ${prev.count} -> ${objects.length}, keep previous data`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) throw e; // meta битый — продолжаем
      throw e;
    }
  }

  // карточки: сначала продажа, потом аренда; внутри — по дате обновления (свежие сверху)
  const cards = objects
    .map(o => ({
      id: o.id, type: o.type, cat: o.cat, title: o.title, price: o.price,
      addr: o.addr, district: o.district, city: o.city, lat: o.lat, lng: o.lng,
      rooms: o.rooms, studio: o.studio, area: o.area, floor: o.floor, floors: o.floors,
      renov: o.renov, ph: o.photos[0] || '', upd: o.updated,
    }))
    .sort((a, b) => (a.type === b.type ? (b.upd || '').localeCompare(a.upd || '') : (a.type === 'продажа' ? -1 : 1)));

  const cats = {};
  for (const o of objects) cats[o.cat] = (cats[o.cat] || 0) + 1;
  const meta = {
    generated: new Date().toISOString(),
    source: fileArg > -1 ? 'local' : FEED_URL,
    count: objects.length,
    sale: objects.filter(o => o.type === 'продажа').length,
    rent: objects.filter(o => o.type === 'аренда').length,
    cats,
  };

  // запись: сначала всё в памяти готово — только потом меняем файлы
  fs.mkdirSync(DATA, { recursive: true });
  const objDir = path.join(DATA, 'objects');
  if (fs.existsSync(objDir)) fs.rmSync(objDir, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });

  fs.writeFileSync(path.join(DATA, 'cards.json'), JSON.stringify(cards));
  fs.writeFileSync(path.join(DATA, 'meta.json'), JSON.stringify(meta, null, 2));
  for (const o of objects) {
    fs.writeFileSync(path.join(objDir, `${o.id}.json`), JSON.stringify(o));
  }

  const cardSize = (fs.statSync(path.join(DATA, 'cards.json')).size / 1024).toFixed(0);
  console.log(`done: ${objects.length} objects, cards.json ${cardSize} KB, sale=${meta.sale} rent=${meta.rent}`);
  console.log('cats:', JSON.stringify(meta.cats));
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
