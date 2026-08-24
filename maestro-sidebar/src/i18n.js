(function i18nRuntime(globalScope) {
  'use strict';

  const SUPPORTED_LOCALES = ['en', 'zh-CN'];
  const DEFAULT_LOCALE = 'en';
  const STORAGE_KEY = 'maestro-sidebar.locale';
  const RESOURCE_PATH = 'locales';

  let resources = {};
  let preference = 'system';
  let locale = DEFAULT_LOCALE;
  let initialized = false;

  function canonicalize(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
  }

  function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
    const candidate = canonicalize(value);
    if (candidate === 'en' || candidate.startsWith('en-')) return 'en';
    if (candidate === 'zh'
      || candidate.startsWith('zh-cn')
      || candidate.startsWith('zh-sg')
      || candidate.startsWith('zh-hans')) return 'zh-CN';
    return fallback === null ? null : normalizeLocale(fallback, null) || DEFAULT_LOCALE;
  }

  function normalizePreference(value) {
    if (String(value || '').toLowerCase() === 'system') return 'system';
    return normalizeLocale(value, null) || 'system';
  }

  function resolveLocale(selected = 'system', systemLocales) {
    const normalized = normalizePreference(selected);
    if (normalized !== 'system') return normalized;
    const candidates = systemLocales || globalScope?.navigator?.languages || [globalScope?.navigator?.language];
    for (const candidate of candidates || []) {
      const matched = normalizeLocale(candidate, null);
      if (matched) return matched;
    }
    return DEFAULT_LOCALE;
  }

  function getPath(object, key) {
    return String(key).split('.').reduce((value, part) => (
      value && Object.prototype.hasOwnProperty.call(value, part) ? value[part] : undefined
    ), object);
  }

  function interpolate(message, variables = {}) {
    return String(message).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
    ));
  }

  function translate(key, variables, requestedLocale = locale) {
    const active = normalizeLocale(requestedLocale);
    const value = getPath(resources[active], key);
    const fallback = getPath(resources[DEFAULT_LOCALE], key);
    const message = value === undefined ? fallback : value;
    return message === undefined ? String(key) : interpolate(message, variables);
  }

  function applyTranslations(root) {
    if (!globalScope?.document) return;
    const scope = root || globalScope.document;
    // Keep the HTML's built-in fallback copy when resources cannot be loaded.
    if (!Object.keys(resources).length) {
      globalScope.document.documentElement.lang = locale;
      return;
    }
    const nodes = [];
    if (scope.nodeType === 1 && scope.matches?.('[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]')) {
      nodes.push(scope);
    }
    nodes.push(...scope.querySelectorAll?.('[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]') || []);
    for (const node of nodes) {
      if (node.dataset.i18n) node.textContent = translate(node.dataset.i18n);
      if (node.dataset.i18nHtml) node.innerHTML = translate(node.dataset.i18nHtml);
      if (node.dataset.i18nTitle) node.setAttribute('title', translate(node.dataset.i18nTitle));
      if (node.dataset.i18nAriaLabel) node.setAttribute('aria-label', translate(node.dataset.i18nAriaLabel));
      if (node.dataset.i18nPlaceholder) node.setAttribute('placeholder', translate(node.dataset.i18nPlaceholder));
    }
    globalScope.document.documentElement.lang = locale;
  }

  function emitLocaleChange() {
    if (!globalScope?.dispatchEvent) return;
    const EventType = globalScope.CustomEvent || globalScope.Event;
    globalScope.dispatchEvent(new EventType('maestro-locale-changed', { detail: { locale, preference } }));
  }

  function setPreference(nextPreference, options = {}) {
    preference = normalizePreference(nextPreference);
    locale = resolveLocale(preference, options.systemLocales);
    if (options.persist !== false && globalScope?.localStorage) {
      globalScope.localStorage.setItem(STORAGE_KEY, preference);
    }
    applyTranslations(options.root);
    if (options.emit !== false) emitLocaleChange();
    return locale;
  }

  async function loadResources(fetcher) {
    const load = fetcher || globalScope?.fetch?.bind(globalScope);
    if (!load) throw new Error('No fetch implementation available for locale resources');
    const entries = await Promise.all(SUPPORTED_LOCALES.map(async (name) => {
      const response = await load(`${RESOURCE_PATH}/${name}.json`);
      if (!response.ok) throw new Error(`Unable to load locale ${name}: ${response.status}`);
      return [name, await response.json()];
    }));
    resources = Object.fromEntries(entries);
    return resources;
  }

  async function init(options = {}) {
    if (options.resources) resources = options.resources;
    else if (!Object.keys(resources).length) {
      try {
        await loadResources(options.fetcher);
      } catch {
        // Fail open: packaged UI remains usable with its static fallback copy.
        resources = {};
      }
    }
    const stored = options.preference ?? globalScope?.localStorage?.getItem(STORAGE_KEY) ?? 'system';
    setPreference(stored, { persist: false, emit: false, systemLocales: options.systemLocales, root: options.root });
    if (!initialized && globalScope?.addEventListener) {
      globalScope.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        setPreference(event.newValue || 'system', { persist: false });
      });
      globalScope.addEventListener('languagechange', () => {
        if (preference === 'system') setPreference('system', { persist: false });
      });
      initialized = true;
    }
    return locale;
  }

  function asDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number' && value > 0 && value < 100000000000) return new Date(value * 1000);
    return new Date(value);
  }

  function formatTime(value, options = {}) {
    const date = asDate(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...options }).format(date);
  }

  function formatDateTime(value, options = {}) {
    const date = asDate(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      ...options,
    }).format(date);
  }

  function formatRelative(value, now = Date.now()) {
    const date = asDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const seconds = (date.getTime() - Number(now)) / 1000;
    const absolute = Math.abs(seconds);
    let unit = 'second';
    let amount = seconds;
    if (absolute >= 86400) {
      unit = 'day';
      amount = seconds / 86400;
    } else if (absolute >= 3600) {
      unit = 'hour';
      amount = seconds / 3600;
    } else if (absolute >= 60) {
      unit = 'minute';
      amount = seconds / 60;
    }
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(amount), unit);
  }

  function getLocale() { return locale; }
  function getPreference() { return preference; }
  function setResources(nextResources) { resources = nextResources || {}; }

  const api = {
    DEFAULT_LOCALE,
    STORAGE_KEY,
    SUPPORTED_LOCALES,
    applyTranslations,
    formatDateTime,
    formatRelative,
    formatTime,
    getLocale,
    getPreference,
    init,
    interpolate,
    normalizeLocale,
    normalizePreference,
    resolveLocale,
    setPreference,
    setResources,
    t: translate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.MaestroI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
