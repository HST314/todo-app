// 日视图：上午/下午/晚上三个容器，卡片纵向排列，支持拖动换段/排序。

import { h } from '../ui.js';
import {
  addDays, isoWeek, periodOfTask, PERIODS, toDateKey, WEEKDAYS,
} from '../date.js';
import { renderTaskCard, openQuickAdd, attachDropZone } from './common.js';

export async function renderDay(ctx, root) {
  const date = ctx.state.anchor;
  const dateKey = toDateKey(date);
  const day = await ctx.loadDay(dateKey);
  const overdue = await ctx.getOverdue(dateKey);
  const { week } = isoWeek(date);

  const allTasks = day.tasks;
  const visibleTasks = allTasks.filter((t) => !(ctx.state.hideCompleted && t.done));

  const head = h('div', { class: 'view-head' },
    h('div', {},
      h('h1', { class: 'view-title' }, `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[(date.getDay() + 6) % 7]}`),
      h('div', { class: 'view-sub' }, `${date.getFullYear()}年 · 第 ${week} 周`),
    ),
    h('div', { class: 'head-actions' },
      h('button', {
        type: 'button', class: 'nav-btn', title: '前一天',
        onClick: () => ctx.go('day', addDays(date, -1)),
      }, '‹'),
      h('button', {
        type: 'button', class: 'pill-btn',
        onClick: () => ctx.go('day', new Date()),
      }, '今天'),
      h('button', {
        type: 'button', class: 'nav-btn', title: '后一天',
        onClick: () => ctx.go('day', addDays(date, 1)),
      }, '›'),
      h('button', {
        type: 'button', class: 'pill-btn',
        onClick: () => ctx.toggleHideCompleted(),
      }, ctx.state.hideCompleted ? '显示已完成' : '隐藏已完成'),
    ),
  );

  const sections = [];

  if (overdue.length) {
    const list = h('div', { class: 'overdue-list' });
    for (const item of overdue.slice(0, 8)) {
      const row = h('div', { class: 'overdue-item' },
        h('span', { class: 'od-date' }, item.dateKey.slice(5)),
        h('span', { class: 'od-title' }, item.task.title),
      );
      row.append(
        h('button', {
          type: 'button', class: 'mini-btn',
          onClick: () => ctx.rescheduleTask(item.dateKey, item.task.id, dateKey),
        }, '改到今天'),
        h('button', {
          type: 'button', class: 'mini-btn',
          onClick: () => ctx.rescheduleTask(item.dateKey, item.task.id, toDateKey(addDays(date, 1))),
        }, '改到明天'),
      );
      list.append(row);
    }
    sections.push(h('div', { class: 'overdue-panel' },
      h('div', { class: 'overdue-head' },
        h('h3', {}, `逾期未完成 · ${overdue.length} 项`),
        h('div', { class: 'spacer' }),
        h('button', {
          type: 'button', class: 'mini-btn',
          onClick: () => ctx.rescheduleAllOverdue(dateKey, overdue),
        }, '全部改到今天'),
      ),
      list,
      overdue.length > 8 ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } }, `仅显示前 8 项，共 ${overdue.length} 项`) : null,
    ));
  }

  const columns = h('div', { class: 'day-columns' });

  for (const period of PERIODS) {
    const periodAll = allTasks.filter((t) => periodOfTask(t) === period.key);
    const visible = visibleTasks.filter((t) => periodOfTask(t) === period.key);
    const unfinished = periodAll.filter((t) => !t.done).length;

    const column = h('div', { class: `day-column ${period.key}` });
    column.append(h('div', { class: 'column-head' },
      h('h3', {}, period.label),
      h('span', { class: 'range' }, period.key === 'morning' ? '06:00–11:59' : period.key === 'afternoon' ? '12:00–17:59' : '18:00–05:59'),
      h('span', { class: 'count' }, `${unfinished} 未完成 / ${periodAll.length}`),
    ));

    const list = h('div', { class: 'period-task-list' });
    attachDropZone(ctx, list, { dateKey, period: period.key });

    for (const task of visible) {
      list.append(renderTaskCard(ctx, task, dateKey));
    }

    const addBtn = h('button', {
      type: 'button',
      class: 'add-task-btn',
      onClick: (event) => {
        event.stopPropagation();
        openQuickAdd(ctx, addBtn, { dateKey, period: period.key });
      },
    }, '＋ 添加任务');
    list.append(addBtn);

    list.addEventListener('click', (event) => {
      if (event.target.closest('.task-card, .add-task-btn')) return;
      openQuickAdd(ctx, addBtn, { dateKey, period: period.key });
    });

    column.append(list);
    columns.append(column);
  }

  sections.push(columns);
  root.replaceChildren(h('div', { class: 'day-view' }, head, sections));
}
