(function () {
  'use strict';

  // Содержимое сайта лежит в site/content/*.json и редактируется через Pages CMS
  // (настройка полей — в .pages.yml в корне репозитория).
  var CONTENT_DIR = 'content/';
  var TIMEOUT_MS = 8000;

  var FILES = ['settings', 'trainings', 'schedule', 'signup', 'venues', 'promos',
    'tournaments', 'coaches', 'partners', 'faq', 'socials'];

  // Файлы-объекты (одна форма в админке); остальные — списки { "items": [...] }.
  var OBJECT_FILES = ['settings', 'signup'];

  function isObjectFile(name) { return OBJECT_FILES.indexOf(name) !== -1; }

  var FALLBACK_TELEGRAM = 'https://t.me/furiousrackets';

  var DAY_SHORT = {
    'понедельник': 'пн',
    'вторник': 'вт',
    'среда': 'ср',
    'четверг': 'чт',
    'пятница': 'пт',
    'суббота': 'сб',
    'воскресенье': 'вс'
  };
  var DAY_ORDER = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  /* ---------- утилиты ---------- */

  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ESCAPES[ch];
    });
  }

  function escMultiline(value) {
    return esc(value).replace(/\r\n|\r|\n/g, '<br>');
  }

  var LINKS = {};

  function richText(value) {
    var html = escMultiline(value);
    return html.replace(/\{(телефон|тренер|группа)\}/g, function (match, name) {
      return LINKS[name] || '';
    });
  }

  function handleFromUrl(url) {
    var match = /^https?:\/\/[^/]+\/(?:joinchat\/)?([^/?#]+)/i.exec(String(url || ''));
    return match ? '@' + match[1] : '';
  }

  function buildLinks(settings) {
    LINKS = {};

    var phone = settings.phone || '';
    var phoneHref = telHref(phone);
    if (phoneHref) {
      LINKS['телефон'] = '<a class="link-accent" href="' + phoneHref + '">' + esc(phone) + '</a>';
    }

    var coach = safeUrl(settings.coach_telegram);
    if (coach) {
      LINKS['тренер'] = '<a class="link-soft" href="' + coach + '" target="_blank" rel="noopener">' +
        esc(handleFromUrl(settings.coach_telegram) || 'в Telegram') + '</a>';
    }

    var group = safeUrl(settings.group_telegram) || FALLBACK_TELEGRAM;
    LINKS['группа'] = '<a class="link-accent" href="' + group + '" target="_blank" rel="noopener">' +
      esc(handleFromUrl(group) || 'в Telegram') + '</a>';
  }

  function stripControls(value) {
    var text = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code > 31 && code !== 127) out += text.charAt(i);
    }
    return out;
  }

  function safeUrl(value) {
    var raw = stripControls(value).trim();
    if (!raw) return '';
    if (/^\/\//.test(raw)) return '';
    if (/^(https?:|tel:|mailto:)/i.test(raw)) return esc(raw);
    if (/^[a-z][a-z0-9+.\-]*:/i.test(raw)) return '';
    return esc(raw);
  }

  // Pages CMS пишет путь к картинке как «media/файл.jpg». Ведущий «/» убираем,
  // чтобы картинки работали и на github.io/<репозиторий>/, и на своём домене.
  function mediaUrl(value) {
    var raw = stripControls(value).trim().replace(/^\/(?!\/)/, '');
    return safeUrl(raw);
  }

  function telHref(phone) {
    var digits = String(phone || '').replace(/[^\d+]/g, '');
    return digits ? 'tel:' + esc(digits) : '';
  }

  function cell(row, key) {
    var value = row ? row[key] : '';
    if (Array.isArray(value)) value = value.join(', ');
    return String(value == null ? '' : value).trim();
  }

  /* ---------- фильтры строк ---------- */

  function isShown(row) {
    if (!row || typeof row !== 'object') return false;
    return row.show !== false && row.show !== 'false';
  }

  function parseDate(value) {
    var text = String(value || '').trim();
    var match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    var year, month, day;

    if (match) {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    } else {
      match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
      if (!match) return null;
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    }

    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function isActual(row) {
    var raw = cell(row, 'until');
    if (!raw) return true;
    var until = parseDate(raw);
    if (!until) return true;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return today.getTime() <= until.getTime();
  }

  function visibleRows(rows) {
    return (rows || []).filter(function (row) {
      return isShown(row) && isActual(row);
    });
  }

  /* ---------- загрузка ---------- */

  function fetchJson(name) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    // no-cache: браузер каждый раз сверяется с сервером, и правки из админки
    // видны сразу после публикации, а не через 10 минут кеша GitHub Pages.
    var options = { cache: 'no-cache' };
    if (controller) options.signal = controller.signal;
    var timer;

    var request = fetch(CONTENT_DIR + name + '.json', options).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });

    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('timeout'));
      }, TIMEOUT_MS);
    });

    return Promise.race([request, timeout]).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  // Списки лежат в файлах как { "items": [...] }, настройки — простым объектом.
  // Если файл не загрузился или испорчен, блок просто скрывается.
  function loadFile(name) {
    return fetchJson(name).then(function (data) {
      if (isObjectFile(name)) return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      var items = data && Array.isArray(data.items) ? data.items : [];
      return items.filter(function (item) { return item && typeof item === 'object'; });
    }).catch(function () {
      return isObjectFile(name) ? {} : [];
    });
  }

  function loadContent() {
    return Promise.all(FILES.map(loadFile)).then(function (results) {
      var data = {};
      FILES.forEach(function (name, index) {
        data[name] = results[index];
      });
      return data;
    });
  }

  /* ---------- настройки ---------- */

  function toSettings(source) {
    var map = {};
    Object.keys(source || {}).forEach(function (key) {
      map[key] = cell(source, key);
    });
    return map;
  }

  function applySettings(settings) {
    buildLinks(settings);

    var telegram = safeUrl(settings.group_telegram) || FALLBACK_TELEGRAM;
    var phone = settings.phone || '';
    var phoneLink = telHref(phone);

    qa('[data-tg-link]').forEach(function (node) {
      node.setAttribute('href', telegram);
    });

    var max = safeUrl(settings.group_max);
    qa('[data-max-link]').forEach(function (node) {
      if (max) node.setAttribute('href', max);
      node.hidden = !max;
    });

    qa('[data-phone-link]').forEach(function (node) {
      if (phoneLink) {
        node.setAttribute('href', phoneLink);
        node.hidden = false;
      } else {
        node.hidden = true;
      }
    });
    qa('[data-phone-text]').forEach(function (node) {
      node.textContent = phone;
    });

    qa('[data-phone-name]').forEach(function (node) {
      if (settings.phone_name) {
        node.innerHTML = escMultiline(settings.phone_name);
        node.hidden = false;
      } else {
        node.hidden = true;
      }
    });

    setText('[data-hero-title]', settings.hero_title);
    setText('[data-hero-slogan]', settings.hero_slogan);
    setText('[data-hero-text]', settings.hero_text);

    var intro = q('[data-tournaments-intro]');
    if (intro) {
      if (settings.tournaments_intro) {
        intro.innerHTML = escMultiline(settings.tournaments_intro);
        intro.hidden = false;
      } else {
        intro.hidden = true;
      }
    }
  }

  function setText(selector, value) {
    var node = q(selector);
    if (node && value) node.innerHTML = escMultiline(value);
  }

  /* ---------- отрисовка ---------- */

  // Сколько колонок дать блоку, чтобы не оставалось пустых ячеек:
  // 1 запись — во всю ширину, 2 — в две колонки, 4 — сеткой 2×2 и т. д.
  // Неполный последний ряд растягивается на всю ширину (см. .auto-grid в CSS).
  function gridCols(count, max) {
    if (count <= max) return Math.max(count, 1);
    var best = max;
    var bestRest = -1;
    for (var cols = max; cols >= 2; cols -= 1) {
      var rest = count % cols;
      if (rest === 0) return cols;
      if (rest > bestRest) {
        best = cols;
        bestRest = rest;
      }
    }
    return best;
  }

  function layoutGrid(host, count, max) {
    if (!host) return;
    host.style.setProperty('--cols', String(gridCols(count, max)));
    host.style.setProperty('--cols-md', String(gridCols(count, Math.min(max, 2))));
    host.setAttribute('data-count', String(count));
  }

  // Если в блоке несколько карточек и у части есть картинка, остальным
  // ставим заглушку со знаком клуба — чтобы карточки в ряду были одной высоты.
  function needsPlaceholder(items, field) {
    if (items.length < 2) return false;
    return items.some(function (row) { return mediaUrl(cell(row, field)); });
  }

  function placeholder(prefix) {
    return '<div class="' + prefix + '__media card-placeholder" aria-hidden="true">' +
      '<img src="assets/mark.png" alt="" loading="lazy"></div>';
  }

  function reveal(sectionId, isVisible) {
    var section = document.getElementById(sectionId);
    if (section) section.hidden = !isVisible;
    var link = q('[data-nav="' + sectionId + '"]');
    if (link) link.hidden = !isVisible;
  }

  function renderTrainings(rows) {
    var items = visibleRows(rows);
    var host = q('[data-trainings]');
    if (!host) return;

    host.innerHTML = items.map(function (row) {
      return '<article class="training">' +
        '<h3 class="training__title">' + esc(cell(row, 'title')) + '</h3>' +
        '<p class="training__text">' + richText(cell(row, 'description')) + '</p>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('trainings', items.length > 0);
  }

  function formatPrice(value) {
    var price = String(value == null ? '' : value).trim();
    if (!price) return '';
    if (/^\d+([.,]\d+)?$/.test(price)) return price + ' ₽';
    return price;
  }

  function levelBadges(value) {
    var levels = String(value || '').split(',').map(function (part) {
      return part.trim();
    }).filter(Boolean);

    if (!levels.length) {
      return '<span class="level level--any">все уровни</span>';
    }
    return levels.map(function (level) {
      return '<span class="level">' + esc(level) + '</span>';
    }).join('');
  }

  function dayShort(day) {
    var key = String(day || '').trim().toLowerCase().replace(/ё/g, 'е');
    if (DAY_SHORT[key]) return DAY_SHORT[key];
    return key.slice(0, 2);
  }

  function renderSchedule(rows, venueIndex) {
    var items = visibleRows(rows);
    var host = q('[data-schedule]');
    if (!host) return items;

    host.innerHTML = items.map(function (row) {
      var type = cell(row, 'type');
      var isPlay = type.toLowerCase().indexOf('игров') === 0;
      var venueKey = cell(row, 'venue');
      var venue = venueIndex.byName[venueKey.toLowerCase()];
      var venueTitle = venue ? (venue.fullName || venue.name) : venueKey;
      var venueHtml = esc(venueTitle);

      if (venue && venue.anchor) {
        venueHtml = '<a class="row__venue-link" href="#' + venue.anchor + '">' + esc(venueTitle) + '</a>';
      }

      var price = formatPrice(cell(row, 'price'));

      return '<article class="row">' +
        '<div class="row__day"><span class="row__day-in">' + esc(cell(row, 'day')) + '</span></div>' +
        '<div class="row__time">' + esc(cell(row, 'time')) + '</div>' +
        '<div class="row__meta">' +
          (type ? '<span class="type' + (isPlay ? ' type--play' : '') + '">' + esc(type) + '</span>' : '') +
          '<span class="levels">' + levelBadges(cell(row, 'levels')) + '</span>' +
        '</div>' +
        '<div class="row__venue">' + venueHtml + '</div>' +
        '<div class="row__price">' + (price ? '<span class="price">' + esc(price) + '</span>' : '') + '</div>' +
        '</article>';
    }).join('');

    reveal('schedule', items.length > 0);
    return items;
  }

  function buildVenueIndex(rows) {
    var all = (rows || []).slice();
    var shown = visibleRows(all);
    var byName = {};

    all.forEach(function (row) {
      var name = cell(row, 'name');
      if (!name) return;
      byName[name.toLowerCase()] = {
        name: name,
        fullName: cell(row, 'full_name'),
        anchor: ''
      };
    });

    shown.forEach(function (row, index) {
      var name = cell(row, 'name');
      var entry = byName[name.toLowerCase()];
      if (entry) entry.anchor = 'venue-' + (index + 1);
    });

    return { byName: byName, shown: shown };
  }

  function renderVenues(venueIndex, scheduleRows) {
    var host = q('[data-venues]');
    if (!host) return;

    var daysByVenue = {};
    visibleRows(scheduleRows).forEach(function (row) {
      var key = cell(row, 'venue').toLowerCase();
      var short = dayShort(cell(row, 'day'));
      if (!key || !short) return;
      if (!daysByVenue[key]) daysByVenue[key] = [];
      if (daysByVenue[key].indexOf(short) === -1) daysByVenue[key].push(short);
    });

    host.innerHTML = venueIndex.shown.map(function (row, index) {
      var name = cell(row, 'name');
      var fullName = cell(row, 'full_name') || name;
      var address = cell(row, 'address');
      var map = safeUrl(cell(row, 'map_link'));

      if (!map && address) {
        map = esc('https://yandex.ru/maps/?text=' + encodeURIComponent(address));
      }

      var days = (daysByVenue[name.toLowerCase()] || []).slice().sort(function (a, b) {
        return DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b);
      });

      return '<article class="venue" id="venue-' + (index + 1) + '">' +
        '<h3 class="venue__title">' + esc(fullName) + '</h3>' +
        (address ? '<p class="venue__address">' + escMultiline(address) + '</p>' : '') +
        '<div class="venue__foot">' +
          '<p class="venue__days">' + days.map(function (day) {
            return '<span class="day-chip">' + esc(day) + '</span>';
          }).join('') + '</p>' +
          (map ? '<a class="venue__map" href="' + map + '" target="_blank" rel="noopener">Показать на карте</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, venueIndex.shown.length, 3);
    reveal('venues', venueIndex.shown.length > 0);
  }

  function renderPromos(rows, telegram) {
    var items = visibleRows(rows);
    var host = q('[data-promos]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'image');

    host.innerHTML = items.map(function (row) {
      var image = mediaUrl(cell(row, 'image'));
      var label = cell(row, 'button_label');
      var link = safeUrl(cell(row, 'button_link')) || telegram;
      var title = cell(row, 'title');

      return '<article class="promo' + (image || fill ? '' : ' is-textonly') + '">' +
        (image ? '<div class="promo__media"><img src="' + image + '" alt="' + esc(title) + '" loading="lazy"></div>' : (fill ? placeholder('promo') : '')) +
        '<div class="promo__body">' +
          '<h3 class="promo__title">' + escMultiline(title) + '</h3>' +
          '<p class="promo__text">' + richText(cell(row, 'text')) + '</p>' +
          (label && link
            ? '<a class="btn btn--accent" href="' + link + '" target="_blank" rel="noopener">' + esc(label) + '</a>'
            : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('promos', items.length > 0);
  }

  function renderTournaments(rows, venueIndex) {
    var items = visibleRows(rows);
    var host = q('[data-tournaments]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'poster');

    host.innerHTML = items.map(function (row) {
      var poster = mediaUrl(cell(row, 'poster'));
      var link = safeUrl(cell(row, 'link'));
      var title = cell(row, 'title');
      var placeKey = cell(row, 'place');
      var venue = venueIndex.byName[placeKey.toLowerCase()];
      var place = venue ? (venue.fullName || venue.name) : placeKey;

      return '<article class="tournament' + (poster || fill ? '' : ' is-textonly') + '">' +
        (poster ? '<div class="tournament__media"><img src="' + poster + '" alt="' + esc(title) + '" loading="lazy"></div>' : (fill ? placeholder('tournament') : '')) +
        '<div class="tournament__body">' +
          '<h3 class="tournament__title">' + escMultiline(title) + '</h3>' +
          '<p class="tournament__when">' +
            esc(cell(row, 'dates')) +
            (place ? '<span class="tournament__where">' + esc(place) + '</span>' : '') +
          '</p>' +
          '<p class="tournament__text">' + richText(cell(row, 'text')) + '</p>' +
          (link ? '<a class="btn btn--ghost" href="' + link + '" target="_blank" rel="noopener">Подробнее</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('tournaments', items.length > 0);
  }

  function renderCoaches(rows) {
    var items = visibleRows(rows).filter(function (row) {
      return cell(row, 'name');
    });
    var host = q('[data-coaches]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'photo');

    host.innerHTML = items.map(function (row) {
      var photo = mediaUrl(cell(row, 'photo'));
      var telegram = safeUrl(cell(row, 'telegram'));
      var name = cell(row, 'name');

      return '<article class="coach' + (photo || fill ? '' : ' is-textonly') + '">' +
        (photo ? '<div class="coach__media"><img src="' + photo + '" alt="' + esc(name) + '" loading="lazy"></div>' : (fill ? placeholder('coach') : '')) +
        '<div class="coach__body">' +
          '<h3 class="coach__name">' + esc(name) + '</h3>' +
          '<p class="coach__about">' + escMultiline(cell(row, 'about')) + '</p>' +
          (telegram ? '<a class="link-accent" href="' + telegram + '" target="_blank" rel="noopener">Написать в Telegram</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    var title = q('[data-coach-title]');
    if (title) title.textContent = items.length > 1 ? 'Тренеры' : 'Тренер';

    layoutGrid(host, items.length, 3);
    reveal('coach', items.length > 0);
  }

  function renderPartners(rows) {
    var items = visibleRows(rows);
    var host = q('[data-partners]');
    if (!host) return;

    host.innerHTML = items.map(function (row) {
      var name = cell(row, 'name');
      var logo = mediaUrl(cell(row, 'logo'));
      var link = safeUrl(cell(row, 'link'));
      var description = cell(row, 'description');

      var inner = (logo
        ? '<img class="partner__logo" src="' + logo + '" alt="' + esc(name) + '" loading="lazy">'
        : '<span class="partner__name">' + esc(name) + '</span>') +
        (description ? '<span class="partner__desc">' + escMultiline(description) + '</span>' : '');

      return link
        ? '<a class="partner" href="' + link + '" target="_blank" rel="noopener">' + inner + '</a>'
        : '<div class="partner">' + inner + '</div>';
    }).join('');

    layoutGrid(host, items.length, 4);
    reveal('partners', items.length > 0);
  }

  function renderSocials(rows) {
    var host = q('[data-socials]');
    if (!host) return;

    var items = visibleRows(rows).filter(function (row) {
      return cell(row, 'name') && safeUrl(cell(row, 'link'));
    });

    host.innerHTML = items.map(function (row) {
      return '<li class="socials__item">' +
        '<a class="socials__link" href="' + safeUrl(cell(row, 'link')) + '" target="_blank" rel="noopener">' +
        esc(cell(row, 'name')) + '</a></li>';
    }).join('');

    host.hidden = items.length === 0;
  }

  function renderSignup(block) {
    var data = block || {};
    var steps = (Array.isArray(data.steps) ? data.steps : []).filter(function (step) {
      return step && typeof step === 'object' && (cell(step, 'title') || cell(step, 'text'));
    });
    var host = q('[data-steps]');
    var isVisible = data.show !== false && steps.length > 0;

    if (host) {
      host.innerHTML = steps.map(function (step, index) {
        var title = cell(step, 'title');
        var text = cell(step, 'text');
        return '<li class="step">' +
          '<span class="step__num" aria-hidden="true">' + (index + 1) + '</span>' +
          (title ? '<h3 class="step__title">' + esc(title) + '</h3>' : '') +
          (text ? '<p class="step__text">' + richText(text) + '</p>' : '') +
          '</li>';
      }).join('');
      layoutGrid(host, steps.length, 4);
    }

    var eyebrow = q('[data-signup-eyebrow]');
    if (eyebrow) {
      eyebrow.textContent = cell(data, 'eyebrow');
      eyebrow.hidden = !cell(data, 'eyebrow');
    }
    var title = q('[data-signup-title]');
    if (title && cell(data, 'title')) title.textContent = cell(data, 'title');

    // Кнопка «Записаться» в шапке ведёт к этому блоку, если он показан
    qa('[data-signup-cta]').forEach(function (node) {
      node.setAttribute('href', isVisible ? '#signup' : '#contacts');
    });

    reveal('signup', isVisible);
  }

  function renderFaq(rows) {
    var items = visibleRows(rows);
    var host = q('[data-faq]');
    if (!host) return;

    host.innerHTML = items.map(function (row) {
      return '<details class="qa">' +
        '<summary class="qa__q">' + esc(cell(row, 'question')) + '</summary>' +
        '<div class="qa__a">' + richText(cell(row, 'answer')) + '</div>' +
        '</details>';
    }).join('');

    reveal('faq', items.length > 0);
  }

  /* ---------- служебное ---------- */

  function createLoader() {
    var root = document.documentElement;
    var startedAt = Date.now();

    function hide() {
      root.className = root.className.replace(/\bis-loading\b/, '');
    }

    return {
      done: function () {
        if (root.className.indexOf('is-loading') === -1) return;
        var elapsed = Date.now() - startedAt;
        if (elapsed < 400) {
          setTimeout(hide, 400 - elapsed);
        } else {
          hide();
        }
      }
    };
  }

  function setYear() {
    var node = q('[data-year]');
    if (node) node.textContent = String(new Date().getFullYear());
  }

  function setupStickyCta() {
    var cta = q('[data-sticky-cta]');
    var hero = q('.hero');
    if (!cta || !hero) return;

    if (typeof IntersectionObserver !== 'function') {
      cta.classList.add('is-visible');
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        cta.classList.toggle('is-visible', !entry.isIntersecting);
      });
    }, { rootMargin: '-80px 0px 0px 0px' });

    observer.observe(hero);
  }

  function applyHash() {
    var hash = String(location.hash || '');
    if (hash.length < 2) return;

    var target = null;
    try {
      target = document.querySelector(hash);
    } catch (error) {
      return;
    }
    if (!target || target.hidden) return;

    var scroll = function () {
      try {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } catch (error) {
        target.scrollIntoView();
      }
    };

    var fonts = document.fonts;
    if (!fonts || !fonts.ready || typeof fonts.ready.then !== 'function') {
      scroll();
      return;
    }

    var done = false;
    var run = function () {
      if (done) return;
      done = true;
      scroll();
    };
    fonts.ready.then(run, run);
    setTimeout(run, 800);
  }

  function render(data) {
    var settings = toSettings(data.settings);
    applySettings(settings);

    var telegram = safeUrl(settings.group_telegram) || FALLBACK_TELEGRAM;
    var venueIndex = buildVenueIndex(data.venues);

    renderTrainings(data.trainings);
    renderSchedule(data.schedule, venueIndex);
    renderSignup(data.signup);
    renderVenues(venueIndex, data.schedule);
    renderPromos(data.promos, telegram);
    renderCoaches(data.coaches);
    renderTournaments(data.tournaments, venueIndex);
    renderPartners(data.partners);
    renderFaq(data.faq);
    renderSocials(data.socials);

    applyHash();
  }

  function start() {
    setYear();
    setupStickyCta();

    var loader = createLoader();

    loadContent().then(render).catch(function () {
      var empty = {};
      FILES.forEach(function (name) {
        empty[name] = isObjectFile(name) ? {} : [];
      });
      render(empty);
    }).then(loader.done, loader.done);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
