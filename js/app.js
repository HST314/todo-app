// 应用入口：状态、路由、数据变更、设置与视图调度。

import {
  attachmentFileName, attachmentFolderOf, FileConflictError, makeTaskFolderName,
  Store,
} from './store.js';
import {
  applyTheme, applyZoom, cycleTheme, loadSettings, mergeShared, packShared,
  saveSettings, ZOOM_OPTIONS,
} from './settings.js';
import {
  genTaskId, insertTaskAtPeriod, normalizeTaskOrder, parseDayFile, serializeDayFile,
} from './markdown.js';
import {
  addDays, dateFromIsoWeek, isoWeekKey, monthKey, parseDateKey, PERIOD_LABEL,
  periodOfTask, toDateKey,
} from './date.js';
import { h, openModal, toast } from './ui.js';
import { renderMonth } from './views/month.js';
import { renderWeek } from './views/week.js';
import { renderDay } from './views/day.js';
import { openDetail, openQuickAdd } from './views/common.js';
import { openSearch } from './search.js';
import { initClock } from './clock.js';
import { startReminders, requestNotificationPermission } from './notify.js';

const store = new Store();
const settings = loadSettings();
applyTheme(settings.theme);
applyZoom(settings.uiZoom);

const state = {
  view: 'month',
  anchor: new Date(),
  days: new Map(),
  loadedMonths: new Set(),
  dayPromises: new Map(),
  monthPromises: new Map(),
  allDays: null,
  allDaysAt: 0,
  overdueCache: new Map(),
  hideCompleted: false,
  midnightOpen: false,
  highlightTaskId: null,
  renderSeq: 0,
  settingsMtime: null,
};

let clockController = null;

/* ================= 数据读取 ================= */

async function loadDay(dateKey, { force = false } = {}) {
  if (!store.ready) {
    return { dateKey, tasks: [], note: '', extras: [], loose: [], lastModified: null, exists: false };
  }
  if (!force && state.days.has(dateKey)) return state.days.get(dateKey);
  if (!force && state.dayPromises.has(dateKey)) return state.dayPromises.get(dateKey);

  const promise = (async () => {
    try {
      const read = await store.readDay(dateKey);
      const parsed = read.exists
        ? parseDayFile(read.text, dateKey)
        : { dateKey, tasks: [], note: '', extras: [], loose: [] };
      const day = { ...parsed, dateKey, lastModified: read.lastModified, exists: read.exists };
      state.days.set(dateKey, day);
      return day;
    } catch (err) {
      console.error('读取日期失败', dateKey, err);
      toast(`读取 ${dateKey} 失败：${err.message}`, { type: 'error' });
      const empty = { dateKey, tasks: [], note: '', extras: [], loose: [], lastModified: null, exists: false };
      state.days.set(dateKey, empty);
      return empty;
    }
  })().finally(() => state.dayPromises.delete(dateKey));

  state.dayPromises.set(dateKey, promise);
  return promise;
}

async function ensureMonth(month) {
  if (!store.ready) return;
  if (state.loadedMonths.has(month)) return;
  if (state.monthPromises.has(month)) return state.monthPromises.get(month);

  const promise = (async () => {
    try {
      const keys = await store.listDayKeys(month);
      await Promise.all(keys.map((key) => loadDay(key)));
      state.loadedMonths.add(month);
    } catch (err) {
      console.error('读取月份失败', month, err);
    }
  })().finally(() => state.monthPromises.delete(month));

  state.monthPromises.set(month, promise);
  return promise;
}

async function scanAllDays({ force = false } = {}) {
  if (!store.ready) return [];
  if (!force && state.allDays && Date.now() - state.allDaysAt < 15000) return state.allDays;
  const raw = await store.readAllDays();
  const parsed = raw.map((item) => ({ dateKey: item.dateKey, ...parseDayFile(item.text, item.dateKey) }));
  parsed.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  state.allDays = parsed;
  state.allDaysAt = Date.now();
  return parsed;
}

async function getOverdue(dateKey) {
  if (!store.ready) return [];
  const cached = state.overdueCache.get(dateKey);
  if (cached && Date.now() - cached.at < 15000) return cached.items;

  const days = await scanAllDays();
  const items = [];
  for (const day of days) {
    if (day.dateKey >= dateKey) continue;
    for (const task of day.tasks) {
      if (!task.done) items.push({ dateKey: day.dateKey, task });
    }
  }
  items.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  state.overdueCache.set(dateKey, { at: Date.now(), items });
  return items;
}

function invalidateIndexes() {
  state.allDays = null;
  state.allDaysAt = 0;
  state.overdueCache.clear();
}

/* ================= 共享设置（数据目录 settings.json，随 Git 跨设备同步） ================= */

/**
 * 启动/切换数据目录时拉取共享设置。
 * 文件不存在时把本机当前设置写出去（首次迁移）。
 */
async function pullSharedSettings() {
  if (!store.ready) return;
  try {
    const remote = await store.readSharedSettings();
    if (!remote.exists) {
      const result = await store.writeSharedSettings(
        JSON.stringify(packShared(settings), null, 2), null,
      );
      state.settingsMtime = result.lastModified;
      return;
    }
    state.settingsMtime = remote.lastModified;
    let shared;
    try {
      shared = JSON.parse(remote.text);
    } catch {
      console.warn('settings.json 不是合法 JSON，保留本机设置');
      return;
    }
    if (mergeShared(settings, shared)) {
      saveSettings(settings);
      applyTheme(settings.theme);
      render();
    }
  } catch (err) {
    console.warn('读取共享设置失败', err);
  }
}

/** 本机设置变更后推送到共享文件；磁盘版本更新时拉回磁盘版本。 */
async function pushSharedSettings() {
  if (!store.ready) return;
  try {
    const result = await store.writeSharedSettings(
      JSON.stringify(packShared(settings), null, 2),
      state.settingsMtime ?? undefined,
    );
    state.settingsMtime = result.lastModified;
  } catch (err) {
    if (err instanceof FileConflictError) {
      await pullSharedSettings();
      return;
    }
    console.warn('共享设置写入失败', err);
  }
}

/* ================= 数据写入 ================= */

function conflictChoice(dateKey) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const modal = openModal({
      title: '文件已被外部修改',
      body: h('div', {},
        h('p', { style: { margin: '0 0 8px', fontSize: '13px' } },
          `${dateKey}.md 在磁盘上的修改时间与你打开时不同。`),
        h('p', { class: 'onboarding-note', style: { margin: '0' } },
          '「重新加载」会放弃本次修改，读取磁盘版本；「覆盖磁盘」会保留本次修改。'),
      ),
      footer: [
        h('button', { type: 'button', class: 'pill-btn', onClick: () => { finish('cancel'); modal.close(); } }, '取消'),
        h('button', { type: 'button', class: 'pill-btn', onClick: () => { finish('reload'); modal.close(); } }, '重新加载'),
        h('button', { type: 'button', class: 'pill-btn primary', onClick: () => { finish('overwrite'); modal.close(); } }, '覆盖磁盘'),
      ],
      onClose: () => finish('cancel'),
    });
  });
}

async function saveDay(day, { overwrite = false } = {}) {
  day.tasks = normalizeTaskOrder(day.tasks);
  const text = serializeDayFile(day);
  try {
    const result = await store.writeDay(
      day.dateKey,
      text,
      overwrite ? undefined : day.lastModified,
    );
    day.lastModified = result.lastModified;
    day.exists = true;
    state.days.set(day.dateKey, day);
    invalidateIndexes();
    return { ok: true };
  } catch (err) {
    if (err instanceof FileConflictError) {
      const choice = await conflictChoice(day.dateKey);
      if (choice === 'reload') {
        await loadDay(day.dateKey, { force: true });
        invalidateIndexes();
        toast('已重新加载磁盘版本');
        return { ok: false, reloaded: true };
      }
      if (choice === 'overwrite') return saveDay(day, { overwrite: true });
      return { ok: false, cancelled: true };
    }
    console.error('保存失败', err);
    toast(`保存失败：${err.message}`, { type: 'error', duration: 6000 });
    return { ok: false, error: err };
  }
}

async function addTask(dateKey, task) {
  const day = await loadDay(dateKey);
  day.tasks = insertTaskAtPeriod(day.tasks, task, periodOfTask(task));
  const result = await saveDay(day);
  if (result.ok) refresh();
}

async function toggleTask(dateKey, taskId) {
  const day = await loadDay(dateKey);
  const task = day.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const previous = task.done;
  task.done = !previous;
  const result = await saveDay(day);
  if (!result.ok) return;
  refresh();
  toast(task.done ? '已完成' : '已标为未完成', {
    actionLabel: '撤销',
    duration: 5000,
    onAction: async () => {
      const fresh = await loadDay(dateKey, { force: true });
      const target = fresh.tasks.find((t) => t.id === taskId);
      if (!target) return;
      target.done = previous;
      await saveDay(fresh);
      refresh();
    },
  });
}

async function deleteTask(dateKey, taskId) {
  const day = await loadDay(dateKey);
  const index = day.tasks.findIndex((t) => t.id === taskId);
  if (index < 0) return;
  const [removed] = day.tasks.splice(index, 1);
  const result = await saveDay(day);
  if (!result.ok) return;
  refresh();

  const removedFolders = await store.deleteTaskFolders(dateKey, taskId).catch(() => 0);
  if (removedFolders > 0) {
    toast('任务及附件文件夹已删除');
    return;
  }

  toast('任务已删除', {
    actionLabel: '撤销',
    duration: 5000,
    onAction: async () => {
      const fresh = await loadDay(dateKey, { force: true });
      fresh.tasks.splice(Math.min(index, fresh.tasks.length), 0, removed);
      await saveDay(fresh);
      refresh();
    },
  });
}

/* ================= 附件文件夹 ================= */

async function prepareFolderRename(fromKey, toKey, task, { renameByTitle = false } = {}) {
  const oldFolder = attachmentFolderOf(task.attachments);
  if (!oldFolder) {
    return { ok: true, needed: false, oldFolder: null, newFolder: null };
  }

  const newFolder = renameByTitle ? makeTaskFolderName(task.id, task.title) : oldFolder;
  const monthChanged = fromKey.slice(0, 7) !== toKey.slice(0, 7);
  if (!monthChanged && newFolder === oldFolder) {
    return { ok: true, needed: false, oldFolder, newFolder };
  }

  const prep = await store.prepareTaskFolderMove(fromKey, toKey, oldFolder, newFolder);
  if (!prep.ok) {
    return { ok: false, error: prep.error || '附件文件夹处理失败', oldFolder, newFolder };
  }

  task.attachments = (task.attachments || []).map((att) => {
    const prefix = `attachments/${oldFolder}/`;
    if (typeof att.target === 'string' && att.target.startsWith(prefix)) {
      return { ...att, target: `attachments/${newFolder}/${att.target.slice(prefix.length)}` };
    }
    return att;
  });

  return { ok: true, needed: true, oldFolder, newFolder, ...prep };
}

async function rollbackFolderRename(prep, fromKey, toKey, task) {
  if (!prep?.needed) return;
  task.attachments = (task.attachments || []).map((att) => {
    const prefix = `attachments/${prep.newFolder}/`;
    if (typeof att.target === 'string' && att.target.startsWith(prefix)) {
      return { ...att, target: `attachments/${prep.oldFolder}/${att.target.slice(prefix.length)}` };
    }
    return att;
  });
  if (prep.targetCreated && !prep.targetExisted) {
    try {
      await store.removeTaskFolder(toKey, prep.newFolder);
    } catch {
      // 清理失败时保留副本，不影响旧文件夹
    }
  }
}

async function commitFolderRename(prep, fromKey, toKey) {
  if (!prep?.needed) return;
  if (fromKey === toKey && prep.oldFolder === prep.newFolder) return;
  try {
    await store.removeTaskFolder(fromKey, prep.oldFolder);
  } catch {
    toast('旧附件文件夹清理失败，请手动删除', { type: 'error', duration: 6000 });
  }
}

async function moveTaskRecord(fromKey, toKey, task, { toIndex = Infinity } = {}) {
  const oldId = task.id;
  const target = await loadDay(toKey);
  if (target.tasks.some((t) => t.id === oldId)) task.id = genTaskId();
  target.tasks = insertTaskAtPeriod(target.tasks, task, periodOfTask(task), toIndex);
  const targetResult = await saveDay(target);
  if (!targetResult.ok) return targetResult;

  const source = await loadDay(fromKey, { force: true });
  source.tasks = source.tasks.filter((t) => t.id !== oldId);
  const sourceResult = await saveDay(source);
  if (!sourceResult.ok) {
    toast('源日期清理失败，可能出现重复任务', { type: 'error' });
  }
  return { ok: true };
}

async function deletePendingAttachments(dateKey, folder, targets) {
  if (!folder || !targets?.length) return;
  const seen = new Set();
  for (const target of targets) {
    const file = attachmentFileName(target);
    const key = `${folder}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await store.deleteAttachment(dateKey, `attachments/${folder}/${file}`);
    } catch {
      // 文件可能已被手动删除
    }
  }
}

async function moveTask(fromKey, toKey, task) {
  if (fromKey === toKey) return { ok: true };
  const prep = await prepareFolderRename(fromKey, toKey, task, { renameByTitle: false });
  if (!prep.ok) {
    toast(prep.error || '附件文件夹处理失败', { type: 'error', duration: 6000 });
    return { ok: false };
  }

  const result = await moveTaskRecord(fromKey, toKey, task);
  if (!result.ok) {
    await rollbackFolderRename(prep, fromKey, toKey, task);
    return result;
  }

  await commitFolderRename(prep, fromKey, toKey);
  return { ok: true };
}

async function saveTask(fromKey, task, toKey = fromKey, { pendingDeletes = [] } = {}) {
  const pendingFolder = attachmentFolderOf(pendingDeletes.map((target) => ({ target })));
  const prep = await prepareFolderRename(fromKey, toKey, task, { renameByTitle: true });
  if (!prep.ok) {
    toast(prep.error || '附件文件夹处理失败', { type: 'error', duration: 6000 });
    return { ok: false };
  }

  let result;
  if (toKey === fromKey) {
    const day = await loadDay(fromKey);
    const index = day.tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) {
      const oldPeriod = periodOfTask(day.tasks[index]);
      const newPeriod = periodOfTask(task);
      if (oldPeriod === newPeriod) {
        day.tasks[index] = task;
      } else {
        day.tasks.splice(index, 1);
        day.tasks = insertTaskAtPeriod(day.tasks, task, newPeriod);
      }
    } else {
      day.tasks = insertTaskAtPeriod(day.tasks, task, periodOfTask(task));
    }
    result = await saveDay(day);
  } else {
    result = await moveTaskRecord(fromKey, toKey, task);
  }

  if (!result?.ok) {
    await rollbackFolderRename(prep, fromKey, toKey, task);
    return result;
  }

  await commitFolderRename(prep, fromKey, toKey);

  if (pendingDeletes.length) {
    const folder = prep.needed ? prep.newFolder : pendingFolder;
    const deleteDate = prep.needed ? toKey : fromKey;
    await deletePendingAttachments(deleteDate, folder, pendingDeletes);
  }

  refresh();
  if (toKey !== fromKey) toast(`已移动到 ${toKey}`);
  return { ok: true };
}

async function rescheduleTask(fromKey, taskId, toKey) {
  if (fromKey === toKey) return;
  const source = await loadDay(fromKey);
  const task = source.tasks.find((t) => t.id === taskId);
  if (!task) {
    toast('任务不存在，可能已被删除', { type: 'error' });
    return;
  }
  const result = await moveTask(fromKey, toKey, task);
  if (result.ok) {
    toast(`已改到 ${toKey}`);
    refresh();
  }
}

async function rescheduleAllOverdue(toKey, items) {
  if (!items.length) return;
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.dateKey)) grouped.set(item.dateKey, []);
    grouped.get(item.dateKey).push(item.task);
  }
  let moved = 0;
  for (const [fromKey, tasks] of grouped) {
    for (const task of tasks) {
      const result = await moveTask(fromKey, toKey, task);
      if (result.ok) moved += 1;
    }
  }
  toast(`已把 ${moved} 项改到今天`);
  refresh();
}

/* ================= 拖动 ================= */

function dragTargetLabel(dateKey, period) {
  return `${dateKey.slice(5)} ${PERIOD_LABEL[period] || ''}`.trim();
}

async function undoDragMove({ currentDate, taskId, originalDate, originalTask, originalPeriod, originalIndex }) {
  const current = await loadDay(currentDate, { force: true });
  const index = current.tasks.findIndex((t) => t.id === taskId);
  if (index < 0) {
    toast('任务已不存在，无法撤销', { type: 'error' });
    return;
  }

  current.tasks.splice(index, 1);
  current.tasks = normalizeTaskOrder(current.tasks);
  const restored = structuredClone(originalTask);
  restored.id = taskId;

  if (currentDate === originalDate) {
    current.tasks = insertTaskAtPeriod(current.tasks, restored, originalPeriod, originalIndex);
    const result = await saveDay(current);
    if (result.ok) {
      refresh();
      toast('已撤销');
    }
    return;
  }

  const prep = await prepareFolderRename(currentDate, originalDate, restored, { renameByTitle: false });
  if (!prep.ok) {
    toast(prep.error || '附件文件夹处理失败，无法撤销', { type: 'error', duration: 6000 });
    return;
  }

  const result = await moveTaskRecord(currentDate, originalDate, restored, { toIndex: originalIndex });
  if (!result.ok) {
    await rollbackFolderRename(prep, currentDate, originalDate, restored);
    await loadDay(currentDate, { force: true });
    return;
  }

  await commitFolderRename(prep, currentDate, originalDate);
  refresh();
  toast('已撤销');
}

async function moveTaskByDrag({ fromDate, taskId, toDate, toPeriod, toIndex = Infinity }) {
  if (!fromDate || !toDate || !toPeriod) return;
  const source = await loadDay(fromDate, { force: true });
  const sourceIndex = source.tasks.findIndex((t) => t.id === taskId);
  if (sourceIndex < 0) return;

  const task = source.tasks[sourceIndex];
  const fromPeriod = periodOfTask(task);
  const fromPeriodTasks = source.tasks.filter((t) => periodOfTask(t) === fromPeriod);
  const fromPeriodIndex = fromPeriodTasks.findIndex((t) => t.id === taskId);
  const originalTask = structuredClone(task);
  const sameDay = fromDate === toDate;
  const samePeriod = fromPeriod === toPeriod;

  // 段内排序
  if (sameDay && samePeriod) {
    const targetList = source.tasks.filter((t) => periodOfTask(t) === toPeriod && t.id !== taskId);
    const index = Math.max(0, Math.min(Number.isFinite(toIndex) ? toIndex : targetList.length, targetList.length));
    if (index === fromPeriodIndex) return;
    source.tasks.splice(sourceIndex, 1);
    source.tasks = insertTaskAtPeriod(source.tasks, task, toPeriod, index);
    const result = await saveDay(source);
    if (!result.ok) {
      await loadDay(fromDate, { force: true });
      return;
    }
    refresh();
    toast('顺序已调整', {
      actionLabel: '撤销',
      duration: 5000,
      onAction: () => undoDragMove({
        currentDate: toDate,
        taskId: task.id,
        originalDate: fromDate,
        originalTask,
        originalPeriod: fromPeriod,
        originalIndex: fromPeriodIndex,
      }),
    });
    return;
  }

  // 跨时段清空精确时间；跨天同段保留
  if (!samePeriod) task.time = { type: 'period', period: toPeriod };

  source.tasks.splice(sourceIndex, 1);
  source.tasks = normalizeTaskOrder(source.tasks);

  if (sameDay) {
    source.tasks = insertTaskAtPeriod(source.tasks, task, toPeriod, toIndex);
    const result = await saveDay(source);
    if (!result.ok) {
      await loadDay(fromDate, { force: true });
      refresh();
      return;
    }
  } else {
    const prep = await prepareFolderRename(fromDate, toDate, task, { renameByTitle: false });
    if (!prep.ok) {
      toast(prep.error || '附件文件夹处理失败', { type: 'error', duration: 6000 });
      await loadDay(fromDate, { force: true });
      refresh();
      return;
    }

    const result = await moveTaskRecord(fromDate, toDate, task, { toIndex });
    if (!result.ok) {
      await rollbackFolderRename(prep, fromDate, toDate, task);
      await loadDay(fromDate, { force: true });
      await loadDay(toDate, { force: true });
      refresh();
      return;
    }
    await commitFolderRename(prep, fromDate, toDate);
  }

  refresh();
  toast(`已移动到 ${dragTargetLabel(toDate, toPeriod)}`, {
    actionLabel: '撤销',
    duration: 5000,
    onAction: () => undoDragMove({
      currentDate: toDate,
      taskId: task.id,
      originalDate: fromDate,
      originalTask,
      originalPeriod: fromPeriod,
      originalIndex: fromPeriodIndex,
    }),
  });
}

/* ================= 附件 ================= */

async function attachmentUrl(dateKey, target) {
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return target;
  return store.attachmentUrl(dateKey, target);
}

async function revealPath(relative, select = false) {
  const query = `path=${encodeURIComponent(relative)}${select ? '&select=1' : ''}`;
  let response;
  try {
    response = await fetch(`/api/reveal?${query}`);
  } catch {
    throw new Error('本地文件夹服务未启动，请用 python server.py 启动');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应，通常是普通 http.server 的 404
  }
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || '打开文件夹失败，请确认已用 python server.py 启动');
  }
}

async function revealTaskFolder(dateKey, folder) {
  if (!folder) throw new Error('该任务还没有附件文件夹');
  await revealPath(`${dateKey.slice(0, 7)}/attachments/${folder}`, false);
}

async function revealAttachment(dateKey, att) {
  if (!att?.target) return;
  if (/^https?:\/\//i.test(att.target)) {
    window.open(att.target, '_blank', 'noopener');
    return;
  }
  if (!attachmentFolderOf([att])) throw new Error('旧版 assets/ 附件不支持定位，请手动处理');
  await revealPath(`${dateKey.slice(0, 7)}/${att.target}`, true);
}

async function deleteAttachmentFiles(dateKey, targets, folderOverride = null) {
  const unique = [...new Set(targets || [])].filter((t) => t && !/^https?:\/\//i.test(t));
  for (const target of unique) {
    const path = folderOverride
      ? `attachments/${folderOverride}/${attachmentFileName(target)}`
      : target;
    try {
      await store.deleteAttachment(dateKey, path);
    } catch (err) {
      console.warn('删除附件失败', path, err);
    }
  }
}

/* ================= 路由与渲染 ================= */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, param] = raw.split('/');
  if (view === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(param || '')) {
    return { view: 'day', date: parseDateKey(param) };
  }
  if (view === 'week' && /^\d{4}-W\d{2}$/.test(param || '')) {
    const [year, week] = param.split('-W');
    return { view: 'week', date: dateFromIsoWeek(Number(year), Number(week)) };
  }
  if (view === 'month' && /^\d{4}-\d{2}$/.test(param || '')) {
    const [year, month] = param.split('-');
    return { view: 'month', date: new Date(Number(year), Number(month) - 1, 1) };
  }
  return { view: 'month', date: new Date() };
}

function route() {
  const { view, date } = parseRoute();
  state.view = view;
  state.anchor = date;
  render();
}

function go(view, date) {
  const path = view === 'day'
    ? `/day/${toDateKey(date)}`
    : view === 'week'
      ? `/week/${isoWeekKey(date)}`
      : `/month/${monthKey(date)}`;
  const hash = `#${path}`;
  if (location.hash === hash) {
    state.view = view;
    state.anchor = date;
    render();
  } else {
    location.hash = hash;
  }
}

function updateTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === state.view);
  });
}

function renderNotReady(root) {
  const message = store.configured
    ? `数据文件夹「${store.dataRoot || store.dirName}」不存在或无法访问，请重新选择。`
    : '选择一个文件夹作为数据目录。工具会在里面创建 YYYY-MM/YYYY-MM-DD.md，所有任务都保存在 Markdown 里。';

  root.replaceChildren(h('div', { class: 'empty-state' },
    h('h1', {}, '拾光 TODO'),
    h('p', {}, message),
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '18px' } },
      h('button', {
        type: 'button', class: 'pill-btn primary',
        onClick: () => showOnboarding(),
      }, '选择数据文件夹'),
    ),
    h('p', { class: 'onboarding-note', style: { marginTop: '18px' } },
      '路径由本地 server.py 保存；换文件夹后自动生效，刷新无需重复选择。'),
  ));
}

function renderServiceError(err) {
  const root = document.getElementById('view-root');
  root.replaceChildren(h('div', { class: 'empty-state' },
    h('h1', {}, '无法连接本地服务'),
    h('p', {}, err?.message || '请运行 python server.py 后刷新页面。'),
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '18px' } },
      h('button', { type: 'button', class: 'pill-btn', onClick: () => location.reload() }, '重试'),
    ),
  ));
}

async function render() {
  updateTabs();
  const root = document.getElementById('view-root');
  if (!store.ready) {
    renderNotReady(root);
    return;
  }

  const token = ++state.renderSeq;
  root.replaceChildren(h('div', { class: 'muted', style: { padding: '40px', textAlign: 'center' } }, '加载中…'));
  const container = h('div');

  try {
    if (state.view === 'day') await renderDay(ctx, container);
    else if (state.view === 'week') await renderWeek(ctx, container);
    else await renderMonth(ctx, container);
  } catch (err) {
    console.error(err);
    if (token === state.renderSeq) {
      root.replaceChildren(h('div', { class: 'empty-state' },
        h('h1', {}, '加载失败'),
        h('p', {}, err.message || String(err)),
        h('button', { type: 'button', class: 'pill-btn', onClick: () => render() }, '重试'),
      ));
    }
    return;
  }

  if (token !== state.renderSeq) return;
  root.replaceChildren(...container.childNodes);
  applyHighlight();
}

function applyHighlight() {
  if (!state.highlightTaskId) return;
  const id = state.highlightTaskId;
  state.highlightTaskId = null;
  const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add('flash');
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => card.classList.remove('flash'), 1600);
}

function refresh() {
  return render();
}

/* ================= 顶栏与初始化 ================= */

function bindTopbar() {
  document.getElementById('view-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    go(tab.dataset.view, new Date());
  });

  document.getElementById('btn-today').addEventListener('click', () => {
    go(state.view, new Date());
  });

  document.getElementById('btn-search').addEventListener('click', () => openSearch(ctx));

  document.getElementById('btn-clock').addEventListener('click', () => {
    if (clockController) clockController.open();
  });

  document.getElementById('btn-settings').addEventListener('click', openSettings);

  document.getElementById('btn-theme').addEventListener('click', () => {
    settings.theme = cycleTheme(settings.theme);
    saveSettings(settings);
    pushSharedSettings();
    applyTheme(settings.theme);
    toast(`主题：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[settings.theme]}`, { duration: 1600 });
  });

  document.getElementById('brand').addEventListener('click', () => go('month', new Date()));
}

function bindGlobalKeys() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"], .quick-add, .detail-panel, .search-overlay, .modal-backdrop')) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch(ctx);
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      openSearch(ctx);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key.toLowerCase()) {
      case 't':
        go(state.view, new Date());
        break;
      case 'd':
        go('day', new Date());
        break;
      case 'w':
        go('week', new Date());
        break;
      case 'm':
        go('month', new Date());
        break;
      case 'n': {
        const dateKey = state.view === 'month' ? toDateKey(new Date()) : toDateKey(state.anchor);
        const anchor = document.querySelector('.period-task-list')
          || document.getElementById('btn-today');
        openQuickAdd(ctx, anchor, { dateKey, period: 'morning' });
        break;
      }
      case 'arrowleft':
        if (state.view === 'day') go('day', addDays(state.anchor, -1));
        else if (state.view === 'week') go('week', addDays(state.anchor, -7));
        else go('month', new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1));
        break;
      case 'arrowright':
        if (state.view === 'day') go('day', addDays(state.anchor, 1));
        else if (state.view === 'week') go('week', addDays(state.anchor, 7));
        else go('month', new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1));
        break;
      default:
        break;
    }
  });
}

/* ================= 设置 ================= */

async function switchDirectory() {
  try {
    const result = await store.pickDirectory();
    if (result.canceled) return false;
    state.days.clear();
    state.loadedMonths.clear();
    state.dayPromises.clear();
    state.monthPromises.clear();
    state.allDays = null;
    state.allDaysAt = 0;
    state.overdueCache.clear();
    state.settingsMtime = null;
    await pullSharedSettings();
    toast(`已切换到「${store.dirName}」`);
    return true;
  } catch (err) {
    toast(`选择文件夹失败：${err.message}`, { type: 'error', duration: 6000 });
    return false;
  }
}

function openSettings() {
  const themeSelect = h('select', {},
    h('option', { value: 'auto', selected: settings.theme === 'auto' }, '跟随系统'),
    h('option', { value: 'light', selected: settings.theme === 'light' }, '浅色'),
    h('option', { value: 'dark', selected: settings.theme === 'dark' }, '深色'),
  );

  const zoomSelect = h('select', {},
    ZOOM_OPTIONS.map((z) => h('option', {
      value: String(z),
      selected: Number(settings.uiZoom) === z,
    }, z === 100 ? '100%（默认）' : `${z}%`)),
  );
  zoomSelect.addEventListener('change', () => applyZoom(Number(zoomSelect.value)));

  const leadSelect = h('select', {},
    [0, 5, 10, 15, 30].map((n) => h('option', {
      value: String(n),
      selected: Number(settings.reminderLead) === n,
    }, n === 0 ? '到点提醒' : `提前 ${n} 分钟`)),
  );

  const periodCheck = h('input', { type: 'checkbox', checked: settings.periodReminder });

  const catDraft = settings.categories.map((c) => ({ ...c }));
  const catList = h('div');

  const renderCats = () => {
    catList.replaceChildren();
    catDraft.forEach((cat, index) => {
      const nameInput = h('input', { type: 'text', value: cat.name });
      nameInput.addEventListener('input', () => { cat.name = nameInput.value; });
      const colorInput = h('input', { type: 'color', value: cat.color });
      colorInput.addEventListener('input', () => { cat.color = colorInput.value; });
      catList.append(h('div', { class: 'category-row' },
        colorInput,
        nameInput,
        h('button', {
          type: 'button', class: 'mini-btn',
          onClick: () => { catDraft.splice(index, 1); renderCats(); },
        }, '删除'),
      ));
    });
    catList.append(h('button', {
      type: 'button', class: 'mini-btn',
      onClick: () => {
        catDraft.push({ name: '新类别', color: '#94A3B8' });
        renderCats();
      },
    }, '＋ 添加类别'));
  };
  renderCats();

  const permState = ('Notification' in window) ? Notification.permission : 'unsupported';
  const permText = h('span', {}, permState === 'granted' ? '已授权' : permState === 'denied' ? '已被浏览器拒绝' : '未授权');
  const permButton = h('button', {
    type: 'button', class: 'mini-btn',
    onClick: async () => {
      const result = await requestNotificationPermission();
      permText.textContent = result === 'granted' ? '已授权' : result === 'denied' ? '已被浏览器拒绝' : '未授权';
      toast(result === 'granted' ? '通知已开启' : '通知未开启', { type: result === 'granted' ? 'info' : 'error' });
    },
  }, '授权通知');

  const dirLabel = h('span', {}, store.dirName || '未选择');
  const dirPath = h('span', { class: 'path-readonly' }, store.dataRoot || '未选择');
  const dirButton = h('button', {
    type: 'button', class: 'mini-btn',
    onClick: async () => {
      if (await switchDirectory()) {
        modal.close();
        render();
      }
    },
  }, '更换文件夹');

  const body = h('div', {},
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '数据文件夹'),
        dirLabel,
        dirPath,
      ),
      dirButton,
    ),
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '主题'),
        h('span', {}, '浅色纸张 / 深色 / 跟随系统'),
      ),
      themeSelect,
    ),
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '界面缩放'),
        h('span', {}, '放大或缩小整个界面，选择后立即预览'),
      ),
      zoomSelect,
    ),
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '任务提醒'),
        h('span', {}, '页面或置顶小窗开着时生效'),
      ),
      leadSelect,
    ),
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '时段任务提醒'),
        h('span', {}, '在上午/下午/晚上开始时提醒'),
      ),
      periodCheck,
    ),
    h('div', { class: 'settings-row' },
      h('div', { class: 'sr-label' },
        h('strong', {}, '桌面通知'),
        permText,
      ),
      permButton,
    ),
    h('div', { class: 'settings-row', style: { alignItems: 'flex-start' } },
      h('div', { class: 'sr-label' },
        h('strong', {}, '类别与颜色'),
        h('span', {}, '用于日历色块和任务卡左侧色条'),
        h('div', { style: { marginTop: '10px' } }, catList),
      ),
    ),
  );

  const modal = openModal({
    title: '设置',
    body,
    // 缩放是即时预览的：无论保存还是取消，关闭时都回落到已保存的值
    onClose: () => applyZoom(settings.uiZoom),
    footer: [
      h('button', { type: 'button', class: 'pill-btn', onClick: () => modal.close() }, '取消'),
      h('button', {
        type: 'button', class: 'pill-btn primary',
        onClick: () => {
          const cleaned = catDraft
            .map((c) => ({ name: c.name.trim(), color: c.color }))
            .filter((c) => c.name);
          const names = cleaned.map((c) => c.name);
          if (!cleaned.length) {
            toast('至少保留一个类别', { type: 'error' });
            return;
          }
          if (new Set(names).size !== names.length) {
            toast('类别名不能重复', { type: 'error' });
            return;
          }
          settings.theme = themeSelect.value;
          settings.uiZoom = Number(zoomSelect.value);
          settings.reminderLead = Number(leadSelect.value);
          settings.periodReminder = periodCheck.checked;
          settings.categories = cleaned;
          if (!names.includes(settings.lastCategory)) settings.lastCategory = names[0];
          saveSettings(settings);
          pushSharedSettings();
          applyTheme(settings.theme);
          modal.close();
          render();
        },
      }, '保存'),
    ],
  });
}

/* ================= 首次选择数据文件夹 ================= */

function showOnboarding() {
  const modal = openModal({
    title: '选择数据文件夹',
    body: h('div', {},
      h('p', { style: { margin: '0 0 10px', fontSize: '13px' } },
        '选择一个文件夹作为数据目录。建议选择本仓库的 todo-app/data，或任意你方便 Git 管理的文件夹。'),
      h('p', { class: 'onboarding-note', style: { margin: '0' } },
        '点击下方按钮会弹出系统文件夹对话框，绝对路径由本地 server.py 保存，之后无需再填写。'),
      h('p', { class: 'onboarding-note', style: { margin: '8px 0 0' } },
        '工具会自动创建 YYYY-MM/YYYY-MM-DD.md；附件会放进 YYYY-MM/attachments/<任务文件夹>/。所有数据只保存在本地，不会上传到任何服务器。'),
    ),
    footer: [
      h('button', {
        type: 'button', class: 'pill-btn',
        onClick: () => modal.close(),
      }, '稍后'),
      h('button', {
        type: 'button', class: 'pill-btn primary',
        onClick: async () => {
          if (await switchDirectory()) {
            modal.close();
            render();
          }
        },
      }, '选择文件夹'),
    ],
  });
}

/* ================= ctx ================= */

const ctx = {
  state,
  store,
  settings,
  saveSettings: () => {
    saveSettings(settings);
    pushSharedSettings();
  },
  go,
  refresh,
  loadDay,
  ensureMonth,
  scanAllDays,
  getOverdue,
  addTask,
  toggleTask,
  deleteTask,
  saveTask,
  moveTaskByDrag,
  rescheduleTask,
  rescheduleAllOverdue,
  attachmentUrl,
  revealTaskFolder,
  revealAttachment,
  deleteAttachmentFiles,
  openDetail: (dateKey, taskId) => openDetail(ctx, dateKey, taskId),
  openQuickAdd: (anchor, slot) => openQuickAdd(ctx, anchor, slot),
  toggleHideCompleted: () => { state.hideCompleted = !state.hideCompleted; render(); },
  highlightTask: (taskId) => { state.highlightTaskId = taskId; },
};

/* ================= 启动 ================= */

async function init() {
  bindTopbar();
  bindGlobalKeys();
  window.addEventListener('hashchange', route);

  let status;
  try {
    status = await store.restore();
  } catch (err) {
    console.error(err);
    renderServiceError(err);
    return;
  }
  if (!status.configured || !status.exists) showOnboarding();

  await pullSharedSettings();
  route();
  startReminders(ctx);
  clockController = initClock(ctx);
}

init().catch((err) => {
  console.error(err);
  toast(`启动失败：${err.message}`, { type: 'error', duration: 8000 });
});

// 便于调试
window.__shiguang = { state, store, settings, ctx };
