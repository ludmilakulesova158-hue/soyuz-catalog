const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join('D:', '\u043a\u0430\u043b\u0443\u0433\u0430_\u0436\u043a', 'soyuz-catalog', 'scripts', 'catalog-block.v2.html');
const OUT = path.join(__dirname, 'catalog-block.v3-yc.html');

let h = fs.readFileSync(SRC, 'utf8');

const secOld = '<section id="vb-cat-root" class="vb-ctl vb-cat" data-section-name="\u041a\u0430\u0442\u0430\u043b\u043e\u0433 \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432">';
const secNew = '<section id="vb-cat-root" class="vb-ctl vb-cat" data-section-name="\u041a\u0430\u0442\u0430\u043b\u043e\u0433 \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432" data-data-base="https://storage.yandexcloud.net/soyuz-catalog-data/">';
if (!h.includes(secOld)) throw new Error('section not found');
h = h.replace(secOld, secNew);

const ghOld = "    var GH='https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/';";
const cdOld = "    var CD='https://cdn.jsdelivr.net/gh/ludmilakulesova158-hue/soyuz-catalog@main/data/';";
if (!h.includes(ghOld) || !h.includes(cdOld)) throw new Error('GH/CD vars not found');

const ghNew =
  "    var YBASE=(document.getElementById('vb-cat-root')&&document.getElementById('vb-cat-root').getAttribute('data-data-base'))||'';\n" +
  "    var GH=YBASE||'https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/';\n" +
  "    var CDFALL='https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/';";
// CD остаётся GitHub-базой всегда: если Yandex недоступен или отключён — страница берёт данные из GitHub
const cdNew = "    var CD=CDFALL;";

h = h.replace(ghOld, ghNew).replace(cdOld, cdNew);

// реже опрашиваем бакет: кэш и фон 10 минут, плюс троттлинг на возврат к вкладке
const ttlOld = '    var TTL=3*60*1000;';
const ttlNew = '    var TTL=10*60*1000;';
if (!h.includes(ttlOld)) throw new Error('TTL not found');
h = h.replace(ttlOld, ttlNew);

const revalOld = '    var REVAL_MS=3*60*1000;';
const revalNew = '    var REVAL_MS=10*60*1000;\n    var LAST_REVAL=0;';
if (!h.includes(revalOld)) throw new Error('REVAL_MS not found');
h = h.replace(revalOld, revalNew);

const tsOld = "      var ts=Date.now();\r\n      fetchJSON(GH+'meta.json?ts='+ts)";
const tsNew = "      var ts=Date.now();LAST_REVAL=ts;\r\n      fetchJSON(GH+'meta.json?ts='+ts)";
if (!h.includes(tsOld)) throw new Error('ts block not found');
h = h.replace(tsOld, tsNew);

const focusOld =
  "      document.addEventListener('visibilitychange',function(){if(!document.hidden)revalidate(false);});\r\n" +
  "      window.addEventListener('focus',function(){revalidate(false);});";
const focusNew =
  "      document.addEventListener('visibilitychange',function(){if(!document.hidden&&Date.now()-LAST_REVAL>60000)revalidate(false);});\r\n" +
  "      window.addEventListener('focus',function(){if(Date.now()-LAST_REVAL>60000)revalidate(false);});";
if (!h.includes(focusOld)) throw new Error('focus handlers not found');
h = h.replace(focusOld, focusNew);

fs.writeFileSync(OUT, h, 'utf8');
console.log('written', h.length, 'bytes; YBASE:', h.includes('YBASE'), '; TTL10:', h.includes('TTL=10*60*1000'), '; throttled:', h.includes('LAST_REVAL>60000'));
