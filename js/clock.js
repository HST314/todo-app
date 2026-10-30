// 桌面置顶时钟：Document Picture-in-Picture + 普通弹窗降级。

import { toast } from './ui.js';
import {
  hhmmToMinutes, PERIOD_LABEL, periodOfMinutes, periodOfTask, toDateKey, weekdayLabel,
} from './date.js';

const COMPACT_KEY = 'shiguang.clockCompact';

export function initClock(ctx) {
  const root = document.getElementById('clock-root');
  const timeEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('clock-date');
  const weekdayEl = document.getElementById('clock-weekday');
  const progressEl = document.getElementById('clock-progress-text');
  const nextEl = document.getElementById('clock-next');
  const collapseBtn = document.getElementById('clock-collapse');
  const expandBtn = document.getElementById('clock-expand');

  let timer = null;
  let currentWindow = null;
  let compact = localStorage.getItem(COMPACT_KEY) === '1';
  let loadingToday = false;

  const applyCompact = (value) => {
    compact = value;
    localStorage.setItem(COMPACT_KEY, compact ? '1' : '0');
    root.classList.toggle('compact', compact);
    collapseBtn.hidden = compact;
    expandBtn.hidden = !compact;
    if (currentWindow && !currentWindow.closed) {
      try {
        currentWindow.resizeTo(compact ? 300 : 360, compact ? 130 : 210);
      } catch {
        // 某些浏览器不允许 resize，忽略
      }
    }
  };

  const update = async () => {
    const now = new Date();
    timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
    weekdayEl.textContent = weekdayLabel(now);

    if (currentWindow && !currentWindow.closed) {
      currentWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    }

    const todayKey = toDateKey(now);
    if (!ctx.state.days.has(todayKey) && !loadingToday && ctx.store.ready) {
      loadingToday = true;
      ctx.loadDay(todayKey).then(() => {
        loadingToday = false;
        update();
      }).catch(() => { loadingToday = false; });
    }

    const day = ctx.state.days.get(todayKey);
    const tasks = day ? day.tasks : [];
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    progressEl.textContent = `${done} / ${total}`;

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const upcoming = tasks
      .filter((t) => !t.done && t.time.type === 'exact')
      .map((t) => ({
        task: t,
        start: hhmmToMinutes(t.time.start) ?? 0,
        end: t.time.end ? hhmmToMinutes(t.time.end) : null,
      }))
      .sort((a, b) => a.start - b.start);

    const running = upcoming.find((item) => item.start <= nowMinutes && item.end != null && item.end > nowMinutes);
    const next = upcoming.find((item) => item.start >= nowMinutes);
    const remaining = tasks.filter((t) => !t.done).length;
    const currentPeriod = periodOfMinutes(nowMinutes);
    const currentRemaining = tasks.filter((t) => periodOfTask(t) === currentPeriod && !t.done).length;

    if (running) {
      nextEl.textContent = `进行中 · ${running.task.title}`;
    } else if (next) {
      const diff = next.start - nowMinutes;
      nextEl.textContent = `下一项 ${String(Math.floor(next.start / 60)).padStart(2, '0')}:${String(next.start % 60).padStart(2, '0')} ${next.task.title} · ${diff <= 0 ? '现在' : `还有 ${diff} 分钟`}`;
    } else if (currentRemaining > 0) {
      nextEl.textContent = `当前 ${PERIOD_LABEL[currentPeriod]} · ${currentRemaining} 项未完成`;
    } else if (remaining > 0) {
      nextEl.textContent = `当前时段已清空 · 今天还有 ${remaining} 项`;
    } else if (total > 0) {
      nextEl.textContent = '今天全部完成 🎉';
    } else {
      nextEl.textContent = '今天暂无待办';
    }
  };

  const startTimer = () => {
    clearInterval(timer);
    update();
    timer = setInterval(update, 1000);
  };

  const restoreRoot = () => {
    clearInterval(timer);
    timer = null;
    if (root.parentElement !== document.body) document.body.append(root);
    root.hidden = true;
    currentWindow = null;
  };

  const setupWindow = (win, pip) => {
    currentWindow = win;
    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('css/style.css', location.href).href;
    win.document.head.append(link);
    win.document.title = '拾光时钟';
    win.document.documentElement.lang = 'zh-CN';
    win.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    win.document.documentElement.style.height = '100%';
    win.document.body.style.margin = '0';
    win.document.body.style.height = '100%';
    win.document.body.style.overflow = 'hidden';

    win.document.body.append(root);
    root.hidden = false;
    root.classList.toggle('compact', compact);
    collapseBtn.hidden = compact;
    expandBtn.hidden = !compact;

    win.addEventListener('pagehide', () => {
      if (currentWindow === win) restoreRoot();
    });

    startTimer();
    if (!pip) {
      toast('当前浏览器不支持置顶画中画，已打开普通窗口（无法置顶）', { duration: 5000 });
    }
  };

  const open = async () => {
    if (currentWindow && !currentWindow.closed) {
      try { currentWindow.focus(); } catch { /* ignore */ }
      return;
    }

    if ('documentPictureInPicture' in window) {
      try {
        const win = await window.documentPictureInPicture.requestWindow({ width: 360, height: 210 });
        setupWindow(win, true);
        return;
      } catch (err) {
        console.warn('PiP 打开失败，降级为普通窗口', err);
      }
    }

    const win = window.open('', 'shiguang-clock', 'width=360,height=210,menubar=no,toolbar=no,location=no,status=no');
    if (!win) {
      toast('弹窗被浏览器拦截，请允许弹出窗口', { type: 'error' });
      return;
    }
    win.document.open();
    win.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body></body></html>');
    win.document.close();
    setupWindow(win, false);
  };

  const close = () => {
    const win = currentWindow;
    if (win && !win.closed) {
      try { win.close(); } catch { /* ignore */ }
    }
    restoreRoot();
  };

  collapseBtn.addEventListener('click', () => applyCompact(true));
  expandBtn.addEventListener('click', () => applyCompact(false));
  applyCompact(compact);
  update();

  return { open, close, update };
}
