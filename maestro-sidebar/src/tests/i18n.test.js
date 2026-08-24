'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const i18n = require('../i18n.js');
const localeDir = path.join(__dirname, '..', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const zhCN = JSON.parse(fs.readFileSync(path.join(localeDir, 'zh-CN.json'), 'utf8'));

function leafKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? leafKeys(child, next)
      : [next];
  });
}

test('English and zh-CN resources have identical leaf keys', () => {
  assert.deepEqual(leafKeys(zhCN).sort(), leafKeys(en).sort());
});

test('all statically referenced translation keys exist', () => {
  const sourceNames = ['app.js', 'editor.js', 'index.html', 'editor.html'];
  const referenced = new Set();
  const patterns = [
    /\b(?:t|tr)\(\s*['"]([^'"]+)['"]/g,
    /data-i18n(?:-[a-z-]+)?=['"]([^'"]+)['"]/g,
    /data-theme-name-key=['"]([^'"]+)['"]/g,
  ];
  for (const sourceName of sourceNames) {
    const source = fs.readFileSync(path.join(__dirname, '..', sourceName), 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) referenced.add(match[1]);
    }
  }
  const available = new Set(leafKeys(en));
  const missing = [...referenced].filter((key) => !available.has(key)).sort();
  assert.deepEqual(missing, []);
});

test('locale normalization accepts common browser and persisted forms', () => {
  assert.equal(i18n.normalizeLocale('en-US'), 'en');
  assert.equal(i18n.normalizeLocale('EN_gb'), 'en');
  assert.equal(i18n.normalizeLocale('zh'), 'zh-CN');
  assert.equal(i18n.normalizeLocale('zh_Hans_CN'), 'zh-CN');
  assert.equal(i18n.normalizeLocale('zh-SG'), 'zh-CN');
  assert.equal(i18n.normalizeLocale('zh-CN-u-nu-hanidec'), 'zh-CN');
  assert.equal(i18n.normalizeLocale('fr-FR'), 'en');
  assert.equal(i18n.normalizeLocale('fr-FR', null), null);
});

test('system locale resolution selects a supported language and falls back to English', () => {
  assert.equal(i18n.resolveLocale('system', ['fr-FR', 'zh-Hans']), 'zh-CN');
  assert.equal(i18n.resolveLocale('system', ['de-DE']), 'en');
  assert.equal(i18n.resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(i18n.normalizePreference('unsupported'), 'system');
});

test('resource loading fails open instead of blocking application startup', async () => {
  i18n.setResources({});
  const locale = await i18n.init({
    preference: 'en',
    fetcher: async () => { throw new Error('blocked by CSP'); },
  });
  assert.equal(locale, 'en');
  i18n.setResources({ en, 'zh-CN': zhCN });
});

test('translation falls back to English and interpolates named values', () => {
  i18n.setResources({
    en: { greeting: 'Hello, {{name}}!', fallback: 'English fallback' },
    'zh-CN': { greeting: '你好，{{name}}！' },
  });

  assert.equal(i18n.t('greeting', { name: 'Maestro' }, 'zh-CN'), '你好，Maestro！');
  assert.equal(i18n.t('fallback', {}, 'zh-CN'), 'English fallback');
  assert.equal(i18n.t('missing.key', {}, 'zh-CN'), 'missing.key');
  assert.equal(i18n.interpolate('Keep {{missing}}; use {{value}}', { value: 7 }), 'Keep {{missing}}; use 7');

  i18n.setResources({ en, 'zh-CN': zhCN });
});
