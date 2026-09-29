// Собирает содержимое сайта из папки content/ (её правит Pages CMS)
// в один файл site/data.json, который читает сайт.
//
// Что делает по дороге:
//  • подставляет связанные записи: площадку, вид тренировки и уровни в расписание,
//    площадку в турнир — как связи между таблицами в базе данных;
//  • подставляет общие контакты (главную сеть, сети для записи), если в блоке не указан свой;
//  • превращает Markdown из форматированных полей в HTML;
//  • заменяет {телефон}, {группа}, {уровни} и {Название сети} в текстах.
//
// Запуск: npm run build  (на GitHub это делает workflow перед публикацией)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'site', 'data.json');

const DAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const DAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/* ---------- чтение ---------- */

const warnings = [];
function warn(message) {
  warnings.push(message);
  console.warn((process.env.GITHUB_ACTIONS ? '::warning::' : '⚠ ') + message);
}

function readJson(rel, fallback) {
  const file = join(CONTENT, rel);
  if (!existsSync(file)) {
    warn(`Нет файла content/${rel}`);
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    warn(`Не удалось прочитать content/${rel}: ${error.message}`);
    return fallback;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(rel) {
  const data = readJson(rel, {});
  return isObject(data) ? data : {};
}

function readList(rel) {
  const data = readJson(rel, {});
  return isObject(data) && Array.isArray(data.items) ? data.items.filter(isObject) : [];
}

// Справочник = папка, где каждая запись — отдельный файл. id записи — имя файла:
// именно его Pages CMS сохраняет в полях-ссылках.
function readCollection(dir) {
  const folder = join(CONTENT, dir);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const data = readJson(`${dir}/${name}`, null);
      return isObject(data) ? { ...data, id: name } : null;
    })
    .filter(Boolean)
    .sort(byOrder);
}

/* ---------- мелочи ---------- */

function str(value) {
  return value == null ? '' : String(value).trim();
}

function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function byOrder(a, b) {
  const oa = num(a.order) ?? Number.MAX_SAFE_INTEGER;
  const ob = num(b.order) ?? Number.MAX_SAFE_INTEGER;
  return oa - ob || str(a.title).localeCompare(str(b.title), 'ru');
}

const isShown = (item) => item.show !== false && item.show !== 'false';

function escapeHtml(value) {
  return str(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Ссылки принимаем только безопасные: http(s), tel:, mailto: и пути внутри сайта
function safeUrl(value) {
  const raw = str(value).replace(/[\u0000-\u001f\u007f]/g, '');
  if (!raw || raw.startsWith('//')) return '';
  if (/^(https?:|tel:|mailto:)/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(raw)) return '';
  return raw;
}

// Pages CMS пишет путь к картинке как «media/файл.jpg»; ведущий «/» убираем,
// чтобы картинки работали и на домене, и в подпапке github.io
function mediaUrl(value) {
  return safeUrl(str(value).replace(/^\/(?!\/)/, ''));
}

function telHref(phone) {
  const digits = str(phone).replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : '';
}

function telegramHandle(url) {
  const match = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/(?:joinchat\/)?([^/?#]+)/i.exec(str(url));
  return match ? `@${match[1]}` : '';
}

// Подпись для ссылки-контакта: @ник для Telegram, номер для телефона
function contactLabel(url) {
  if (/^tel:/i.test(url)) return url.slice(4);
  if (/^mailto:/i.test(url)) return url.slice(7);
  return telegramHandle(url) || (/max\.ru/i.test(url) ? 'в MAX' : 'по ссылке');
}

function parseDate(value) {
  const text = str(value);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

function makeIndex(items, what) {
  const map = new Map(items.map((item) => [item.id, item]));
  return (id, where) => {
    const key = str(id);
    if (!key) return null;
    const found = map.get(key) || map.get(`${key}.json`);
    if (!found) warn(`${where}: ${what} «${key}» не найден(а) — возможно, запись удалили из справочника`);
    return found || null;
  };
}

/* ---------- общие контакты ---------- */

// Все соцсети и мессенджеры — одним списком. Одна отмечена главной (туда ведут
// кнопки по умолчанию), через отмеченные «записываются» появляются кнопки записи.
const general = readObject('general.json');
const networks = (Array.isArray(general.networks) ? general.networks : [])
  .filter(isObject)
  .map((n) => ({ title: str(n.title), link: safeUrl(n.link), main: n.main === true, signup: n.signup === true }))
  .filter((n) => n.title && n.link);

const mainMarked = networks.filter((n) => n.main);
const mainNetwork = mainMarked[0] || networks.find((n) => n.signup) || networks[0] || null;
if (mainMarked.length > 1) warn(`Главными отмечено несколько сетей — используется первая: «${mainNetwork.title}»`);
if (!mainMarked.length && mainNetwork) warn(`Ни одна сеть не отмечена главной — используется «${mainNetwork.title}»`);
if (!mainNetwork) warn('В «Контактах и соцсетях» нет ни одной сети — кнопкам записи некуда вести');

const pick = ({ title, link }) => ({ title, link });
const contacts = {
  phone: str(general.phone),
  phoneHref: telHref(general.phone),
  phoneNote: str(general.phone_note),
  main: mainNetwork ? { ...pick(mainNetwork), handle: telegramHandle(mainNetwork.link) } : null,
  signup: networks.filter((n) => n.signup).map(pick),          // кнопки «Записаться в …» / «Группа в …»
  socials: networks.filter((n) => !n.signup).map(pick)         // остальные — ссылками внизу страницы
};
const mainLink = contacts.main ? contacts.main.link : '';

function normName(value) {
  return str(value).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '');
}

/* ---------- справочники ---------- */

const levels = readCollection('levels').map((l) => ({
  id: l.id,
  title: str(l.title),
  description: str(l.description),
  order: num(l.order)
}));
const levelOrder = new Map(levels.map((l, i) => [l.id, i]));
const findLevel = makeIndex(levels, 'уровень');

/* ---------- Markdown ---------- */

marked.setOptions({ gfm: true, breaks: true });

function link(href, text, external) {
  return `<a class="link-accent" href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(text)}</a>`;
}

function levelsListHtml() {
  const items = levels.filter((l) => l.description);
  if (!items.length) return '';
  return '<ul class="levels-list">' + items.map((l) =>
    `<li><strong>${escapeHtml(l.title)}</strong> — ${escapeHtml(l.description)}</li>`).join('') + '</ul>';
}

function networkLink(network) {
  return link(network.link, telegramHandle(network.link) || network.title, true);
}

const PLACEHOLDERS = {
  'телефон': () => contacts.phoneHref ? link(contacts.phoneHref, contacts.phone, false) : escapeHtml(contacts.phone),
  'группа': () => mainNetwork ? networkLink(mainNetwork) : '',
  'уровни': () => levels.map((l) => escapeHtml(l.title)).join(', ')
};

// {телефон}, {группа}, {уровни} — и любая сеть по названию: {Telegram}, {MAX}, {ВКонтакте}…
function placeholder(name) {
  const key = normName(name);
  if (PLACEHOLDERS[key]) return PLACEHOLDERS[key]();
  const network = networks.find((n) => normName(n.title) === key);
  return network ? networkLink(network) : null;
}

function markdown(value, where) {
  const source = str(value);
  if (!source) return '';
  let html = marked.parse(source);
  // {уровни} отдельным абзацем превращается в список уровней с описаниями
  html = html.replace(/<p>\s*\{уровни\}\s*<\/p>/g, () => levelsListHtml());
  html = html.replace(/\{([^{}<>\n]{1,40})\}/g, (match, name) => {
    const result = placeholder(name);
    if (result !== null) return result;
    warn(`${where}: неизвестная подстановка ${match} — оставлена как есть`);
    return match;
  });
  return html.trim();
}

/* ---------- справочники с Markdown ---------- */

const trainingTypes = readCollection('training-types');
const findType = makeIndex(trainingTypes, 'вид тренировки');

const venues = readCollection('venues');
const findVenue = makeIndex(venues, 'площадка');
const shownVenues = venues.filter(isShown);
const venueAnchor = new Map(shownVenues.map((v) => [v.id, `venue-${v.id.replace(/\.json$/, '')}`]));

function venueRef(venue) {
  if (!venue) return null;
  return {
    title: str(venue.full_name) || str(venue.title),
    anchor: venueAnchor.get(venue.id) || ''
  };
}

const coaches = readCollection('coaches').filter(isShown).map((c) => ({
  title: str(c.title),
  photo: mediaUrl(c.photo),
  html: markdown(c.about, `Тренер «${str(c.title)}»`),
  telegram: safeUrl(c.telegram)
})).filter((c) => c.title);

/* ---------- расписание ---------- */

function dayIndex(day) {
  const i = DAYS.indexOf(str(day).toLowerCase().replace(/ё/g, 'е'));
  return i === -1 ? DAYS.length : i;
}

function startMinutes(time) {
  const m = /(\d{1,2})[:.](\d{2})/.exec(str(time));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60;
}

const schedule = readList('schedule.json').filter(isShown).map((row, i) => {
  const where = `Расписание, строка ${i + 1} (${str(row.day)} ${str(row.time)})`;
  const type = findType(row.type, where);
  const venue = findVenue(row.venue, where);
  const rowLevels = (Array.isArray(row.levels) ? row.levels : [row.levels])
    .map((id) => findLevel(id, where))
    .filter(Boolean)
    .sort((a, b) => levelOrder.get(b.id) - levelOrder.get(a.id))   // от сильных к новичкам
    .map((l) => ({ title: l.title, description: l.description }));
  const price = (num(row.price) || null) ?? (venue ? num(venue.price) || null : null);
  const d = dayIndex(row.day);
  return {
    day: str(row.day),
    dayShort: DAY_SHORT[d] || str(row.day).slice(0, 2).toLowerCase(),
    time: str(row.time).replace(/\s*-\s*/, '–'),
    type: type ? { title: str(type.title), highlight: type.highlight === true } : null,
    venue: venueRef(venue),
    venueId: venue ? venue.id : '',
    levels: rowLevels,
    price,
    _sort: [d, startMinutes(row.time), i]
  };
}).sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2])
  .map(({ _sort, ...row }) => row);

/* ---------- площадки: дни тренировок берём из расписания ---------- */

const venuesOut = shownVenues.map((v) => {
  const days = [...new Set(schedule.filter((r) => r.venueId === v.id).map((r) => r.dayShort))]
    .sort((a, b) => DAY_SHORT.indexOf(a) - DAY_SHORT.indexOf(b));
  const address = str(v.address);
  return {
    anchor: venueAnchor.get(v.id),
    title: str(v.full_name) || str(v.title),
    address,
    map: safeUrl(v.map_link) || (address ? `https://yandex.ru/maps/?text=${encodeURIComponent(address)}` : ''),
    days
  };
});

/* ---------- виды тренировок ---------- */

const trainings = trainingTypes.filter(isShown).map((t) => {
  const contact = safeUrl(t.contact);
  return {
    title: str(t.title),
    html: markdown(t.description, `Вид тренировки «${str(t.title)}»`),
    contact: contact ? { href: contact, label: contactLabel(contact) } : null
  };
}).filter((t) => t.title);

/* ---------- блоки ---------- */

const hero = readObject('hero.json');
const signup = readObject('signup.json');
const final = readObject('final.json');

// Свои кнопки записи блока, если заполнены, иначе — сети с отметкой «через неё записываются»
const signupOwn = (Array.isArray(signup.links) ? signup.links : []).filter(isObject)
  .map((l) => ({ title: str(l.title), link: safeUrl(l.link) }))
  .filter((l) => l.title && l.link);

// Акции и турниры — разные списки, но карточки у них одинаковые
function cards(file, section) {
  return readList(file).filter(isShown).map((e) => {
    const title = str(e.title);
    const where = `${section}, «${title}»`;
    const ref = venueRef(findVenue(e.venue, where));
    const ownLink = safeUrl(e.button_link);
    const label = str(e.button_label) || (ownLink ? 'Подробнее' : '');
    return {
      title,
      when: str(e.when),
      place: ref ? ref.title : str(e.place),
      placeAnchor: ref ? ref.anchor : '',
      html: markdown(e.text, where),
      image: mediaUrl(e.image),
      buttonLabel: label,
      buttonLink: label ? (ownLink || mainLink) : '',   // своя ссылка или главная сеть
      until: parseDate(e.until)
    };
  }).filter((e) => e.title);
}

const data = {
  contacts,
  hero: { title: str(hero.title), slogan: str(hero.slogan), text: str(hero.text) },
  trainings,
  schedule: schedule.map(({ venueId, ...row }) => row),
  signup: {
    show: signup.show !== false,
    eyebrow: str(signup.eyebrow),
    title: str(signup.title),
    steps: (Array.isArray(signup.steps) ? signup.steps : []).filter(isObject).map((s, i) => ({
      title: str(s.title),
      html: markdown(s.text, `Как записаться, шаг ${i + 1}`)
    })).filter((s) => s.title || s.html),
    // свои кнопки блока, если заполнены, иначе общие
    links: signupOwn.length ? signupOwn : contacts.signup
  },
  venues: venuesOut,
  coaches,
  promos: cards('promos.json', 'Акции'),
  tournaments: cards('tournaments.json', 'Турниры'),
  partners: readList('partners.json').filter(isShown).map((p) => ({
    title: str(p.title),
    description: str(p.description),
    logo: mediaUrl(p.logo),
    link: safeUrl(p.link)
  })).filter((p) => p.title),
  faq: readList('faq.json').filter(isShown).map((q) => ({
    question: str(q.question),
    html: markdown(q.answer, `Вопрос «${str(q.question)}»`)
  })).filter((q) => q.question && q.html),
  final: { title: str(final.title), text: str(final.text), groupsText: str(final.groups_text) }
};

writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`Готово: site/data.json (${schedule.length} строк расписания, ${venuesOut.length} площадок, ` +
  `${trainings.length} видов тренировок, предупреждений: ${warnings.length})`);
