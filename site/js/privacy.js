(function () {
  'use strict';

  // Страница «Политика обработки персональных данных» (site/privacy/).
  // Текст правится в админке («Политика обработки данных» → content/privacy.json),
  // сборка tools/build-content.mjs кладёт его в data.json уже в виде HTML.
  // При публикации tools/prerender.mjs запускает этот скрипт и сохраняет страницу
  // с текстом (data-ready) — тогда в браузере скрипт ничего не перерисовывает.
  var DATA_URL = '../data.json';
  var TIMEOUT_MS = 8000;

  function q(sel) { return document.querySelector(sel); }

  function str(value) {
    return value == null ? '' : String(value).trim();
  }

  /* ---------- форматированный текст ----------
     Те же правила, что у richHtml() в app.js: только разрешённые теги и безопасные
     ссылки. Отличие — заголовки: здесь разделы политики, поэтому H2 и H3. */

  var ALLOWED_TAGS = {
    P: [], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], DEL: [],
    UL: [], OL: ['start'], LI: [], A: ['href', 'class'],
    H2: [], H3: [], BLOCKQUOTE: [], CODE: []
  };
  var RENAME_TAGS = { H1: 'H2', H4: 'H3', H5: 'H3', H6: 'H3' };
  var DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|SVG|MATH|NOSCRIPT|TITLE|HEAD|FORM|INPUT|BUTTON|SELECT|TEXTAREA|IMG|VIDEO|AUDIO)$/;
  var ALLOWED_CLASSES = { 'link-accent': true, 'link-soft': true };

  function isSafeUrl(value) {
    var raw = str(value);
    if (!raw || /^\/\//.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return false;
    if (/^(https?:|tel:|mailto:)/i.test(raw)) return true;
    return !/^[a-z][a-z0-9+.\-]*:/i.test(raw);
  }

  // Ссылки на сам сайт открываем в этой же вкладке, на другие — в новой
  function isExternal(url) {
    var match = /^https?:\/\/([^/?#]+)/i.exec(str(url));
    return !!match && match[1].replace(/^www\./i, '').toLowerCase() !== location.hostname.replace(/^www\./i, '').toLowerCase();
  }

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
    var template = document.createElement('template');
    template.innerHTML = str(html);
    cleanTree(template.content);
    var box = document.createElement('div');
    box.appendChild(template.content);
    return box.innerHTML;
  }

  /* ---------- вывод ---------- */

  function render(data) {
    var privacy = data && data.privacy;
    if (!privacy || !str(privacy.html)) throw new Error('no privacy text');

    var title = q('[data-privacy-title]');
    if (title && str(privacy.title)) {
      title.textContent = str(privacy.title);
    }

    var date = q('[data-privacy-date]');
    if (date) {
      date.textContent = str(privacy.dateText) ? 'Дата публикации: ' + str(privacy.dateText) : '';
      date.hidden = !str(privacy.dateText);
    }

    var text = q('[data-privacy-text]');
    text.innerHTML = richHtml(privacy.html);
    text.setAttribute('data-ready', '');
  }

  function showError() {
    var text = q('[data-privacy-text]');
    if (text) {
      text.innerHTML = '<p>Не удалось загрузить текст. Обновите страницу — или позвоните нам: ' +
        '<a class="link-accent" href="tel:+79272776339">+7&nbsp;(927)&nbsp;277-63-39</a>.</p>';
    }
  }

  function loadData() {
    var timer;
    var request = fetch(DATA_URL, { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error('timeout')); }, TIMEOUT_MS);
    });
    return Promise.race([request, timeout]).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  function start() {
    var year = q('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());

    // Рамка фокуса — только для клавиатуры, как на главной
    var root = document.documentElement;
    document.addEventListener('pointerdown', function () { root.classList.add('using-pointer'); }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' || event.key.indexOf('Arrow') === 0) root.classList.remove('using-pointer');
    }, true);

    var text = q('[data-privacy-text]');
    if (!text || text.hasAttribute('data-ready')) return;   // страница уже с текстом (собрана при публикации)
    if (typeof fetch !== 'function') {
      showError();
      return;
    }
    loadData().then(render).catch(showError);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
