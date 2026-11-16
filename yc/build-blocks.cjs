const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'scripts', 'catalog-block.v2.html');
const OUT_MAIN = path.join(__dirname, 'catalog-block.main-yc.html');
const OUT_V3 = path.join(__dirname, 'catalog-block.v3-gh.html');

const SEC_OLD = '<section id="vb-cat-root" class="vb-ctl vb-cat" data-section-name="\u041a\u0430\u0442\u0430\u043b\u043e\u0433 \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432">';
const GH_OLD = "    var GH='https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/';";
const CD_OLD = "    var CD='https://cdn.jsdelivr.net/gh/ludmilakulesova158-hue/soyuz-catalog@main/data/';";

const GH_RAW = "'https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/'";

function need(h, s, name) {
  if (!h.includes(s)) throw new Error('not found: ' + name);
}

function common(h) {
  const ttlOld = '    var TTL=3*60*1000;';
  need(h, ttlOld, 'TTL');
  h = h.replace(ttlOld, '    var TTL=10*60*1000;');

  const revalOld = '    var REVAL_MS=3*60*1000;';
  need(h, revalOld, 'REVAL_MS');
  h = h.replace(revalOld, '    var REVAL_MS=10*60*1000;\r\n    var LAST_REVAL=0;');

  const tsOld = "      var ts=Date.now();\r\n      fetchJSON(GH+'meta.json?ts='+ts)";
  need(h, tsOld, 'ts');
  h = h.replace(tsOld, "      var ts=Date.now();LAST_REVAL=ts;\r\n      fetchJSON(GH+'meta.json?ts='+ts)");

  const focusOld =
    "      document.addEventListener('visibilitychange',function(){if(!document.hidden)revalidate(false);});\r\n" +
    "      window.addEventListener('focus',function(){revalidate(false);});";
  need(h, focusOld, 'focus handlers');
  h = h.replace(
    focusOld,
    "      document.addEventListener('visibilitychange',function(){if(!document.hidden&&Date.now()-LAST_REVAL>60000)revalidate(false);});\r\n" +
      "      window.addEventListener('focus',function(){if(Date.now()-LAST_REVAL>60000)revalidate(false);});"
  );
  return h;
}

// Главная: данные из Yandex, запасной источник — GitHub, заголовок h2
let main = common(fs.readFileSync(SRC, 'utf8'));
need(main, SEC_OLD, 'section');
main = main.replace(
  SEC_OLD,
  '<section id="vb-cat-root" class="vb-ctl vb-cat" data-section-name="\u041a\u0430\u0442\u0430\u043b\u043e\u0433 \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432" data-data-base="https://storage.yandexcloud.net/soyuz-catalog-data-kaluga/">'
);
need(main, GH_OLD, 'GH');
need(main, CD_OLD, 'CD');
main = main
  .replace(
    GH_OLD,
    "    var YBASE=(document.getElementById('vb-cat-root')&&document.getElementById('vb-cat-root').getAttribute('data-data-base'))||'';\r\n" +
      '    var GH=YBASE||' + GH_RAW + ';\r\n' +
      '    var CDFALL=' + GH_RAW + ';'
  )
  .replace(CD_OLD, '    var CD=CDFALL;');
need(main, '<h1 class="vb-ctl__title">', 'h1');
main = main.replace('<h1 class="vb-ctl__title">', '<h2 class="vb-ctl__title">').replace(/<\/h1>/, '</h2>');

// /catalog-v3: данные из GitHub (как было на главной), заголовок h1
let v3 = common(fs.readFileSync(SRC, 'utf8'));

fs.writeFileSync(OUT_MAIN, main, 'utf8');
fs.writeFileSync(OUT_V3, v3, 'utf8');

const stats = (s) => ({
  len: s.length,
  ybase: s.includes('YBASE'),
  cdfall: s.includes('CDFALL'),
  ttl10: s.includes('TTL=10*60*1000'),
  throttled: s.includes('LAST_REVAL>60000'),
  h2: s.includes('<h2 class="vb-ctl__title">'),
  dataBase: s.includes('data-data-base'),
});
console.log('main:', JSON.stringify(stats(main)));
console.log('v3  :', JSON.stringify(stats(v3)));
