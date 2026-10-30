// 任务提醒：仅在页面/置顶小窗开着时生效。

import { hhmmToMinutes, parseDateKey, PERIODS, toDateKey } from './date.js';
import { timeLabel } from './markdown.js';
import { toast } from './ui.js';

const REMINDED_PREFIX = 'shiguang.reminded.';

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

function loadReminded(dateKey) {
  try {
    return new Set(JSON.parse(localStorage.getItem(REMINDED_PREFIX + dateKey) || '[]'));
  } catch {
    return new Set();
  }
}

function saveReminded(dateKey, set) {
  localStorage.setItem(REMINDED_PREFIX + dateKey, JSON.stringify([...set]));
}

function fire(task, label, dateKey, ctx) {
  const body = `${label} · ${task.title}`;
  const meta = `${task.category}${task.priority !== '中' ? ` · !${task.priority}` : ''}`;

  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification('任务提醒', {
        body: `${body}\n${meta}`,
        tag: `shiguang-${dateKey}-${task.id}`,
        silent: false,
      });
      notification.onclick = () => {
        window.focus();
        ctx.go('day', parseDateKey(dateKey));
        notification.close();
      };
    }
  } catch (err) {
    console.warn('系统通知失败', err);
  }

  toast(`⏰ ${body}`, {
    duration: 9000,
    actionLabel: '查看',
    onAction: () => ctx.go('day', parseDateKey(dateKey)),
  });
}

export function startReminders(ctx) {
  let checking = false;

  const check = async () => {
    if (checking) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!ctx.store.ready) return;
    checking = true;
    try {
      const now = new Date();
      const todayKey = toDateKey(now);
      const day = await ctx.loadDay(todayKey);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const lead = Number(ctx.settings.reminderLead) || 0;
      const reminded = loadReminded(todayKey);

      for (const task of day.tasks) {
        if (task.done) continue;

        let start = null;
        let label = '';
        if (task.time.type === 'exact') {
          start = hhmmToMinutes(task.time.start);
          label = timeLabel(task.time);
        } else if (ctx.settings.periodReminder && task.time.type === 'period') {
          const period = PERIODS.find((p) => p.key === task.time.period);
          if (!period) continue;
          start = period.start;
          label = period.label;
        } else {
          continue;
        }
        if (start == null || !Number.isFinite(start)) continue;

        const trigger = start - lead;
        const key = `${task.id}:${trigger}`;
        if (reminded.has(key)) continue;

        // 触发窗口：到触发点之后，但任务开始 5 分钟后就不再补报
        if (nowMinutes < trigger) continue;
        if (nowMinutes > start + 5) {
          reminded.add(key);
          saveReminded(todayKey, reminded);
          continue;
        }

        reminded.add(key);
        saveReminded(todayKey, reminded);
        fire(task, label, todayKey, ctx);
      }
    } catch (err) {
      console.warn('提醒检查失败', err);
    } finally {
      checking = false;
    }
  };

  check();
  const timer = setInterval(check, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });

  return () => clearInterval(timer);
}
