(function () {
  'use strict';

  // Всё содержимое сайта лежит в data.json. Его собирает tools/build-content.mjs
  // из папки content/, которую правит админка Pages CMS (настройка — .pages.yml).
  var DATA_URL = 'data.json';
  var TIMEOUT_MS = 8000;

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

  function str(value) {
    return value == null ? '' : String(value).trim();
  }

  function list(value) {
    return Array.isArray(value) ? value.filter(function (item) {
      return item && typeof item === 'object';
    }) : [];
  }

  function strings(value) {
    return Array.isArray(value) ? value.map(str).filter(Boolean) : [];
  }

  function isSafeUrl(value) {
    var raw = str(value);
    if (!raw || /^\/\//.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return false;
    if (/^(https?:|tel:|mailto:)/i.test(raw)) return true;
    return !/^[a-z][a-z0-9+.\-]*:/i.test(raw);
  }

  // Ссылка, готовая для атрибута href/src, или пустая строка
  function safeUrl(value) {
    return isSafeUrl(value) ? esc(str(value)) : '';
  }

  function isExternal(url) {
    return /^https?:/i.test(str(url));
  }

  function blank(url) {
    return isExternal(url) ? ' target="_blank" rel="noopener"' : '';
  }

  /* ---------- форматированный текст ----------
     HTML собирается из Markdown при сборке. Перед вставкой оставляем только
     разрешённые теги и безопасные ссылки — на случай, если в тексте окажется
     лишний HTML. */

  var ALLOWED_TAGS = {
    P: [], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], DEL: [],
    UL: ['class'], OL: ['start'], LI: [], A: ['href', 'class'],
    H3: [], H4: [], BLOCKQUOTE: [], CODE: []
  };
  var RENAME_TAGS = { H1: 'H3', H2: 'H3', H5: 'H4', H6: 'H4' };
  var DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|SVG|MATH|NOSCRIPT|TITLE|HEAD|FORM|INPUT|BUTTON|SELECT|TEXTAREA|IMG|VIDEO|AUDIO)$/;
  var ALLOWED_CLASSES = { 'link-accent': true, 'link-soft': true, 'levels-list': true };

  function unwrap(node) {
    var parent = node.parentNode;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  function cleanTree(root) {
    Array.prototype.slice.call(root.childNodes).forEach(function (node) {
      if (node.nodeType === 3) return;
      if (node.nodeType !== 1) {
        root.removeChild(node);
        return;
      }

      var tag = RENAME_TAGS[node.tagName] || node.tagName;
      if (DROP_TAGS.test(tag)) {
        root.removeChild(node);
        return;
      }
      if (!ALLOWED_TAGS[tag]) {
        cleanTree(node);
        unwrap(node);
        return;
      }

      var el = node;
      if (tag !== node.tagName) {
        el = document.createElement(tag);
        while (node.firstChild) el.appendChild(node.firstChild);
        root.replaceChild(el, node);
      }

      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        if (ALLOWED_TAGS[tag].indexOf(attr.name) === -1) el.removeAttribute(attr.name);
      });

      if (el.hasAttribute('class')) {
        var classes = el.getAttribute('class').split(/\s+/).filter(function (name) {
          return ALLOWED_CLASSES[name];
        });
        if (classes.length) el.setAttribute('class', classes.join(' '));
        else el.removeAttribute('class');
      }

      if (tag === 'A') {
        var href = el.getAttribute('href');
        if (!isSafeUrl(href)) {
          cleanTree(el);
          unwrap(el);
          return;
        }
        if (!el.hasAttribute('class')) el.setAttribute('class', 'link-accent');
        if (isExternal(href)) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
        }
      }

      cleanTree(el);
    });
  }

  function richHtml(html) {
    var source = str(html);
    if (!source) return '';
    var template = document.createElement('template');
    if (!('content' in template)) return esc(source.replace(/<[^>]*>/g, ' '));
    template.innerHTML = source;
    cleanTree(template.content);
    var box = document.createElement('div');
    box.appendChild(template.content);
    return box.innerHTML;
  }

  /* ---------- «показывать до» считается в браузере, в день просмотра ---------- */

  function isActual(item) {
    var until = str(item && item.until);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
    if (!match) return true;
    var end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return today.getTime() <= end.getTime();
  }

  /* ---------- загрузка ---------- */

  function loadData() {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    // no-cache: браузер сверяется с сервером, и правки из админки видны сразу
    // после публикации, а не через 10 минут кеша GitHub Pages
    var options = { cache: 'no-cache' };
    if (controller) options.signal = controller.signal;
    var timer;

    var request = fetch(DATA_URL, options).then(function (response) {
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
      return data && typeof data === 'object' ? data : {};
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  /* ---------- раскладка карточек ---------- */

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
    return items.some(function (item) { return safeUrl(item[field]); });
  }

  function media(prefix, url, alt, fill, srcset, sizes) {
    var src = safeUrl(url);
    if (src) {
      return '<div class="' + prefix + '__media"><img src="' + src + '"' +
        (str(srcset) ? ' srcset="' + esc(srcset) + '" sizes="' + esc(sizes || '100vw') + '"' : '') +
        ' alt="' + esc(alt) + '" loading="lazy" decoding="async"></div>';
    }
    if (fill) {
      return '<div class="' + prefix + '__media card-placeholder" aria-hidden="true">' +
        '<img src="assets/mark.png" alt="" loading="lazy"></div>';
    }
    return '';
  }

  function reveal(sectionId, isVisible) {
    var section = document.getElementById(sectionId);
    if (section) section.hidden = !isVisible;
    var link = q('[data-nav="' + sectionId + '"]');
    if (link) link.hidden = !isVisible;
  }

  function setText(selector, value) {
    var node = q(selector);
    if (node && str(value)) node.innerHTML = escMultiline(value);
  }

  function setLink(selector, url) {
    qa(selector).forEach(function (node) {
      if (safeUrl(url)) node.setAttribute('href', str(url));
      node.hidden = !safeUrl(url);
    });
  }

  /* ---------- общие контакты и тексты ---------- */

  // «Написать в {сеть}» → «Написать в Telegram»; без {сеть} название добавляется в конец
  function networkLabel(template, name) {
    var text = str(template);
    return text.indexOf('{сеть}') !== -1 ? text.split('{сеть}').join(name) : (text ? text + ' ' : '') + name;
  }

  function validNetworks(items) {
    return list(items).filter(function (n) { return str(n.title) && safeUrl(n.link); });
  }

  function applyContacts(contacts) {
    setLink('[data-phone-link]', contacts.phoneHref);
    qa('[data-phone-text]').forEach(function (node) {
      node.textContent = str(contacts.phone);
    });
  }

  // «Приходи играть»: кнопки групп и ссылки на соцсети — те, что выбраны в админке
  function renderFinalNetworks(final) {
    var groups = validNetworks(final.groups);
    var host = q('[data-group-buttons]');
    if (host) {
      host.innerHTML = groups.map(function (n) {
        return '<a class="btn btn--outline-dark" href="' + safeUrl(n.link) + '"' + blank(n.link) + '>' +
          esc(networkLabel(final.groupLabel || 'Группа в {сеть}', str(n.title))) + '</a>';
      }).join('');
    }
    qa('.final__tg').forEach(function (node) { node.hidden = groups.length === 0; });

    var links = validNetworks(final.links);
    var socials = q('[data-socials]');
    if (socials) {
      socials.innerHTML = links.map(function (n) {
        return '<li class="socials__item"><a class="socials__link" href="' + safeUrl(n.link) + '"' + blank(n.link) + '>' +
          esc(n.title) + '</a></li>';
      }).join('');
      socials.hidden = links.length === 0;
    }
  }

  function applyTexts(data) {
    var hero = data.hero || {};
    setText('[data-hero-heading]', hero.heading);
    // надпись над заголовком: пустое поле в админке — строки нет
    setText('[data-hero-slogan]', hero.slogan);
    var slogan = q('[data-hero-slogan]');
    if (slogan) slogan.hidden = !str(hero.slogan);
    setText('[data-hero-title]', hero.title);
    setText('[data-hero-text]', hero.text);

    var final = data.final || {};
    setText('[data-final-title]', final.title);
    setText('[data-final-text]', final.text);
    setText('[data-final-groups-text]', final.groupsText);
    renderFinalNetworks(final);

    // «О клубе» внизу блока контактов
    var about = q('[data-final-about]');
    if (about) {
      var aboutHtml = richHtml(final.aboutHtml);
      if (aboutHtml) about.querySelector('[data-final-about-text]').innerHTML = aboutHtml;
      about.hidden = !aboutHtml;
    }
  }

  /* ---------- блоки ---------- */

  function renderTrainings(items) {
    var host = q('[data-trainings]');
    if (!host) return;

    host.innerHTML = items.map(function (t) {
      var p = t.photo;
      var photo = p && safeUrl(p.src)
        ? '<div class="training__media"><img src="' + safeUrl(p.thumb) + '" srcset="' + esc(p.srcset) + '" ' +
          'sizes="(min-width: 860px) 33vw, 100vw" width="' + esc(p.width) + '" height="' + esc(p.height) + '" ' +
          'alt="' + esc(p.alt) + '" loading="lazy" decoding="async"></div>'
        : '';
      // цветная полоска под фото — тот же цвет, что у этой тренировки в расписании
      var color = /^(lime|white|blue|gray|dark)$/.test(str(t.color)) ? str(t.color) : 'dark';
      return '<article class="training training--' + color + (photo ? ' has-photo' : '') + '">' +
        photo +
        '<h3 class="training__title">' + esc(t.title) + '</h3>' +
        (str(t.html) ? '<div class="training__text rich">' + richHtml(t.html) + '</div>' : '') +
        (t.coachesLink
          ? '<p class="training__contact"><a class="link-accent" href="#coach">Написать тренеру →</a></p>'
          : '') +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('trainings', items.length > 0);
  }

  function formatPrice(value) {
    var n = Number(value);
    return value != null && value !== '' && isFinite(n) && n > 0 ? n + ' ₽' : '';
  }

  function levelBadges(levels) {
    if (!levels.length) return '<span class="level level--any">все уровни</span>';
    return levels.map(function (level) {
      var hint = str(level.description);
      return '<span class="level"' + (hint ? ' title="' + esc(level.title + ' — ' + hint) + '"' : '') + '>' +
        esc(level.title) + '</span>';
    }).join('');
  }

  /* ---------- расписание неделей ---------- */

  var WEEK = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  var WEEK_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  var CLUB_TZ = 'Europe/Saratov';

  // Сейчас в Саратове: дата, день недели (0 — понедельник … 6 — воскресенье) и минуты от полуночи
  function clubNow() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CLUB_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      var get = function (type) {
        var part = parts.filter(function (p) { return p.type === type; })[0];
        return part ? part.value : '';
      };
      return {
        y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
        minutes: Number(get('hour')) * 60 + Number(get('minute'))
      };
    } catch (e) {
      var n = new Date();
      return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate(), minutes: n.getHours() * 60 + n.getMinutes() };
    }
  }

  function toMinutes(time) {
    var m = /(\d{1,2})[:.](\d{2})/.exec(str(time));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function isoDate(utc) {
    return new Date(utc).toISOString().slice(0, 10);
  }

  // Уровни тренировки: только нужные; если не выбраны — «все уровни»
  function slotLevels(levels) {
    if (!levels.length) return '<span class="slot__levels"><span class="slot__lv slot__lv--any">все уровни</span></span>';
    return '<span class="slot__levels">' + levels.map(function (level) {
      var hint = str(level.description);
      return '<span class="slot__lv"' + (hint ? ' title="' + esc(level.title + ' — ' + hint) + '"' : '') + '>' +
        esc(level.title) + '</span>';
    }).join('') + '</span>';
  }

  var PIN_ICON = '<svg class="slot__pin" viewBox="0 0 12 16" width="10" height="13" aria-hidden="true"><path d="M6 0a6 6 0 0 0-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 0 0-6-6zm0 8.5A2.5 2.5 0 1 1 6 3.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>';

  // pos — место на шкале времени (минуты): top — от начала шкалы, dur — длительность,
  // lane/lanes — если в один день тренировки пересекаются, они стоят рядом
  function slotHtml(row, status, pos) {
    var type = row.type || null;
    var venue = row.venue || {};
    var times = str(row.time).split(/[–-]/);
    var start = str(times[0]);
    var end = str(times[1]);
    var price = formatPrice(row.price);
    var where = str(venue.short) || str(venue.title);
    var color = type && /^(lime|white|blue|gray|dark)$/.test(str(type.color)) ? str(type.color) : 'dark';
    pos = pos || { top: 0, dur: 90, lane: 0, lanes: 1 };
    var cls = 'slot slot--' + color + (pos.lanes > 1 ? ' slot--narrow' : '') +
      (status ? ' is-' + status.kind : '');
    var style = '--top:' + pos.top + ';--dur:' + pos.dur + (pos.lanes > 1 ? ';--lane:' + pos.lane + ';--lanes:' + pos.lanes : '');
    return '<article class="' + cls + '" style="' + style + '">' +
      (status ? '<span class="slot__status slot__status--' + status.kind + '">' + esc(status.text) + '</span>' : '') +
      // площадка — наверху карточки, ссылка на неё в «Где играем»
      (where ? (venue.anchor
        ? '<a class="slot__venue slot__venue--link" href="#' + esc(venue.anchor) + '">' + PIN_ICON + '<span>' + esc(where) + '</span></a>'
        : '<span class="slot__venue">' + PIN_ICON + '<span>' + esc(where) + '</span></span>') : '') +
      '<span class="slot__time">' + esc(start) + (end ? '<small>–' + esc(end) + '</small>' : '') + '</span>' +
      (type ? '<span class="slot__type">' + esc(type.title) + '</span>' : '') +
      // у персональных уровни не показываем (галочка у вида тренировки)
      (type && type.hideLevels ? '' : slotLevels(list(row.levels))) +
      (price ? '<span class="slot__price">' + esc(price) + '</span>' : '') +
      '</article>';
  }

  function rowSpan(row) {
    var t = str(row.time).split(/[–-]/);
    var a = toMinutes(t[0]);
    var b = toMinutes(t[1]);
    if (a == null) return null;
    return { from: a, to: b != null && b > a ? b : a + 90 };
  }

  // Расписание — неделя пн–вс. На компьютере — как календарь: слева общая шкала времени,
  // плитка стоит на своём времени начала, высота — по длительности. На телефоне — список дней.
  // В браузере помечаем сегодняшний день (по саратовскому времени)
  // и зачёркиваем тренировки этой недели, отменённые в админке.
  function renderSchedule(items, cancellations) {
    var host = q('[data-schedule]');
    if (!host) return;
    cancellations = Array.isArray(cancellations) ? cancellations : [];

    var byWeekday = WEEK.map(function () { return []; });
    items.forEach(function (row) {
      var d = WEEK.indexOf(str(row.dayShort).toLowerCase());
      if (d >= 0) byWeekday[d].push(row);
    });

    // шкала — от самого раннего начала до самого позднего конца, целыми часами
    var first = 24 * 60;
    var last = 0;
    items.forEach(function (row) {
      var span = rowSpan(row);
      if (!span) return;
      first = Math.min(first, span.from);
      last = Math.max(last, span.to);
    });
    var fromH = Math.floor(first / 60);
    var toH = Math.ceil(last / 60);
    if (!(toH > fromH)) { fromH = 18; toH = 22; }
    var hours = toH - fromH;

    var inBrowser = typeof window.matchMedia === 'function';
    var today = -1;
    var monday = 0;
    if (inBrowser) {
      var now = clubNow();
      var base = Date.UTC(now.y, now.m - 1, now.d);
      today = (new Date(base).getUTCDay() + 6) % 7;
      monday = base - today * 86400000;
    }

    var axis = '<div class="week__axis" aria-hidden="true">';
    for (var h = 0; h <= hours; h += 1) {
      axis += '<span style="--i:' + h + '">' + (fromH + h) + ':00</span>';
    }
    axis += '</div>';

    host.setAttribute('style', '--hours:' + hours);
    host.innerHTML = axis + byWeekday.map(function (rows, d) {
      var iso = inBrowser ? isoDate(monday + d * 86400000) : '';

      // пересекающиеся тренировки одного дня ставим рядом (как в календаре)
      var pos = [];
      var laneEnds = [];
      var group = [];
      var groupEnd = -1;
      var closeGroup = function () {
        group.forEach(function (p) { p.lanes = laneEnds.length; });
        laneEnds = [];
        group = [];
      };
      rows.forEach(function (row, i) {
        var span = rowSpan(row) || { from: fromH * 60, to: fromH * 60 + 90 };
        if (span.from >= groupEnd) closeGroup();
        var lane = 0;
        while (lane < laneEnds.length && laneEnds[lane] > span.from) lane += 1;
        laneEnds[lane] = span.to;
        pos[i] = { top: span.from - fromH * 60, dur: span.to - span.from, lane: lane, lanes: 1 };
        group.push(pos[i]);
        groupEnd = Math.max(groupEnd, span.to);
      });
      closeGroup();

      var slots = rows.map(function (row, i) {
        var start = toMinutes(str(row.time).split(/[–-]/)[0]);
        var off = iso && cancellations.filter(function (c) {
          return c.date === iso && (c.start == null || c.start === start);
        })[0];
        return slotHtml(row, off ? { kind: 'off', text: 'отменена' + (str(off.reason) ? ' · ' + str(off.reason) : '') } : null, pos[i]);
      }).join('');
      return '<div class="week__day' + (rows.length ? '' : ' is-empty') + (d === today ? ' is-today' : '') + '">' +
        '<div class="week__head">' +
          '<span class="week__name"><span class="week__short">' + WEEK[d] + '</span><span class="week__full">' + WEEK_FULL[d] + '</span></span>' +
          '<span class="week__today">сегодня</span>' +
        '</div>' +
        '<div class="week__track">' + slots + '</div>' +
        '</div>';
    }).join('');

    reveal('schedule', items.length > 0);
    if (inBrowser) setupWeekScroll(host, today);
  }

  // Неделя не помещается по ширине (телефон) — листается вбок: стрелки под календарём,
  // затемнение у края, за которым есть ещё дни, и сразу виден сегодняшний день.
  // Пальцем листаем сами, с инерцией: быстрый свайп долистывает до конца, медленный —
  // до ближайшего дня; так одинаково на всех телефонах (и в эмуляторе браузера).
  function setupWeekScroll(host, today) {
    var wrap = host.closest('[data-week-wrap]') || host.parentNode;
    var nav = q('[data-week-nav]');
    var prev = q('[data-week-prev]');
    var next = q('[data-week-next]');
    var days = host.querySelectorAll('.week__day');
    var axis = host.querySelector('.week__axis');
    var frame = 0;
    var anim = 0;
    var state = '';
    var drag = null;
    var swallowClick = false;

    function dayWidth() {
      return days[0] ? days[0].getBoundingClientRect().width : 112;
    }
    function maxLeft() {
      return Math.max(0, host.scrollWidth - host.clientWidth);
    }
    // ближайшее начало дня; у самого конца — до конца, чтобы воскресенье было видно целиком
    function snap(x) {
      var dw = dayWidth();
      var max = maxLeft();
      var t = Math.round(x / dw) * dw;
      if (t > max - dw / 2) t = max;
      return Math.min(max, Math.max(0, t));
    }
    // плавная прокрутка, к концу замедляется
    function glide(target, duration) {
      cancelAnimationFrame(anim);
      var from = host.scrollLeft;
      var dist = target - from;
      if (Math.abs(dist) < 1) return;
      var t0 = 0;
      anim = requestAnimationFrame(function step(now) {
        if (!t0) t0 = now;
        var k = Math.min(1, (now - t0) / duration);
        host.scrollLeft = from + dist * (1 - Math.pow(1 - k, 3));
        if (k < 1) anim = requestAnimationFrame(step);
      });
    }
    // стрелка листает на столько дней, сколько видно целиком
    function page(dir) {
      var dw = dayWidth();
      var visible = host.clientWidth - (axis ? axis.offsetWidth : 0);
      var step = Math.max(1, Math.floor(visible / dw));
      glide(snap((Math.round(host.scrollLeft / dw) + dir * step) * dw), 420);
    }
    // классы и стрелки обновляем не чаще раза за кадр и только когда что-то поменялось
    function update() {
      frame = 0;
      var max = maxLeft();
      var scrollable = max > 1;
      var left = scrollable && host.scrollLeft > 1;
      var right = scrollable && host.scrollLeft < max - 1;
      var now = [scrollable, left, right].join();
      if (now === state) return;
      state = now;
      if (nav) nav.hidden = !scrollable;
      wrap.classList.toggle('can-left', left);
      wrap.classList.toggle('can-right', right);
      if (prev) prev.disabled = !left;
      if (next) next.disabled = !right;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    function onDown(event) {
      if (event.pointerType !== 'touch' || maxLeft() < 1) return;
      cancelAnimationFrame(anim);
      drag = { id: event.pointerId, x: event.clientX, left: host.scrollLeft, moved: false,
        track: [{ t: event.timeStamp, x: event.clientX }] };
    }
    function onMove(event) {
      if (!drag || event.pointerId !== drag.id) return;
      var dx = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 5) return;
        drag.moved = true;
        if (host.setPointerCapture) host.setPointerCapture(event.pointerId);
      }
      host.scrollLeft = drag.left - dx;
      drag.track.push({ t: event.timeStamp, x: event.clientX });
      if (drag.track.length > 6) drag.track.shift();
    }
    function onUp(event) {
      if (!drag || event.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      if (!d.moved) return;
      swallowClick = true;
      setTimeout(function () { swallowClick = false; }, 60);
      // скорость пальца за последние ~100 мс → куда докатится по инерции
      var last = d.track[d.track.length - 1];
      var first = d.track[0];
      for (var i = d.track.length - 1; i >= 0 && last.t - d.track[i].t <= 100; i -= 1) first = d.track[i];
      var v = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;   // px/мс
      if (event.timeStamp - last.t > 120) v = 0;                                // палец остановили
      var target = snap(host.scrollLeft - v * 600);   // чем быстрее свайп, тем дальше докатится
      glide(target, Math.min(750, Math.max(280, Math.abs(target - host.scrollLeft) * 1.3)));
    }
    function onCancel(event) {
      if (!drag || event.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      if (moved) glide(snap(host.scrollLeft), 300);
    }

    if (today > 0 && days[today] && host.scrollWidth > host.clientWidth + 1) {
      host.scrollLeft = snap(days[today].offsetLeft - (axis ? axis.offsetWidth : 0));
    }
    if (!host.dataset.scrollReady) {
      host.dataset.scrollReady = '1';
      host.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      host.addEventListener('pointerdown', onDown);
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerup', onUp);
      host.addEventListener('pointercancel', onCancel);
      // после свайпа не открываем ссылку под пальцем (площадка на плитке)
      host.addEventListener('click', function (event) {
        if (swallowClick) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      if (prev) prev.addEventListener('click', function () { page(-1); });
      if (next) next.addEventListener('click', function () { page(1); });
    }
    update();
  }



  // Запись под расписанием: шаги и кнопка
  function renderSignup(block) {
    var data = block || {};
    var steps = list(data.steps);
    var isVisible = data.show !== false;

    var host = q('[data-steps]');
    if (host) {
      host.innerHTML = steps.map(function (step, index) {
        return '<li class="signup__step">' +
          '<span class="signup__num" aria-hidden="true">' + (index + 1) + '</span>' +
          '<div>' +
            (str(step.title) ? '<h3 class="signup__step-title">' + esc(step.title) + '</h3>' : '') +
            (str(step.html) ? '<div class="signup__step-text rich">' + richHtml(step.html) + '</div>' : '') +
          '</div>' +
          '</li>';
      }).join('');
      host.hidden = !steps.length;
    }

    qa('[data-signup-label]').forEach(function (node) {
      if (str(data.buttonLabel)) node.textContent = str(data.buttonLabel);
    });
    setText('[data-sheet-title]', data.sheetTitle);
    setText('[data-sheet-text]', data.sheetText);

    // Без JS кнопки «Записаться» ведут к записи под расписанием, если она показана, иначе к контактам
    qa('a[data-open-signup]').forEach(function (node) {
      node.setAttribute('href', isVisible ? '#signup' : '#contacts');
    });

    reveal('signup', isVisible);
  }

  // Фото площадки — сетка во всю ширину экрана: большое фото и четыре поменьше
  // (на телефоне — большое и два). Если у площадки есть точка на карте, одна из
  // маленьких клеток — карта. Остальные фото открываются в просмотрщике:
  // на последней видимой плитке «+N». Это обычные ссылки на большие фото —
  // без JS они просто откроются, с JS — в просмотрщике (см. gallery ниже).
  var TILES_WIDE = 5;
  var TILES_PHONE = 3;
  var TILES_WIDE_MAP = 4;    // с картой: большое фото, три поменьше и карта
  var TILES_PHONE_MAP = 2;   // на телефоне: большое фото, одно поменьше и карта

  // Карта площадки: плитки OpenStreetMap с точкой в центре (без рекламы
  // и без ключей). Сама карта не двигается, чтобы не мешала листать страницу;
  // нажатие открывает Яндекс Карты — там и маршрут. Плитки рисует maps ниже.
  function venueMapTile(v) {
    var geo = v.geo || {};
    var lat = Number(geo.lat);
    var lon = Number(geo.lon);
    if (!geo.lat || !geo.lon || !isFinite(lat) || !isFinite(lon)) return '';
    var link = safeUrl(v.map);
    return '<div class="venue__tile venue__tile--map" data-map-lat="' + lat + '" data-map-lon="' + lon + '">' +
      '<div class="venue__map-tiles" aria-hidden="true"></div>' +
      '<span class="venue__map-pin" aria-hidden="true"></span>' +
      (link ? '<a class="venue__map-open" href="' + link + '" target="_blank" rel="noopener" ' +
        'aria-label="Как добраться: ' + esc(v.title) + ' — открыть Яндекс Карты"><span>Как добраться ↗</span></a>' : '') +
      '<a class="venue__map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>' +
      '</div>';
  }

  var maps = {
    ZOOM: 15,   // в маленькой клетке видно соседние улицы — сразу понятно, что это карта
    TILE: 256,
    timer: 0,

    // какие плитки OpenStreetMap нужны, чтобы точка была ровно в центре
    draw: function () {
      var z = this.ZOOM;
      var size = this.TILE;
      qa('[data-map-lat]').forEach(function (tile) {
        var box = tile.querySelector('.venue__map-tiles');
        var w = tile.clientWidth;
        var h = tile.clientHeight;
        if (!box || !w || !h) return;
        var key = w + 'x' + h;
        if (box.getAttribute('data-size') === key) return;

        var lat = Number(tile.getAttribute('data-map-lat')) * Math.PI / 180;
        var lon = Number(tile.getAttribute('data-map-lon'));
        var world = Math.pow(2, z) * size;
        var left = (lon + 180) / 360 * world - w / 2;
        var top = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * world - h / 2;

        var html = '';
        for (var ty = Math.floor(top / size); ty <= Math.floor((top + h) / size); ty += 1) {
          for (var tx = Math.floor(left / size); tx <= Math.floor((left + w) / size); tx += 1) {
            html += '<img src="https://tile.openstreetmap.org/' + z + '/' + tx + '/' + ty + '.png" alt="" ' +
              'width="' + size + '" height="' + size + '" loading="lazy" decoding="async" ' +
              'style="left:' + Math.round(tx * size - left) + 'px;top:' + Math.round(ty * size - top) + 'px">';
          }
        }
        box.innerHTML = html;
        box.setAttribute('data-size', key);
      });
    },

    setup: function () {
      var self = this;
      window.addEventListener('resize', function () {
        clearTimeout(self.timer);
        self.timer = setTimeout(function () { self.draw(); }, 150);
      });
    }
  };

  function venuePhotos(v) {
    var photos = list(v.photos).filter(function (p) { return safeUrl(p.src) && safeUrl(p.full); });
    var mapTile = venueMapTile(v);
    if (!photos.length && !mapTile) return '';
    var gallery = esc(v.anchor);
    var total = photos.length;
    var wide = mapTile ? TILES_WIDE_MAP : TILES_WIDE;
    var phone = mapTile ? TILES_PHONE_MAP : TILES_PHONE;

    var tiles = photos.map(function (p, index) {
      var moreWide = index === wide - 1 && total > wide ? total - wide : 0;
      var morePhone = index === phone - 1 && total > phone ? total - phone : 0;
      var sizes = index === 0 ? '(min-width: 860px) 50vw, 100vw' : '(min-width: 860px) 34vw, 50vw';
      return '<a class="venue__tile" href="' + safeUrl(p.full) + '" data-gallery="' + gallery + '" data-index="' + index + '">' +
        '<img src="' + safeUrl(p.src) + '" srcset="' + esc(p.srcset) + '" sizes="' + sizes + '" ' +
          'width="' + esc(p.width) + '" height="' + esc(p.height) + '" ' +
          'alt="' + esc(p.alt) + '" loading="lazy" decoding="async">' +
        (moreWide ? '<span class="venue__more venue__more--wide">+' + moreWide + '</span>' : '') +
        (morePhone ? '<span class="venue__more venue__more--phone">+' + morePhone + '</span>' : '') +
        '</a>';
    }).join('');

    return '<div class="venue__mosaic' + (mapTile ? ' has-map' : '') + '" data-count="' + Math.min(total, wide) + '">' +
      tiles + mapTile + '</div>';
  }

  function renderVenues(items) {
    var host = q('[data-venues]');
    if (!host) return;

    host.innerHTML = items.map(function (v) {
      var map = safeUrl(v.map);
      var photos = venuePhotos(v);
      // если есть карта в сетке, отдельная ссылка «Показать на карте» не нужна
      var hasMapTile = Boolean(venueMapTile(v));
      var days = strings(v.days).map(function (day) {
        return '<span class="day-chip">' + esc(day) + '</span>';
      }).join('');
      return '<article class="venue' + (photos ? ' has-photos' : '') + '" id="' + esc(v.anchor) + '">' +
        '<div class="wrap venue__head">' +
          '<div class="venue__info">' +
            '<h3 class="venue__title">' + esc(v.title) + '</h3>' +
            (str(v.address) ? '<p class="venue__address">' + escMultiline(v.address) + '</p>' : '') +
          '</div>' +
          '<div class="venue__foot">' +
            (days ? '<p class="venue__days">' + days + '</p>' : '') +
            (map && !hasMapTile ? '<a class="venue__map" href="' + map + '" target="_blank" rel="noopener">Показать на карте</a>' : '') +
          '</div>' +
        '</div>' +
        photos +
        '</article>';
    }).join('');

    reveal('venues', items.length > 0);
    gallery.collect(items);
    maps.draw();
  }

  /* ---------- лента фото под первым экраном ----------
     Лента медленно едет сама по кругу (в конце незаметно начинается сначала — для этого
     в браузере добавляются копии фото). Останавливается, пока на ней мышка, палец или
     фокус, и на несколько секунд после того, как человек листал сам. Если в системе
     включено «уменьшить движение» — стоит на месте, листается пальцем и стрелками. */

  var STRIP_SPEED = 28;        // пикселей в секунду
  var STRIP_RESUME_MS = 3500;  // через сколько продолжить после ручного листания
  var STRIP_MAX = 18;          // сколько фото в ленте (каждый раз случайные)

  function stripItem(p, index, clone) {
    return '<a class="strip__item' + (clone ? ' is-clone' : '') + '" href="' + safeUrl(p.full) + '" data-gallery="strip" data-index="' + index + '"' +
      (clone ? ' aria-hidden="true" tabindex="-1"' : '') + '>' +
      '<img src="' + safeUrl(p.thumb) + '" srcset="' + esc(p.srcset) + '" sizes="(min-width: 860px) 390px, 270px" ' +
      'width="' + esc(p.width) + '" height="' + esc(p.height) + '" alt="' + (clone ? '' : esc(p.alt)) + '" loading="lazy" decoding="async">' +
      '</a>';
  }

  // Лента каждый раз в новом порядке
  function shuffle(items) {
    var out = items.slice();
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  function renderStrip(block) {
    var host = q('[data-strip]');
    if (!host) return;
    // каждый раз в новом порядке и не больше STRIP_MAX — фото площадок много, страница не должна тяжелеть
    var photos = shuffle(list(block && block.photos).filter(function (p) { return safeUrl(p.src) && safeUrl(p.full); }))
      .slice(0, STRIP_MAX);

    host.innerHTML = photos.map(function (p, index) { return stripItem(p, index, false); }).join('');

    gallery.add('strip', 'С тренировок клуба', photos);
    reveal('photos', photos.length > 0);
    strip.start(photos);
  }

  var strip = {
    track: null,
    auto: false,
    loopWidth: 0,
    pos: 0,
    last: 0,
    anim: null,
    hold: { hover: false, touch: false, focus: false, offscreen: false },
    userUntil: 0,
    frame: 0,

    canAnimate: function () {
      return typeof window.matchMedia === 'function' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
        typeof requestAnimationFrame === 'function';
    },

    // запуск после того, как фото нарисованы
    start: function (photos) {
      var track = this.track;
      if (!track) return;
      this.auto = photos.length >= 3 && this.canAnimate();
      if (this.auto) {
        // копии для бесконечного круга — только в браузере, в HTML для поисковиков их нет
        track.insertAdjacentHTML('beforeend', photos.map(function (p, index) { return stripItem(p, index, true); }).join(''));
        track.parentNode.classList.add('is-auto');
        this.measure();
        this.pos = track.scrollLeft;
        this.last = 0;
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(this.tick.bind(this));
      }
      this.updateButtons();
    },

    measure: function () {
      var first = this.track.querySelector('.strip__item');
      var clone = this.track.querySelector('.strip__item.is-clone');
      this.loopWidth = first && clone ? clone.offsetLeft - first.offsetLeft : 0;
    },

    paused: function (now) {
      var h = this.hold;
      return h.hover || h.touch || h.focus || h.offscreen || document.hidden || now < this.userUntil;
    },

    tick: function (now) {
      var track = this.track;
      var dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
      this.last = now;

      // человек листал сам (пальцем, тачпадом) — подхватываем его положение и ждём
      if (!this.anim && Math.abs(track.scrollLeft - this.pos) > 2) {
        this.pos = track.scrollLeft;
        this.userUntil = now + STRIP_RESUME_MS;
      }

      if (this.anim) {
        var a = this.anim;
        var t = Math.min((now - a.start) / a.duration, 1);
        var eased = 1 - Math.pow(1 - t, 3);
        this.pos = a.from + (a.to - a.from) * eased;
        if (t >= 1) this.anim = null;
      } else if (!this.paused(now)) {
        this.pos += STRIP_SPEED * dt;
      }

      // круг: дошли до копий — незаметно перескакиваем к началу (и наоборот)
      var w = this.loopWidth;
      if (w > 0) {
        var shift = this.pos >= w ? -w : (this.pos < 0 ? w : 0);
        if (shift) {
          this.pos += shift;
          if (this.anim) { this.anim.from += shift; this.anim.to += shift; }
        }
      }
      track.scrollLeft = this.pos;
      this.frame = requestAnimationFrame(this.tick.bind(this));
    },

    // стрелки: плавно на ~80% ширины экрана
    step: function (direction) {
      var track = this.track;
      var distance = direction * track.clientWidth * 0.8;
      if (!this.auto) {
        track.scrollBy({ left: distance, behavior: 'smooth' });
        return;
      }
      var now = performance.now();
      var from = this.anim ? this.anim.to : this.pos;
      this.anim = { from: this.pos, to: from + distance, start: now, duration: 600 };
      this.userUntil = now + STRIP_RESUME_MS;
    },

    // без автопрокрутки стрелки видны, только если есть куда листать; по кругу — всегда
    updateButtons: function () {
      var track = this.track;
      if (!track) return;
      var prev = q('[data-strip-prev]');
      var next = q('[data-strip-next]');
      var max = track.scrollWidth - track.clientWidth;
      if (prev) prev.hidden = !this.auto && track.scrollLeft <= 4;
      if (next) next.hidden = !this.auto && track.scrollLeft >= max - 4;
    },

    setup: function () {
      var self = this;
      var track = self.track = q('[data-strip]');
      if (!track) return;
      var root = track.parentNode;

      var prev = q('[data-strip-prev]');
      var next = q('[data-strip-next]');
      if (prev) prev.addEventListener('click', function () { self.step(-1); });
      if (next) next.addEventListener('click', function () { self.step(1); });

      root.addEventListener('mouseenter', function () { self.hold.hover = true; });
      root.addEventListener('mouseleave', function () { self.hold.hover = false; });
      track.addEventListener('touchstart', function () { self.hold.touch = true; }, { passive: true });
      track.addEventListener('touchend', function () {
        self.hold.touch = false;
        self.userUntil = performance.now() + STRIP_RESUME_MS;
      });
      root.addEventListener('focusin', function () { self.hold.focus = true; });
      root.addEventListener('focusout', function () { self.hold.focus = false; });

      // за экраном лента не крутится — не тратим батарею
      if (typeof IntersectionObserver === 'function') {
        new IntersectionObserver(function (entries) {
          self.hold.offscreen = !entries[0].isIntersecting;
        }).observe(root);
      }

      var pending = false;
      track.addEventListener('scroll', function () {
        if (self.auto || pending) return;
        pending = true;
        requestAnimationFrame(function () { pending = false; self.updateButtons(); });
      }, { passive: true });
      window.addEventListener('resize', function () {
        if (self.auto) self.measure();
        self.updateButtons();
      });
    }
  };

  /* ---------- просмотр фото на весь экран ---------- */

  /* Просмотр фото на весь экран. Два состояния: все фото маленькими плитками
     (открывается с плитки «+N» в сетке площадки или кнопкой в углу) и по одному —
     как карусель: стрелки, свайп, клавиши ← →. С любой плитки — сразу это фото. */
  var gallery = {
    root: null,
    sets: {},
    current: null,
    index: 0,
    mode: 'photo',
    lastFocus: null,

    add: function (name, title, photos) {
      var good = list(photos).filter(function (p) { return safeUrl(p.full); });
      if (good.length) this.sets[name] = { title: str(title), photos: good };
      else delete this.sets[name];
    },

    collect: function (venues) {
      list(venues).forEach(function (v) {
        this.add(v.anchor, v.short || v.title, v.photos);
      }, this);
    },

    // все фото набора — маленькими плитками
    renderGrid: function () {
      var set = this.sets[this.current];
      var grid = this.root.querySelector('[data-lightbox-grid]');
      if (!set || !grid || grid.getAttribute('data-set') === this.current) return;
      grid.innerHTML = set.photos.map(function (p, i) {
        return '<button class="lightbox__thumb" type="button" data-lightbox-thumb="' + i + '" aria-label="Фото ' + (i + 1) + '">' +
          '<img src="' + safeUrl(p.thumb || p.src) + '" srcset="' + esc(p.srcset) + '" sizes="(min-width: 860px) 200px, 34vw" ' +
          'alt="" loading="lazy" decoding="async"></button>';
      }).join('');
      grid.setAttribute('data-set', this.current);
    },

    setMode: function (mode) {
      var set = this.sets[this.current];
      this.mode = mode;
      this.root.classList.toggle('is-grid', mode === 'grid');
      this.root.classList.toggle('is-photo', mode === 'photo');
      var title = this.root.querySelector('.lightbox__title');
      if (mode === 'grid') {
        this.renderGrid();
        title.textContent = set ? set.title + ' · ' + set.photos.length + ' фото' : '';
        var img = this.root.querySelector('.lightbox__img');
        img.removeAttribute('src');
        // плитка фото, которое только что смотрели, — в поле зрения
        var thumb = this.root.querySelector('[data-lightbox-thumb="' + this.index + '"]');
        if (thumb && thumb.scrollIntoView) thumb.scrollIntoView({ block: 'nearest' });
      } else {
        title.textContent = '';
      }
    },

    show: function (index) {
      var set = this.sets[this.current];
      if (!set) return;
      var count = set.photos.length;
      this.index = (index + count) % count;
      var photo = set.photos[this.index];
      var img = this.root.querySelector('.lightbox__img');
      img.src = photo.full;
      img.alt = photo.alt || '';
      this.root.querySelector('.lightbox__caption').textContent =
        set.title + ' · ' + (this.index + 1) + ' из ' + count;
      var single = count < 2;
      qa('.lightbox__nav').forEach(function (b) { b.hidden = single; });
      this.root.querySelector('.lightbox__all').hidden = single;
      // заранее подгружаем соседние фото, чтобы листалось без пауз
      [1, -1].forEach(function (step) {
        var next = set.photos[(this.index + step + count) % count];
        if (next) new Image().src = next.full;
      }, this);
      if (this.mode !== 'photo') this.setMode('photo');
    },

    open: function (name, index, mode) {
      if (!this.root || !this.sets[name]) return false;
      this.current = name;
      this.lastFocus = document.activeElement;
      this.root.hidden = false;
      document.documentElement.classList.add('is-locked');
      this.index = index || 0;
      if (mode === 'grid' && this.sets[name].photos.length > 1) {
        this.setMode('grid');
        var grid = this.root.querySelector('[data-lightbox-grid]');
        if (grid) grid.scrollTop = 0;
      } else {
        this.mode = '';
        this.show(this.index);
      }
      var close = this.root.querySelector('.lightbox__close');
      if (close) close.focus({ preventScroll: true });
      return true;
    },

    close: function () {
      if (!this.root || this.root.hidden) return;
      this.root.hidden = true;
      this.root.querySelector('.lightbox__img').removeAttribute('src');
      document.documentElement.classList.remove('is-locked');
      if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus({ preventScroll: true });
    },

    setup: function () {
      var self = this;
      self.root = q('[data-lightbox]');
      if (!self.root) return;

      document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var link = target.closest('[data-gallery]');
        if (link) {
          // плитка «+N» в сетке площадки открывает все фото плитками
          var more = Array.prototype.slice.call(link.querySelectorAll('.venue__more')).filter(function (m) { return getComputedStyle(m).display !== 'none'; })[0];
          if (self.open(link.getAttribute('data-gallery'), Number(link.getAttribute('data-index')) || 0, more ? 'grid' : 'photo')) {
            event.preventDefault();
          }
          return;
        }
        if (self.root.hidden) return;
        var thumb = target.closest('[data-lightbox-thumb]');
        if (thumb) self.show(Number(thumb.getAttribute('data-lightbox-thumb')) || 0);
        else if (target.closest('[data-lightbox-all]')) self.setMode('grid');
        else if (target.closest('[data-lightbox-prev]')) self.show(self.index - 1);
        else if (target.closest('[data-lightbox-next]')) self.show(self.index + 1);
        else if (target.closest('[data-lightbox-close]')) self.close();
        else if (self.mode === 'photo' && !target.closest('.lightbox__figure, .lightbox__bar')) self.close();
      });

      document.addEventListener('keydown', function (event) {
        if (self.root.hidden) return;
        if (event.key === 'Escape') self.close();
        else if (self.mode !== 'photo') return;
        else if (event.key === 'ArrowLeft') self.show(self.index - 1);
        else if (event.key === 'ArrowRight') self.show(self.index + 1);
      });

      // свайп влево/вправо на телефоне — только когда смотрим по одному
      var startX = null;
      self.root.addEventListener('touchstart', function (event) {
        startX = self.mode === 'photo' && event.touches.length === 1 ? event.touches[0].clientX : null;
      }, { passive: true });
      self.root.addEventListener('touchend', function (event) {
        if (startX === null) return;
        var dx = event.changedTouches[0].clientX - startX;
        startX = null;
        if (Math.abs(dx) > 50) self.show(self.index + (dx < 0 ? 1 : -1));
      });
    }
  };


  function renderCoaches(items) {
    var host = q('[data-coaches]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'photo');

    host.innerHTML = items.map(function (c) {
      var telegram = safeUrl(c.telegram);
      var hasMedia = safeUrl(c.photo) || fill;
      return '<article class="coach' + (hasMedia ? '' : ' is-textonly') + '">' +
        media('coach', c.photo, c.photoAlt || c.title, fill, c.photoSrcset, '(min-width: 860px) 340px, 280px') +
        '<div class="coach__body">' +
          '<h3 class="coach__name">' + esc(c.title) + '</h3>' +
          (str(c.html) ? '<div class="coach__about rich">' + richHtml(c.html) + '</div>' : '') +
          (telegram ? '<a class="link-accent" href="' + telegram + '"' + blank(c.telegram) + '>Написать в Telegram</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    var title = q('[data-coach-title]');
    if (title) title.textContent = items.length > 1 ? 'Тренеры' : 'Тренер';

    layoutGrid(host, items.length, 3);
    reveal('coach', items.length > 0);
  }

  // Акции и турниры — одинаковые карточки: картинка, заголовок, когда/где, текст, кнопка
  function renderCards(prefix, items, sectionId) {
    var host = q('[data-' + sectionId + ']');
    if (!host) return;
    var fill = needsPlaceholder(items, 'image');
    var buttonClass = prefix === 'promo' ? 'btn--accent' : 'btn--ghost';

    host.innerHTML = items.map(function (c) {
      var link = safeUrl(c.buttonLink);
      var hasMedia = safeUrl(c.image) || fill;
      var place = '';
      if (str(c.place)) {
        place = c.placeAnchor
          ? '<a class="card__where row__venue-link" href="#' + esc(c.placeAnchor) + '">' + esc(c.place) + '</a>'
          : '<span class="card__where">' + esc(c.place) + '</span>';
      }
      return '<article class="' + prefix + (hasMedia ? '' : ' is-textonly') + '">' +
        media(prefix, c.image, c.title, fill) +
        '<div class="' + prefix + '__body">' +
          '<h3 class="' + prefix + '__title">' + escMultiline(c.title) + '</h3>' +
          ((str(c.when) || place) ? '<p class="card__when">' + esc(c.when) + place + '</p>' : '') +
          (str(c.html) ? '<div class="' + prefix + '__text rich">' + richHtml(c.html) + '</div>' : '') +
          (str(c.buttonLabel)
            ? (link
              ? '<a class="btn ' + buttonClass + '" href="' + link + '"' + blank(c.buttonLink) + '>' + esc(c.buttonLabel) + '</a>'
              // без своей ссылки кнопка открывает окно «Записаться»
              : '<a class="btn ' + buttonClass + '" href="#signup" data-open-signup>' + esc(c.buttonLabel) + '</a>')
            : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal(sectionId, items.length > 0);
  }

  function renderPromos(all) {
    renderCards('promo', all.filter(isActual), 'promos');
  }

  function renderTournaments(all) {
    renderCards('tournament', all.filter(isActual), 'tournaments');
  }

  // «https://www.badm-store.ru/» → «badm-store.ru»
  function linkHost(url) {
    return str(url).replace(/^[a-z]+:(\/\/)?/i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '') || 'Перейти';
  }

  function renderPartners(items) {
    var host = q('[data-partners]');
    if (!host) return;

    host.innerHTML = items.map(function (p) {
      var logo = safeUrl(p.logo);
      var link = safeUrl(p.link);
      var brand = logo
        ? '<img class="partner__logo" src="' + logo + '" alt="' + esc(p.title) + '" loading="lazy">'
        : '<span class="partner__name">' + esc(p.title) + '</span>';
      var label = str(p.linkLabel) || linkHost(link);

      return '<div class="partner">' +
        (link ? '<a class="partner__brand" href="' + link + '"' + blank(link) + '>' + brand + '</a>'
          : '<div class="partner__brand">' + brand + '</div>') +
        (str(p.html) ? '<div class="partner__desc rich">' + richHtml(p.html) + '</div>' : '') +
        (link ? '<a class="partner__link link-accent" href="' + link + '"' + blank(link) + '>' + esc(label) + ' ↗</a>' : '') +
        '</div>';
    }).join('');

    layoutGrid(host, items.length, 4);
    reveal('partners', items.length > 0);
  }

  function renderFaq(items) {
    var host = q('[data-faq]');
    if (!host) return;

    host.innerHTML = items.map(function (item) {
      return '<details class="qa">' +
        '<summary class="qa__q">' + esc(item.question) + '</summary>' +
        '<div class="qa__a rich">' + richHtml(item.html) + '</div>' +
        '</details>';
    }).join('');

    reveal('faq', items.length > 0);
  }

  /* ---------- окно «Записаться» ---------- */

  var sheet = {
    root: null,
    lastFocus: null,
    hasActions: false,

    // Кнопки окна: сети с отметкой «Для записи» (главная первой) и телефон
    fill: function (contacts, texts) {
      var host = q('[data-sheet-actions]');
      if (!host) return;
      var label = str(texts.sheetNetworkLabel) || 'Написать в {сеть}';
      var phoneLabel = str(texts.sheetPhoneLabel) || 'Позвонить';

      // соцсети, выбранные для окна, в выбранном порядке; первая — главная кнопка
      var html = validNetworks(texts.sheetNetworks).map(function (n, index) {
        return '<a class="btn ' + (index === 0 ? 'btn--accent' : 'btn--ghost') + '" href="' + safeUrl(n.link) + '"' + blank(n.link) + '>' +
          esc(networkLabel(label, str(n.title))) + '</a>';
      });
      if (texts.sheetPhone !== false && safeUrl(contacts.phoneHref)) {
        html.push('<a class="btn ' + (html.length ? 'btn--ghost' : 'btn--accent') + '" href="' + safeUrl(contacts.phoneHref) + '">' +
          esc(phoneLabel + ' ' + str(contacts.phone)) + '</a>');
      }
      host.innerHTML = html.join('');
      this.hasActions = !!host.querySelector('a');
    },

    open: function () {
      var root = this.root;
      if (!root || !this.hasActions) return false;
      this.lastFocus = document.activeElement;
      root.hidden = false;
      // даём браузеру отрисовать окно, чтобы сработала анимация
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { root.classList.add('is-open'); });
      });
      // фокус на само окно (без рамки на кнопке); дальше Tab идёт по кнопкам
      var panel = root.querySelector('.sheet__panel');
      if (panel) setTimeout(function () { panel.focus({ preventScroll: true }); }, 50);
      return true;
    },

    close: function (keepFocus) {
      var root = this.root;
      if (!root || root.hidden) return;
      root.classList.remove('is-open');
      setTimeout(function () { root.hidden = true; }, 260);
      // фокус возвращаем на кнопку, кроме случая, когда человек ушёл по ссылке в шапке
      if (!keepFocus && this.lastFocus && this.lastFocus.focus) this.lastFocus.focus({ preventScroll: true });
    },

    setup: function () {
      var self = this;
      self.root = q('[data-sheet]');
      if (!self.root) return;
      // запасные кнопки из разметки — на случай, если data.json не загрузился
      self.hasActions = !!self.root.querySelector('.sheet__actions a');

      document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('[data-open-signup]')) {
          if (self.open()) event.preventDefault();
          return;
        }
        if (target.closest('[data-sheet-close]')) {
          self.close();
          return;
        }
        // нажали что-то в шапке при открытом окне — закрываем окно
        if (!self.root.hidden && target.closest('.site-header')) {
          self.close(true);
          return;
        }
        // выбрали способ записи — окно закрываем
        if (target.closest('.sheet__actions a')) self.close();
      });

      // Колесо и свайп по окну не прокручивают страницу под ним.
      // Внутри панели прокрутка работает, если её содержимое не помещается.
      var panel = self.root.querySelector('.sheet__panel');
      function stopScroll(event) {
        var inPanel = panel && panel.contains(event.target);
        if (inPanel && panel.scrollHeight > panel.clientHeight + 1) {
          var dy = event.deltaY || 0;
          var atTop = panel.scrollTop <= 0;
          var atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
          if (event.type === 'touchmove' || (dy < 0 && !atTop) || (dy > 0 && !atBottom)) return;
        }
        event.preventDefault();
      }
      self.root.addEventListener('wheel', stopScroll, { passive: false });
      self.root.addEventListener('touchmove', stopScroll, { passive: false });

      document.addEventListener('keydown', function (event) {
        if (self.root.hidden) return;
        if (event.key === 'Escape') {
          self.close();
          return;
        }
        // Tab не уходит из окна
        if (event.key === 'Tab') {
          var items = Array.prototype.slice.call(self.root.querySelectorAll('a, button'));
          if (!items.length) return;
          var first = items[0];
          var last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            last.focus();
            event.preventDefault();
          } else if (!event.shiftKey && document.activeElement === last) {
            first.focus();
            event.preventDefault();
          }
        }
      });
    }
  };

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
    applyContacts(data.contacts || {});
    sheet.fill(data.contacts || {}, data.signup || {});
    applyTexts(data);

    renderStrip(data.strip);
    renderTrainings(list(data.trainings));
    renderSchedule(list(data.schedule), data.cancellations);
    renderSignup(data.signup);
    renderVenues(list(data.venues));
    renderCoaches(list(data.coaches));
    renderPromos(list(data.promos));
    renderTournaments(list(data.tournaments));
    renderPartners(list(data.partners));
    renderFaq(list(data.faq));

    applyHash();
  }

  // Рамка фокуса — только для клавиатуры: клик или касание её прячут, Tab и стрелки возвращают
  function trackInputMode() {
    var root = document.documentElement;
    document.addEventListener('pointerdown', function () {
      root.classList.add('using-pointer');
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' || event.key.indexOf('Arrow') === 0) root.classList.remove('using-pointer');
    }, true);
  }

  function start() {
    trackInputMode();
    setYear();
    setupStickyCta();
    sheet.setup();
    gallery.setup();
    strip.setup();
    maps.setup();

    var loader = createLoader();

    // Если data.json не загрузился, блоки остаются скрытыми,
    // а первый экран и контакты показывают то, что прописано в index.html
    loadData().then(render).catch(function () {
      // ничего не трогаем: остаются контакты по умолчанию из разметки
    }).then(loader.done, loader.done);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
