// 周视图：7 天 × 3 时段，7 列共享行高；每格是任务列表和投放区。

import { h } from '../ui.js';
import {
  addDays, isToday, isoWeek, monthKey, periodOfTask, PERIODS,
  startOfWeek, toDateKey, WEEKDAYS,
} from '../date.js';
import { renderTaskCard, openQuickAdd, attachDropZone } from './common.js';

export async function renderWeek(ctx, root) {
  const anchor = ctx.state.anchor;
  const weekStart = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const months = new Set(days.map((d) => monthKey(d)));
  await Promise.all([...months].map((m) => ctx.ensureMonth(m)));

  const weekEnd = days[6];
  const { week } = isoWeek(weekStart);
  const rangeLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${weekStart.getMonth() + 1}月${weekStart.getDate()}日 – ${weekEnd.getMonth() + 1}月${weekEnd.getDate()}日`
    : `${weekStart.getFullYear()}年${weekStart.getMonth() + 1}月${weekStart.getDate()}日 – ${weekEnd.getFullYear()}年${weekEnd.getMonth() + 1}月${weekEnd.getDate()}日`;

  const head = h('div', { class: 'view-head' },
    h('div', {},
      h('h1', { class: 'view-title' }, `第 ${week} 周`),
      h('div', { class: 'view-sub' }, rangeLabel),
    ),
    h('div', { class: 'head-actions' },
      h('button', {
        type: 'button', class: 'nav-btn', title: '上一周',
        onClick: () => ctx.go('week', addDays(anchor, -7)),
      }, '‹'),
      h('button', {
        type: 'button', class: 'pill-btn',
        onClick: () => ctx.go('week', new Date()),
      }, '本周'),
      h('button', {
        type: 'button', class: 'nav-btn', title: '下一周',
        onClick: () => ctx.go('week', addDays(anchor, 7)),
      }, '›'),
    ),
  );

  const board = h('div', { class: 'week-board' });

  // 第一行：7 个日期表头，点击进入对应日视图
  for (const date of days) {
    const dateKey = toDateKey(date);
    const today = isToday(date);
    const goDay = () => ctx.go('day', date);
    board.append(h('div', {
      class: `week-day-head ${today ? 'today' : ''}`,
      dataset: { date: dateKey },
      role: 'button',
      tabindex: '0',
      title: `查看 ${dateKey} 的日视图`,
      onClick: goDay,
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          goDay();
        }
      },
    },
      h('div', { class: 'wd-name' }, WEEKDAYS[(date.getDay() + 6) % 7]),
      h('div', { class: 'wd-date' }, String(date.getDate())),
    ));
  }

  // 第 2-4 行：按 上午 → 下午 → 晚上 排列，每行 7 天
  for (const period of PERIODS) {
    for (const date of days) {
      const dateKey = toDateKey(date);
      const today = isToday(date);
      const day = ctx.state.days.get(dateKey);
      const allTasks = day ? day.tasks : [];
      const visible = allTasks.filter((t) => !(ctx.state.hideCompleted && t.done));
      const periodAll = allTasks.filter((t) => periodOfTask(t) === period.key);
      const periodVisible = visible.filter((t) => periodOfTask(t) === period.key);
      const unfinished = periodAll.filter((t) => !t.done).length;

      const cell = h('div', {
        class: `period-cell ${period.key} ${today ? 'today' : ''}`,
        dataset: { date: dateKey, period: period.key },
      });

      cell.append(h('div', { class: 'period-label' },
        h('b', {}, period.label),
        h('span', { class: 'cell-count' }, periodAll.length ? `${unfinished}/${periodAll.length}` : ''),
      ));

      const list = h('div', { class: 'period-task-list' });
      attachDropZone(ctx, list, { dateKey, period: period.key });

      for (const task of periodVisible) {
        list.append(renderTaskCard(ctx, task, dateKey, { compact: true }));
      }

      const addBtn = h('button', {
        type: 'button',
        class: 'add-task-btn compact',
        title: `在 ${dateKey} ${period.label} 添加任务`,
        onClick: (event) => {
          event.stopPropagation();
          openQuickAdd(ctx, addBtn, { dateKey, period: period.key });
        },
      }, '＋');
      list.append(addBtn);

      list.addEventListener('click', (event) => {
        if (event.target.closest('.task-card, .add-task-btn')) return;
        openQuickAdd(ctx, addBtn, { dateKey, period: period.key });
      });

      cell.append(list);
      board.append(cell);
    }
  }

  root.replaceChildren(h('div', { class: 'week-view' }, head, h('div', { class: 'week-board-wrap' }, board)));
}
