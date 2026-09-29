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

  function media(prefix, url, alt, fill) {
    var src = safeUrl(url);
    if (src) {
      return '<div class="' + prefix + '__media"><img src="' + src + '" alt="' + esc(alt) + '" loading="lazy"></div>';
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

  function applyContacts(contacts) {
    setLink('[data-tg-link]', contacts.telegram);
    setLink('[data-max-link]', contacts.max);
    setLink('[data-phone-link]', contacts.phoneHref);

    qa('[data-phone-text]').forEach(function (node) {
      node.textContent = str(contacts.phone);
    });
    qa('[data-phone-name]').forEach(function (node) {
      node.innerHTML = escMultiline(contacts.phoneNote);
      node.hidden = !str(contacts.phoneNote);
    });
    qa('.tournaments__more').forEach(function (node) {
      node.hidden = !safeUrl(contacts.telegram);
    });

    var socials = q('[data-socials]');
    if (socials) {
      var items = list(contacts.socials).filter(function (s) {
        return str(s.title) && safeUrl(s.link);
      });
      socials.innerHTML = items.map(function (s) {
        return '<li class="socials__item"><a class="socials__link" href="' + safeUrl(s.link) + '"' + blank(s.link) + '>' +
          esc(s.title) + '</a></li>';
      }).join('');
      socials.hidden = items.length === 0;
    }
  }

  function applyTexts(data) {
    var hero = data.hero || {};
    setText('[data-hero-title]', hero.title);
    setText('[data-hero-slogan]', hero.slogan);
    setText('[data-hero-text]', hero.text);

    var final = data.final || {};
    setText('[data-final-title]', final.title);
    setText('[data-final-text]', final.text);
    setText('[data-final-groups-text]', final.groupsText);
  }

  /* ---------- блоки ---------- */

  function renderTrainings(items) {
    var host = q('[data-trainings]');
    if (!host) return;

    host.innerHTML = items.map(function (t) {
      var contact = t.contact && safeUrl(t.contact.href);
      return '<article class="training">' +
        '<h3 class="training__title">' + esc(t.title) + '</h3>' +
        (str(t.html) ? '<div class="training__text rich">' + richHtml(t.html) + '</div>' : '') +
        (contact
          ? '<p class="training__contact">Записаться: <a class="link-accent" href="' + contact + '"' + blank(t.contact.href) + '>' +
            esc(t.contact.label || 'написать') + '</a></p>'
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

  function renderSchedule(items) {
    var host = q('[data-schedule]');
    if (!host) return;

    host.innerHTML = items.map(function (row) {
      var type = row.type || null;
      var venue = row.venue || null;
      var venueHtml = '';
      if (venue) {
        venueHtml = venue.anchor
          ? '<a class="row__venue-link" href="#' + esc(venue.anchor) + '">' + esc(venue.title) + '</a>'
          : esc(venue.title);
      }
      var price = formatPrice(row.price);

      return '<article class="row">' +
        '<div class="row__day"><span class="row__day-in">' + esc(row.day) + '</span></div>' +
        '<div class="row__time">' + esc(row.time) + '</div>' +
        '<div class="row__meta">' +
          (type ? '<span class="type' + (type.highlight ? ' type--play' : '') + '">' + esc(type.title) + '</span>' : '') +
          '<span class="levels">' + levelBadges(list(row.levels)) + '</span>' +
        '</div>' +
        '<div class="row__venue">' + venueHtml + '</div>' +
        '<div class="row__price">' + (price ? '<span class="price">' + esc(price) + '</span>' : '') + '</div>' +
        '</article>';
    }).join('');

    reveal('schedule', items.length > 0);
  }

  function renderSignup(block) {
    var data = block || {};
    var steps = list(data.steps);
    var host = q('[data-steps]');
    var isVisible = data.show !== false && steps.length > 0;

    if (host) {
      host.innerHTML = steps.map(function (step, index) {
        return '<li class="step">' +
          '<span class="step__num" aria-hidden="true">' + (index + 1) + '</span>' +
          (str(step.title) ? '<h3 class="step__title">' + esc(step.title) + '</h3>' : '') +
          (str(step.html) ? '<div class="step__text rich">' + richHtml(step.html) + '</div>' : '') +
          '</li>';
      }).join('');
      layoutGrid(host, steps.length, 4);
    }

    var eyebrow = q('[data-signup-eyebrow]');
    if (eyebrow) {
      eyebrow.textContent = str(data.eyebrow);
      eyebrow.hidden = !str(data.eyebrow);
    }
    setText('[data-signup-title]', data.title);

    // Кнопки записи: свой контакт блока или общий (это решает сборка)
    setLink('[data-signup-tg]', data.telegram);
    setLink('[data-signup-max]', data.max);

    // Кнопка «Записаться» в шапке ведёт к этому блоку, если он показан
    qa('[data-signup-cta]').forEach(function (node) {
      node.setAttribute('href', isVisible ? '#signup' : '#contacts');
    });

    reveal('signup', isVisible);
  }

  function renderVenues(items) {
    var host = q('[data-venues]');
    if (!host) return;

    host.innerHTML = items.map(function (v) {
      var map = safeUrl(v.map);
      return '<article class="venue" id="' + esc(v.anchor) + '">' +
        '<h3 class="venue__title">' + esc(v.title) + '</h3>' +
        (str(v.address) ? '<p class="venue__address">' + escMultiline(v.address) + '</p>' : '') +
        '<div class="venue__foot">' +
          '<p class="venue__days">' + strings(v.days).map(function (day) {
            return '<span class="day-chip">' + esc(day) + '</span>';
          }).join('') + '</p>' +
          (map ? '<a class="venue__map" href="' + map + '" target="_blank" rel="noopener">Показать на карте</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('venues', items.length > 0);
  }

  function renderCoaches(items) {
    var host = q('[data-coaches]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'photo');

    host.innerHTML = items.map(function (c) {
      var telegram = safeUrl(c.telegram);
      var hasMedia = safeUrl(c.photo) || fill;
      return '<article class="coach' + (hasMedia ? '' : ' is-textonly') + '">' +
        media('coach', c.photo, c.title, fill) +
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

  function renderPromos(all) {
    var items = all.filter(isActual);
    var host = q('[data-promos]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'image');

    host.innerHTML = items.map(function (p) {
      var link = safeUrl(p.buttonLink);
      var hasMedia = safeUrl(p.image) || fill;
      return '<article class="promo' + (hasMedia ? '' : ' is-textonly') + '">' +
        media('promo', p.image, p.title, fill) +
        '<div class="promo__body">' +
          '<h3 class="promo__title">' + escMultiline(p.title) + '</h3>' +
          (str(p.html) ? '<div class="promo__text rich">' + richHtml(p.html) + '</div>' : '') +
          (str(p.buttonLabel) && link
            ? '<a class="btn btn--accent" href="' + link + '"' + blank(p.buttonLink) + '>' + esc(p.buttonLabel) + '</a>'
            : '') +
        '</div>' +
        '</article>';
    }).join('');

    layoutGrid(host, items.length, 3);
    reveal('promos', items.length > 0);
  }

  function renderTournaments(block) {
    var data = block || {};
    var items = list(data.items).filter(isActual);
    var host = q('[data-tournaments]');
    if (!host) return;
    var fill = needsPlaceholder(items, 'poster');

    host.innerHTML = items.map(function (t) {
      var link = safeUrl(t.link);
      var hasMedia = safeUrl(t.poster) || fill;
      var place = '';
      if (str(t.place)) {
        place = t.placeAnchor
          ? '<a class="tournament__where row__venue-link" href="#' + esc(t.placeAnchor) + '">' + esc(t.place) + '</a>'
          : '<span class="tournament__where">' + esc(t.place) + '</span>';
      }
      return '<article class="tournament' + (hasMedia ? '' : ' is-textonly') + '">' +
        media('tournament', t.poster, t.title, fill) +
        '<div class="tournament__body">' +
          '<h3 class="tournament__title">' + escMultiline(t.title) + '</h3>' +
          ((str(t.dates) || place) ? '<p class="tournament__when">' + esc(t.dates) + place + '</p>' : '') +
          (str(t.html) ? '<div class="tournament__text rich">' + richHtml(t.html) + '</div>' : '') +
          (link ? '<a class="btn btn--ghost" href="' + link + '"' + blank(t.link) + '>Подробнее</a>' : '') +
        '</div>' +
        '</article>';
    }).join('');

    var intro = q('[data-tournaments-intro]');
    if (intro) {
      intro.innerHTML = richHtml(data.introHtml);
      intro.hidden = !str(data.introHtml);
    }

    layoutGrid(host, items.length, 3);
    reveal('tournaments', items.length > 0);
  }

  function renderPartners(items) {
    var host = q('[data-partners]');
    if (!host) return;

    host.innerHTML = items.map(function (p) {
      var logo = safeUrl(p.logo);
      var link = safeUrl(p.link);
      var inner = (logo
        ? '<img class="partner__logo" src="' + logo + '" alt="' + esc(p.title) + '" loading="lazy">'
        : '<span class="partner__name">' + esc(p.title) + '</span>') +
        (str(p.description) ? '<span class="partner__desc">' + escMultiline(p.description) + '</span>' : '');

      return link
        ? '<a class="partner" href="' + link + '"' + blank(p.link) + '>' + inner + '</a>'
        : '<div class="partner">' + inner + '</div>';
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
    applyTexts(data);

    renderTrainings(list(data.trainings));
    renderSchedule(list(data.schedule));
    renderSignup(data.signup);
    renderVenues(list(data.venues));
    renderCoaches(list(data.coaches));
    renderPromos(list(data.promos));
    renderTournaments(data.tournaments);
    renderPartners(list(data.partners));
    renderFaq(list(data.faq));

    applyHash();
  }

  function start() {
    setYear();
    setupStickyCta();

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
