// Готовит сайт к публикации для поисковиков: site/ → dist/.
//
// Что делает:
//  • копирует site/ в dist/ (туда же попадает собранный data.json);
//  • запускает site/js/app.js на сервере и сохраняет уже заполненную страницу:
//    расписание, площадки, тренер, акции и т. д. оказываются прямо в HTML,
//    и Яндекс с Google видят текст, не выполняя JavaScript. В браузере app.js
//    всё равно загружает data.json и перерисовывает блоки — как раньше;
//  • добавляет в <head> разметку schema.org (JSON-LD) о клубе: название, телефон,
//    площадки с адресами, соцсети — по ней поисковики понимают, что это за сайт;
//  • пишет dist/sitemap.xml с датой сборки.
//
// Запуск: npm run build && npm run dist  (на GitHub это делает workflow)

import { readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const DIST = join(ROOT, 'dist');

if (!existsSync(join(SITE, 'data.json'))) {
  console.error('Нет site/data.json — сначала выполните npm run build');
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
cpSync(SITE, DIST, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });

const data = JSON.parse(readFileSync(join(DIST, 'data.json'), 'utf8'));
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const appJs = readFileSync(join(DIST, 'js', 'app.js'), 'utf8');

// Адрес сайта берём из <link rel="canonical"> — он один на всю страницу
const canonical = /<link\s+rel="canonical"\s+href="([^"]+)"/i.exec(html);
const SITE_URL = (canonical ? canonical[1] : 'https://furiousrackets.ru/').replace(/\/?$/, '/');

/* ---------- 1. Заполняем страницу тем же app.js, что работает в браузере ---------- */

const dom = new JSDOM(html, { url: SITE_URL, runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;

// data.json отдаём из памяти вместо сети
window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
// Наблюдатель за первым экраном не нужен: иначе липкая кнопка «Записаться»
// попадёт в HTML уже показанной
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

window.eval(appJs);

// app.js рисует блоки после загрузки data.json (обещания + таймер лоадера) — ждём
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 50 && document.querySelector('[data-schedule]')?.children.length === 0; i += 1) {
  await wait(20);
}
await wait(500);

const rendered = ['trainings', 'schedule', 'signup', 'venues', 'coach', 'promos', 'tournaments', 'partners', 'faq']
  .filter((id) => document.getElementById(id) && !document.getElementById(id).hidden);

/* ---------- 2. Разметка schema.org о клубе ---------- */

function text(selector, attr = 'content') {
  const node = document.querySelector(selector);
  return node ? String(node.getAttribute(attr) || '').trim() : '';
}

function absolute(path) {
  try {
    return new URL(path, SITE_URL).href;
  } catch {
    return '';
  }
}

function postalAddress(address) {
  const street = String(address || '').replace(/^\s*(г\.|город)\s*Саратов\s*,\s*/i, '').trim();
  return {
    '@type': 'PostalAddress',
    ...(street ? { streetAddress: street } : {}),
    addressLocality: 'Саратов',
    addressRegion: 'Саратовская область',
    addressCountry: 'RU'
  };
}

const networks = [
  ...(data.final?.groups || []),
  ...(data.final?.links || []),
  ...(data.signup?.sheetNetworks || [])
].map((n) => n && n.link)
  // ссылки-приглашения в чаты (max.ru/join/…, t.me/joinchat/…) — не профиль клуба
  .filter((link) => /^https?:/i.test(link || '') && !/\/join(chat)?\//i.test(link));

const prices = (data.schedule || []).map((row) => Number(row.price)).filter((n) => n > 0);
const priceRange = prices.length
  ? (Math.min(...prices) === Math.max(...prices) ? `${Math.min(...prices)} ₽` : `${Math.min(...prices)}–${Math.max(...prices)} ₽`)
  : '';

const clubName = text('meta[property="og:site_name"]') || 'Бешеные ракетки';

const club = {
  '@context': 'https://schema.org',
  '@type': 'SportsClub',
  '@id': `${SITE_URL}#club`,
  name: clubName,
  alternateName: `Клуб бадминтона «${clubName}»`,
  description: text('meta[name="description"]'),
  url: SITE_URL,
  logo: absolute('assets/logo.png'),
  image: text('meta[property="og:image"]') || absolute('assets/og-cover.png'),
  sport: 'Бадминтон',
  ...(data.contacts?.phone ? { telephone: data.contacts.phone } : {}),
  ...(priceRange ? { priceRange } : {}),
  address: postalAddress(''),
  areaServed: { '@type': 'City', name: 'Саратов' },
  location: (data.venues || []).map((v) => ({
    '@type': 'SportsActivityLocation',
    name: v.title,
    address: postalAddress(v.address)
  })),
  ...((data.coaches || []).length ? {
    employee: data.coaches.map((c) => ({ '@type': 'Person', name: c.title, jobTitle: 'Тренер по бадминтону' }))
  } : {}),
  ...(networks.length ? { sameAs: [...new Set(networks)] } : {})
};

const ld = document.createElement('script');
ld.type = 'application/ld+json';
// «</» внутри JSON не должен закрыть тег <script>
ld.textContent = JSON.stringify(club, null, 2).replace(/<\//g, '<\\/');
document.head.appendChild(ld);

/* ---------- 3. Сохраняем ---------- */

writeFileSync(join(DIST, 'index.html'), dom.serialize() + '\n');
window.close();

// Дата по Москве: сборка идёт на GitHub в UTC
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
writeFileSync(join(DIST, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  '  <url>\n' +
  `    <loc>${SITE_URL}</loc>\n` +
  `    <lastmod>${today}</lastmod>\n` +
  '    <changefreq>weekly</changefreq>\n' +
  '  </url>\n' +
  '</urlset>\n');

console.log(`Готово: dist/ (в HTML заполнены блоки: ${rendered.join(', ') || 'нет'}; sitemap.xml, JSON-LD)`);
