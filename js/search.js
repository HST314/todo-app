// 全局搜索命令面板：跨所有日文件搜索任务、备注、附件。

import { h, toast } from './ui.js';
import { categoryColor } from './settings.js';
import { parseDateKey, weekdayLabel } from './date.js';
import { timeLabel } from './markdown.js';

export function openSearch(ctx) {
  document.querySelectorAll('.search-overlay').forEach((node) => node.remove());
  if (!ctx.store.ready) {
    toast('请先选择数据文件夹', { type: 'error' });
    return;
  }

  const input = h('input', {
    type: 'text',
    placeholder: '搜索任务、备注、附件…',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const categoryFilter = h('select', { title: '类别' },
    h('option', { value: '' }, '全部类别'),
    ctx.settings.categories.map((c) => h('option', { value: c.name }, c.name)),
  );
  const priorityFilter = h('select', { title: '优先级' },
    h('option', { value: '' }, '全部优先级'),
    ['高', '中', '低'].map((p) => h('option', { value: p }, `!${p}`)),
  );
  const statusFilter = h('select', { title: '状态' },
    h('option', { value: '' }, '全部状态'),
    h('option', { value: 'open' }, '未完成'),
    h('option', { value: 'done' }, '已完成'),
  );
  const countLabel = h('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11px' } }, '');

  const resultsEl = h('div', { class: 'search-results' },
    h('div', { class: 'search-empty' }, '正在读取所有日文件…'),
  );

  let allItems = [];
  let filtered = [];
  let active = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const formatGroup = (dateKey) => {
    const date = parseDateKey(dateKey);
    return `${dateKey} ${weekdayLabel(date)}`;
  };

  const matches = (item, query) => {
    const task = item.task;
    const haystack = [
      task.title,
      task.notes,
      ...(task.attachments || []).flatMap((att) => [att.label, att.target]),
    ].join('\n').toLowerCase();
    return haystack.includes(query);
  };

  const updateActiveClasses = () => {
    resultsEl.querySelectorAll('.search-result').forEach((node, index) => {
      node.classList.toggle('active', index === active);
    });
    const activeNode = resultsEl.querySelectorAll('.search-result')[active];
    if (activeNode) activeNode.scrollIntoView({ block: 'nearest' });
  };

  const choose = (item) => {
    if (!item) return;
    close();
    ctx.highlightTask(item.task.id);
    ctx.go('day', parseDateKey(item.dateKey));
  };

  const renderResults = () => {
    resultsEl.replaceChildren();
    countLabel.textContent = `${filtered.length} 条`;
    if (!filtered.length) {
      resultsEl.append(h('div', { class: 'search-empty' }, '没有匹配的任务'));
      return;
    }
    let lastDate = null;
    filtered.forEach((item, index) => {
      if (item.dateKey !== lastDate) {
        lastDate = item.dateKey;
        resultsEl.append(h('div', { class: 'search-group-title' }, formatGroup(item.dateKey)));
      }
      const row = h('div', {
        class: `search-result ${index === active ? 'active' : ''}`,
        style: { '--cat-color': categoryColor(ctx.settings, item.task.category) },
      },
        h('span', { class: 'sr-dot' }),
        h('span', {
          class: 'sr-title',
          style: item.task.done ? { textDecoration: 'line-through', opacity: '0.55' } : null,
        }, item.task.title || '（无标题）'),
        h('span', { class: 'sr-date' },
          `${timeLabel(item.task.time)} · ${item.task.category}${item.task.priority !== '中' ? ` · !${item.task.priority}` : ''}`),
      );
      row.addEventListener('click', () => choose(item));
      row.addEventListener('mouseenter', () => { active = index; updateActiveClasses(); });
      resultsEl.append(row);
    });
  };

  const runFilter = () => {
    const query = input.value.trim().toLowerCase();
    filtered = allItems.filter((item) => {
      if (query && !matches(item, query)) return false;
      if (categoryFilter.value && item.task.category !== categoryFilter.value) return false;
      if (priorityFilter.value && item.task.priority !== priorityFilter.value) return false;
      if (statusFilter.value === 'open' && item.task.done) return false;
      if (statusFilter.value === 'done' && !item.task.done) return false;
      return true;
    });
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
    renderResults();
  };

  const buildIndex = async () => {
    try {
      const days = await ctx.scanAllDays();
      allItems = [];
      for (const day of days) {
        day.tasks.forEach((task, index) => {
          allItems.push({ dateKey: day.dateKey, task, index });
        });
      }
      allItems.sort((a, b) => {
        const byDate = b.dateKey.localeCompare(a.dateKey);
        if (byDate !== 0) return byDate;
        return a.index - b.index;
      });
      runFilter();
    } catch (err) {
      resultsEl.replaceChildren(h('div', { class: 'search-empty' }, `读取失败：${err.message}`));
    }
  };

  const box = h('div', { class: 'search-box' },
    h('div', { class: 'search-input-row' },
      h('span', { style: { color: 'var(--muted)', fontSize: '14px' } }, '⌕'),
      input,
      h('span', { class: 'search-kbd' }, 'Esc'),
      h('button', {
        type: 'button',
        class: 'icon-btn search-close',
        title: '关闭 (Esc)',
        'aria-label': '关闭搜索',
        onClick: () => close(),
      }, '✕'),
    ),
    h('div', { class: 'search-filters' },
      categoryFilter,
      priorityFilter,
      statusFilter,
      countLabel,
    ),
    resultsEl,
  );

  const overlay = h('div', {
    class: 'search-overlay',
    onClick: (event) => {
      if (event.target === overlay) close();
    },
  }, box);

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, Math.max(0, filtered.length - 1));
      updateActiveClasses();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      updateActiveClasses();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(filtered[active]);
    }
  };

  input.addEventListener('input', () => { active = 0; runFilter(); });
  categoryFilter.addEventListener('change', () => { active = 0; runFilter(); });
  priorityFilter.addEventListener('change', () => { active = 0; runFilter(); });
  statusFilter.addEventListener('change', () => { active = 0; runFilter(); });

  document.getElementById('overlay-root').append(overlay);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => input.focus(), 30);
  buildIndex();
}
