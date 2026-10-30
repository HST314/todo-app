// 设置分两层：
// - localStorage 是本机即时缓存（含 uiZoom 等设备相关项），启动零延迟；
// - 数据目录下的 settings.json 是跨设备共享的权威版本（类别/主题等），随 Git 同步。
// 任务数据永远只存 Markdown。

const KEY = 'shiguang.settings.v1';

// 写入共享 settings.json 的键；uiZoom 是设备相关的，只留本机
export const SHARED_KEYS = ['theme', 'reminderLead', 'periodReminder', 'categories', 'lastCategory'];

export const DEFAULT_CATEGORIES = [
  { name: '科研', color: '#3B82F6' },
  { name: '创业', color: '#F59E0B' },
  { name: '生活', color: '#10B981' },
  { name: '其他', color: '#94A3B8' },
];

export const DEFAULT_SETTINGS = {
  theme: 'auto',            // auto | light | dark
  uiZoom: 100,              // 界面缩放百分比：100 | 110 | 125 | 150
  reminderLead: 10,         // 分钟
  periodReminder: false,    // 时段任务在时段开始时提醒
  categories: DEFAULT_CATEGORIES,
  lastCategory: '科研',
};

export const ZOOM_OPTIONS = [100, 110, 125, 150];

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    saved = {};
  }
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!ZOOM_OPTIONS.includes(Number(settings.uiZoom))) settings.uiZoom = 100;
  settings.uiZoom = Number(settings.uiZoom);
  if (!Array.isArray(settings.categories) || settings.categories.length === 0) {
    settings.categories = DEFAULT_CATEGORIES;
  }
  settings.categories = settings.categories
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({ name: c.name.trim(), color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#94A3B8' }));
  if (!settings.categories.some((c) => c.name === '其他')) {
    settings.categories.push({ name: '其他', color: '#94A3B8' });
  }
  return settings;
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function packShared(settings) {
  const out = {};
  for (const key of SHARED_KEYS) out[key] = settings[key];
  return out;
}

/** 把共享文件的字段并入本机设置（带校验）。返回是否有变化。 */
export function mergeShared(settings, shared) {
  if (!shared || typeof shared !== 'object') return false;
  const before = JSON.stringify(packShared(settings));

  if (['auto', 'light', 'dark'].includes(shared.theme)) settings.theme = shared.theme;
  if (Number.isFinite(Number(shared.reminderLead))) settings.reminderLead = Number(shared.reminderLead);
  if (typeof shared.periodReminder === 'boolean') settings.periodReminder = shared.periodReminder;
  if (typeof shared.lastCategory === 'string' && shared.lastCategory.trim()) {
    settings.lastCategory = shared.lastCategory.trim();
  }
  if (Array.isArray(shared.categories) && shared.categories.length) {
    settings.categories = shared.categories
      .filter((c) => c && typeof c.name === 'string' && c.name.trim())
      .map((c) => ({ name: c.name.trim(), color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#94A3B8' }));
    if (!settings.categories.length) settings.categories = DEFAULT_CATEGORIES;
    if (!settings.categories.some((c) => c.name === '其他')) {
      settings.categories.push({ name: '其他', color: '#94A3B8' });
    }
  }
  return JSON.stringify(packShared(settings)) !== before;
}

export function categoryColor(settings, name) {
  const found = settings.categories.find((c) => c.name === name);
  return found ? found.color : '#94A3B8';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function applyZoom(uiZoom) {
  const zoom = Number(uiZoom) / 100;
  document.body.style.zoom = zoom === 1 ? '' : String(zoom);
}

export function resolvedTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function cycleTheme(current) {
  if (current === 'auto') return 'light';
  if (current === 'light') return 'dark';
  return 'auto';
}
