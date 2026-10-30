// 月视图：7 列日历、完成状态红点、任务预览。

import { h } from '../ui.js';
import {
  addDays, daysInMonth, formatDateShort, isToday, isoWeek, monthKey,
  startOfMonth, startOfWeek, toDateKey, WEEKDAYS,
} from '../date.js';
import { categoryColor } from '../settings.js';

export async function renderMonth(ctx, root) {
  const anchor = ctx.state.anchor;
  const month = monthKey(anchor);
  await ctx.ensureMonth(month);

  const monthDate = startOfMonth(anchor);
  const gridStart = startOfWeek(monthDate);
  const leading = (monthDate.getDay() + 6) % 7;
  const rows = Math.ceil((leading + daysInMonth(monthDate)) / 7);
  const cells = Array.from({ length: rows * 7 }, (_, i) => addDays(gridStart, i));

  let busyDays = 0;
  let unfinishedTotal = 0;
  for (const date of cells) {
    if (monthKey(date) !== month) continue;
    const day = ctx.state.days.get(toDateKey(date));
    if (!day) continue;
    const unfinished = day.tasks.filter((t) => !t.done);
    if (day.tasks.length) busyDays += 1;
    unfinishedTotal += unfinished.length;
  }

  const head = h('div', { class: 'view-head' },
    h('div', {},
      h('h1', { class: 'view-title' }, `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`),
      h('div', { class: 'view-sub' }, `${busyDays} 天有任务 · ${unfinishedTotal} 项未完成`),
    ),
    h('div', { class: 'head-actions' },
      h('button', {
        type: 'button', class: 'nav-btn', title: '上个月',
        onClick: () => ctx.go('month', new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)),
      }, '‹'),
      h('button', {
        type: 'button', class: 'pill-btn',
        onClick: () => ctx.go('month', new Date()),
      }, '今天'),
      h('button', {
        type: 'button', class: 'nav-btn', title: '下个月',
        onClick: () => ctx.go('month', new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)),
      }, '›'),
    ),
  );

  const weekdayRow = h('div', { class: 'weekday-row' },
    h('span', { class: 'week-col-head', title: 'ISO 周数' }, '周'),
    WEEKDAYS.map((name, i) => h('span', { class: i >= 5 ? 'weekend' : '' }, name)),
  );

  const grid = h('div', { class: 'month-cells' });
  for (let row = 0; row < rows; row++) {
    const weekStart = addDays(gridStart, row * 7);
    const weekEnd = addDays(weekStart, 6);
    const { week } = isoWeek(weekStart);
    grid.append(h('button', {
      type: 'button',
      class: 'week-number-cell',
      title: `${formatDateShort(weekStart)} – ${formatDateShort(weekEnd)}`,
      'aria-label': `查看第 ${week} 周`,
      onClick: () => ctx.go('week', weekStart),
    }, `W${String(week).padStart(2, '0')}`));

    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const key = toDateKey(date);
      const day = ctx.state.days.get(key);
      const tasks = day ? day.tasks : [];
      const unfinished = tasks.filter((t) => !t.done);
      const hasHigh = unfinished.some((t) => t.priority === '高');
      const outside = monthKey(date) !== month;

      const cell = h('button', {
        type: 'button',
        class: `month-cell ${outside ? 'outside' : ''} ${isToday(date) ? 'today' : ''}`,
        onClick: () => ctx.go('day', date),
        'aria-label': `${key} ${WEEKDAYS[(date.getDay() + 6) % 7]}`,
      });

      const top = h('div', { class: 'month-cell-top' });
      top.append(h('span', { class: 'month-date' }, String(date.getDate())));
      if (tasks.length) {
        if (unfinished.length === 0) {
          top.append(h('span', { class: 'month-dot done', title: '全部完成' }));
        } else {
          top.append(h('span', {
            class: `month-dot ${hasHigh ? 'high pulse' : ''}`,
            title: hasHigh ? `${unfinished.length} 项未完成，含高优先级` : `${unfinished.length} 项未完成`,
          }));
        }
      }
      cell.append(top);

      if (tasks.length) {
        const preview = h('div', { class: 'month-preview' });
        const ordered = [...tasks].sort((a, b) => {
          if (a.done === b.done) return 0;
          return a.done ? 1 : -1;
        });
        for (const task of ordered.slice(0, 3)) {
          preview.append(h('div', { class: `preview-item ${task.done ? 'done' : ''}` },
            h('span', {
              class: 'cat-line',
              style: { background: categoryColor(ctx.settings, task.category) },
            }),
            h('span', {}, task.title),
          ));
        }
        if (ordered.length > 3) {
          preview.append(h('div', { class: 'month-more' }, `+${ordered.length - 3}`));
        }
        cell.append(preview);
      }

      grid.append(cell);
    }
  }

  root.replaceChildren(
    h('div', { class: 'month-view' },
      head,
      h('div', { class: 'month-grid' }, weekdayRow, grid),
    ),
  );
}
