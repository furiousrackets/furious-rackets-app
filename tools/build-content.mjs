// Собирает содержимое сайта из папки content/ (её правит Pages CMS)
// в один файл site/data.json, который читает сайт.
//
// Что делает по дороге:
//  • подставляет связанные записи: площадку, вид тренировки и уровни в расписание,
//    площадку в турнир — как связи между таблицами в базе данных;
//  • подставляет выбранные соцсети и телефон; в блоке свой контакт — только если отличается;
//  • превращает Markdown из форматированных полей в HTML;
//  • заменяет {телефон}, {уровни} и {Название соцсети} в текстах.
//
// Запуск: npm run build  (на GitHub это делает workflow перед публикацией)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'site', 'data.json');
const SITE = join(ROOT, 'site');
// Уменьшенные копии фото (WebP) — собираются здесь, в git не хранятся
const GEN = 'gen';
const PHOTO_WIDTHS = [320, 640, 1024, 1600];

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

// Телефон — один на сайт. Соцсети — справочник (название и ссылка); в блоках
// их выбирают из списка, и они показываются в том порядке, в котором выбраны.
const general = readObject('general.json');
const contacts = {
  phone: str(general.phone),
  phoneHref: telHref(general.phone)
};

const networks = readCollection('networks')
  .map((n) => ({ id: n.id, title: str(n.title), link: safeUrl(n.link) }))
  .filter((n) => n.title && n.link);
const findNetwork = makeIndex(networks, 'соцсеть');

function pickNetworks(ids, where) {
  return (Array.isArray(ids) ? ids : [ids])
    .map((id) => findNetwork(id, where))
    .filter(Boolean)
    .map(({ title, link }) => ({ title, link }));
}

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

// Цвет карточки вида тренировки в расписании; старое «Выделять» = салатовый
const TYPE_COLORS = ['lime', 'white', 'blue', 'gray', 'dark'];
function typeColor(type) {
  const color = str(type.color);
  if (TYPE_COLORS.includes(color)) return color;
  return type.highlight === true ? 'lime' : 'dark';
}
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
  'уровни': () => levels.map((l) => escapeHtml(l.title)).join(', ')
};

// {телефон}, {уровни} — и любая соцсеть по названию: {Telegram}, {MAX}, {ВКонтакте}…
function placeholder(name) {
  const key = normName(name);
  if (PLACEHOLDERS[key]) return PLACEHOLDERS[key]();
  const network = networks.find((n) => normName(n.title) === key);
  return network ? networkLink(network) : null;
}

// Одна строка: только *выделение*, без абзацев
function inlineMarkdown(value, where) {
  const source = str(value);
  if (!source) return '';
  // неразрывный пробел перед тире — чтобы тире не уезжало в начало строки
  return marked.parseInline(source).trim().replace(/ (—|–) /g, '\u00a0$1 ');
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
    short: str(venue.title) || str(venue.full_name),
    anchor: venueAnchor.get(venue.id) || ''
  };
}

// Фото тренера тоже сжимаем; если сжать не вышло (например, ссылка на другой сайт) — берём как есть
const coaches = [];
for (const c of readCollection('coaches').filter(isShown)) {
  const title = str(c.title);
  if (!title) continue;
  const photo = await photoVariants(c.photo, `Тренер «${title}»`);
  coaches.push({
    title,
    photo: photo ? photo.src : mediaUrl(c.photo),
    photoSrcset: photo ? photo.srcset : '',
    photoAlt: `${title} — тренер по бадминтону клуба «Бешеные ракетки», Саратов`,
    html: markdown(c.about, `Тренер «${title}»`),
    telegram: safeUrl(c.telegram)
  });
}

/* ---------- расписание ---------- */

function dayIndex(day) {
  const i = DAYS.indexOf(str(day).toLowerCase().replace(/ё/g, 'е'));
  return i === -1 ? DAYS.length : i;
}

function startMinutes(time) {
  const m = /(\d{1,2})[:.](\d{2})/.exec(str(time));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60;
}

// Строка, поделённая на отдельные занятия (у персональных): 18:00–22:00 по 60 мин →
// карточки 18:00–19:00, 19:00–20:00, 20:00–21:00, 21:00–22:00
function splitIntoSessions(time, len, where) {
  if (!len) return null;
  const m = /(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/.exec(str(time));
  if (!m || len < 15) {
    warn(`${where}: не получается поделить время на занятия по ${len} мин`);
    return null;
  }
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  const hhmm = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const times = [];
  for (let t = from; t + len <= to; t += len) times.push(`${hhmm(t)}–${hhmm(t + len)}`);
  if (!times.length) {
    warn(`${where}: время короче одного занятия (${len} мин)`);
    return null;
  }
  if ((to - from) % len) warn(`${where}: время не делится ровно на занятия по ${len} мин — хвост не показан`);
  return times;
}

// Отмены на конкретные даты: { date: '2026-12-31', start: минуты от полуночи или null, reason }
const scheduleFile = readObject('schedule.json');
const cancellations = (Array.isArray(scheduleFile.cancellations) ? scheduleFile.cancellations : [])
  .filter(isObject)
  .map((c, i) => {
    const raw = str(c.date);
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!m) {
      const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
      if (ru) m = [raw, ru[3], ru[2].padStart(2, '0'), ru[1].padStart(2, '0')];
    }
    if (!m) {
      if (raw) warn(`Расписание, отмена ${i + 1}: не понимаю дату «${raw}»`);
      return null;
    }
    const t = /(\d{1,2})[:.](\d{2})/.exec(str(c.time));
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      start: t ? Number(t[1]) * 60 + Number(t[2]) : null,
      reason: str(c.reason)
    };
  })
  .filter(Boolean);

const schedule = readList('schedule.json').filter(isShown).map((row, i) => {
  const where = `Расписание, строка ${i + 1} (${str(row.day)} ${str(row.time)})`;
  const type = findType(row.type, where);
  const venue = findVenue(row.venue, where);
  const rowLevels = (Array.isArray(row.levels) ? row.levels : [row.levels])
    .map((id) => findLevel(id, where))
    .filter(Boolean)
    .sort((a, b) => levelOrder.get(b.id) - levelOrder.get(a.id))   // от сильных к новичкам
    .map((l) => ({ title: l.title, description: l.description }));
  // пусто — цена площадки; 0 — без цены (например, у персональных, пока цена не указана)
  const price = num(row.price) === 0 ? null : (num(row.price) || null) ?? (venue ? num(venue.price) || null : null);
  const d = dayIndex(row.day);
  const base = {
    day: str(row.day),
    dayShort: DAY_SHORT[d] || str(row.day).slice(0, 2).toLowerCase(),
    time: str(row.time).replace(/\s*-\s*/, '–'),
    type: type ? { title: str(type.title), color: typeColor(type), ...(type.hide_levels === true ? { hideLevels: true } : {}) } : null,
    venue: venueRef(venue),
    venueId: venue ? venue.id : '',
    levels: rowLevels,
    price,
    _sort: [d, startMinutes(row.time), i]
  };
  // «Занятия по, мин» — каждое занятие отдельной карточкой
  const sessions = splitIntoSessions(row.time, num(row.slot_minutes), where);
  return sessions
    ? sessions.map((time) => ({ ...base, time, _sort: [d, startMinutes(time), i] }))
    : [base];
}).flat().sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2])
  .map(({ _sort, ...row }) => row);

/* ---------- фото: сжатие и несколько размеров ----------
   Админ загружает фото как есть (хоть 5 МБ с телефона). Сборка делает из каждого
   WebP-копии шириной 320/640/1024/1600 px — браузер сам берёт подходящую по экрану.
   Копии кешируются: пересобираются, только если исходник новее. */

async function photoVariants(path, where) {
  const rel = mediaUrl(path);
  if (!rel || /^https?:/i.test(rel)) return null;
  const src = join(SITE, rel);
  if (!existsSync(src)) {
    warn(`${where}: нет файла site/${rel}`);
    return null;
  }
  try {
    const image = sharp(src).rotate();   // rotate() — по EXIF, чтобы фото с телефона не лежали на боку
    const meta = await image.metadata();
    const portrait = (meta.orientation || 1) >= 5;
    const srcW = portrait ? meta.height : meta.width;
    const srcH = portrait ? meta.width : meta.height;
    const base = rel.replace(/^media\//, '').slice(0, -extname(rel).length || undefined);
    const srcTime = statSync(src).mtimeMs;
    const widths = [...new Set(PHOTO_WIDTHS.map((w) => Math.min(w, srcW)))];
    const files = [];
    for (const w of widths) {
      const out = `${GEN}/${base}-${w}.webp`;
      const abs = join(SITE, out);
      if (!existsSync(abs) || statSync(abs).mtimeMs < srcTime) {
        mkdirSync(dirname(abs), { recursive: true });
        await sharp(src).rotate().resize({ width: w, withoutEnlargement: true })
          .webp({ quality: 78, effort: 5 }).toFile(abs);
      }
      files.push({ w, url: out });
    }
    const pick = (min) => files.find((f) => f.w >= min) || files[files.length - 1];
    return {
      src: pick(1024).url,
      thumb: pick(320).url,
      full: files[files.length - 1].url,
      srcset: files.map((f) => `${f.url} ${f.w}w`).join(', '),
      width: srcW,
      height: srcH
    };
  } catch (error) {
    warn(`${where}: не удалось обработать фото ${rel}: ${error.message}`);
    return null;
  }
}

function list(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/* ---------- площадки: дни тренировок берём из расписания ---------- */

// «51.531542, 45.983106» (так их показывают Яндекс Карты: широта, долгота) → { lat, lon }
function point(value, where) {
  const raw = str(value);
  if (!raw) return null;
  const nums = raw.replace(/[;\s]+/g, ' ').replace(/,(?=\s|$)/g, ' ').split(/[ ,]+/).filter(Boolean).map(Number);
  const [lat, lon] = nums;
  if (nums.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    warn(`${where}: не понимаю точку на карте «${raw}» — нужно «широта, долгота», например 51.531542, 45.983106`);
    return null;
  }
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}

const venuesOut = [];
for (const v of shownVenues) {
  const days = [...new Set(schedule.filter((r) => r.venueId === v.id).map((r) => r.dayShort))]
    .sort((a, b) => DAY_SHORT.indexOf(a) - DAY_SHORT.indexOf(b));
  const address = str(v.address);
  const title = str(v.full_name) || str(v.title);
  const short = str(v.title) || title;
  const geo = point(v.point, `Площадка «${short}»`);
  const photos = [];
  for (const path of list(v.photos)) {
    const variants = await photoVariants(path, `Площадка «${short}»`);
    if (!variants) continue;
    // подпись для поисковиков и экранных дикторов
    variants.alt = `Бадминтон в Саратове — тренировка клуба «Бешеные ракетки», ${short}, фото ${photos.length + 1}`;
    photos.push(variants);
  }
  venuesOut.push({
    anchor: venueAnchor.get(v.id),
    title,
    short,
    address,
    map: safeUrl(v.map_link) ||
      (geo ? `https://yandex.ru/maps/?pt=${geo.lon},${geo.lat}&z=17&l=map` : '') ||
      (address ? `https://yandex.ru/maps/?text=${encodeURIComponent(address)}` : ''),
    geo,   // точка для карты в сетке фото и для разметки schema.org
    days,
    photos
  });
}

/* ---------- виды тренировок ---------- */

// «Написать тренеру» ведёт к блоку «Тренеры» — только если там есть кого показать
const trainings = [];
for (const t of trainingTypes.filter(isShown)) {
  const title = str(t.title);
  if (!title) continue;
  const photo = await photoVariants(t.photo, `Вид тренировки «${title}»`);
  if (photo) photo.alt = `${title} тренировка по бадминтону в Саратове — клуб «Бешеные ракетки»`;
  trainings.push({
    title,
    html: markdown(t.description, `Вид тренировки «${title}»`),
    coachesLink: t.coaches_link === true && coaches.length > 0,
    color: typeColor(t),
    photo
  });
}

/* ---------- блоки ---------- */

const hero = readObject('hero.json');

// Лента фото под первым экраном: «Фото ленты» из админки — ровно они и в этом порядке.
// Если там пусто — лента собирается сама из фото площадок (все, кроме первого, общего);
// тогда в браузере берутся случайные и каждый раз в новом порядке.
const stripContent = readObject('strip.json');
const stripPhotos = [];
let stripCustom = false;
if (stripContent.show !== false) {
  for (const path of list(stripContent.photos)) {
    const variants = await photoVariants(path, 'Лента фото');
    if (!variants) continue;
    variants.alt = `Бадминтон в Саратове — тренировка клуба «Бешеные ракетки», фото ${stripPhotos.length + 1}`;
    stripPhotos.push(variants);
  }
  stripCustom = stripPhotos.length > 0;
  if (!stripCustom) {
    const pools = venuesOut.map((v) => v.photos.slice(1));
    for (let i = 0; pools.some((pool) => i < pool.length); i += 1) {
      for (const pool of pools) if (pool[i]) stripPhotos.push(pool[i]);
    }
  }
}
// одно и то же фото — один раз
const seenStrip = new Set();
for (let i = stripPhotos.length - 1; i >= 0; i -= 1) {
  if (seenStrip.has(stripPhotos[i].full)) stripPhotos.splice(i, 1);
  else seenStrip.add(stripPhotos[i].full);
}
const signup = readObject('signup.json');
const final = readObject('final.json');
const sheet = isObject(signup.sheet) ? signup.sheet : {};   // окно «Записаться»


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
      buttonLink: label ? ownLink : '',   // пусто — кнопка открывает окно «Записаться»
      until: parseDate(e.until)
    };
  }).filter((e) => e.title);
}

const data = {
  contacts,
  strip: { photos: stripPhotos, custom: stripCustom },
  hero: { heading: str(hero.heading), title: str(hero.title), slogan: str(hero.slogan), text: str(hero.text) },
  trainings,
  schedule: schedule.map(({ venueId, ...row }) => row),
  cancellations,
  signup: {
    show: signup.show !== false,
    steps: (Array.isArray(signup.steps) ? signup.steps : []).filter(isObject).map((s, i) => ({
      title: str(s.title),
      html: markdown(s.text, `Запись, шаг ${i + 1}`)
    })).filter((s) => s.title || s.html),
    // окно «Записаться»: каналы — сети с отметкой в «Контактах и соцсетях» и телефон
    buttonLabel: str(signup.button_label) || 'Записаться на тренировку',
    sheetTitle: str(sheet.title),
    sheetNetworks: pickNetworks(sheet.networks, 'Окно «Записаться»'),
    sheetText: str(sheet.text),
    sheetNetworkLabel: str(sheet.network_label) || 'Написать в {сеть}',
    sheetPhone: sheet.phone !== false,
    sheetPhoneLabel: str(sheet.phone_label) || 'Позвонить'
  },
  venues: venuesOut,
  coaches,
  promos: cards('promos.json', 'Акции'),
  tournaments: cards('tournaments.json', 'Турниры'),
  partners: readList('partners.json').filter(isShown).map((p) => ({
    title: str(p.title),
    html: markdown(p.description, `Партнёр «${str(p.title)}»`),
    logo: mediaUrl(p.logo),
    link: safeUrl(p.link),
    linkLabel: str(p.link_label)
  })).filter((p) => p.title),
  faq: readList('faq.json').filter(isShown).map((q) => ({
    question: str(q.question),
    html: markdown(q.answer, `Вопрос «${str(q.question)}»`)
  })).filter((q) => q.question && q.html),
  final: {
    title: str(final.title),
    text: str(final.text),
    groupsText: str(final.groups_text),
    groups: pickNetworks(final.group_networks, 'Приходи играть, кнопки групп'),
    groupLabel: str(final.group_label) || 'Группа в {сеть}',
    links: pickNetworks(final.links, 'Приходи играть, ссылки на соцсети'),
    aboutHtml: markdown(final.about, 'Приходи играть, о клубе')
  }
};

writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`Готово: site/data.json (${schedule.length} строк расписания, ${venuesOut.length} площадок, ` +
  `${trainings.length} видов тренировок, предупреждений: ${warnings.length})`);
