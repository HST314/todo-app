// 三个视图共享：任务卡片、拖动、速记弹层、任务详情面板。

import { h, openModal, toast, confirmDialog } from '../ui.js';
import { createTask, timeLabel, fileName } from '../markdown.js';
import { categoryColor } from '../settings.js';
import { PERIOD_LABEL, hhmmToMinutes, periodOfMinutes, periodOfTask } from '../date.js';
import { attachmentFolderOf, makeTaskFolderName } from '../store.js';

const PRIORITY_CLASS = { 高: 'high', 中: 'medium', 低: 'low' };

export function priorityClass(priority) {
  return PRIORITY_CLASS[priority] || 'medium';
}

/* ================= 拖动 ================= */

const DRAG_THRESHOLD = 5;

let dragState = null;
let dropTarget = null;

function clearDropFeedback() {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.task-card.dragging').forEach((el) => el.classList.remove('dragging'));
  document.querySelectorAll('.drag-ghost').forEach((el) => el.remove());
  document.body.classList.remove('is-dragging');
}

function computeDropIndex(listEl, clientY) {
  const cards = [...listEl.querySelectorAll(':scope > .task-card:not(.dragging)')];
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function moveIndicator(listEl, index) {
  let indicator = listEl.querySelector(':scope > .drop-indicator');
  if (!indicator) indicator = h('div', { class: 'drop-indicator' });
  const cards = [...listEl.querySelectorAll(':scope > .task-card:not(.dragging)')];
  const before = cards[index] || listEl.querySelector(':scope > .add-task-btn') || null;
  if (before) listEl.insertBefore(indicator, before);
  else listEl.append(indicator);
}

function positionGhost(event) {
  if (!dragState?.ghost) return;
  const ghost = dragState.ghost;
  const width = ghost.offsetWidth || 220;
  const height = ghost.offsetHeight || 48;
  const left = Math.min(event.clientX + 14, window.innerWidth - width - 8);
  const top = Math.min(event.clientY + 10, window.innerHeight - height - 8);
  ghost.style.left = `${Math.max(8, left)}px`;
  ghost.style.top = `${Math.max(8, top)}px`;
}

function updateDropTarget(event) {
  const el = document.elementFromPoint(event.clientX, event.clientY);
  const container = el?.closest('.period-cell, .day-column');
  const listEl = container?.querySelector('.period-task-list');

  if (!listEl || !listEl.dataset.dropDate) {
    document.querySelectorAll('.period-task-list.drop-target').forEach((el2) => {
      el2.classList.remove('drop-target');
      el2.querySelector(':scope > .drop-indicator')?.remove();
    });
    dropTarget = null;
    return;
  }

  document.querySelectorAll('.period-task-list.drop-target').forEach((el2) => {
    if (el2 !== listEl) {
      el2.classList.remove('drop-target');
      el2.querySelector(':scope > .drop-indicator')?.remove();
    }
  });
  listEl.classList.add('drop-target');
  const index = computeDropIndex(listEl, event.clientY);
  moveIndicator(listEl, index);
  dropTarget = {
    listEl,
    index,
    dateKey: listEl.dataset.dropDate,
    period: listEl.dataset.dropPeriod,
  };
}

function swallowNextClick() {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('click', swallow, true);
  setTimeout(() => document.removeEventListener('click', swallow, true), 80);
}

function finishDrag(drop) {
  if (!dragState) return;
  const state = dragState;
  const target = drop ? dropTarget : null;
  const wasActive = state.active;

  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerCancel, true);
  document.removeEventListener('keydown', onDragKey, true);

  if (wasActive) swallowNextClick();
  state.card._justDragged = wasActive;
  clearDropFeedback();
  dragState = null;
  dropTarget = null;
  if (wasActive) setTimeout(() => { state.card._justDragged = false; }, 120);

  if (wasActive && target) {
    state.ctx.moveTaskByDrag({
      fromDate: state.dateKey,
      taskId: state.taskId,
      toDate: target.dateKey,
      toPeriod: target.period,
      toIndex: target.index,
    });
  }
}

function beginDrag(event) {
  const state = dragState;
  state.active = true;
  state.card.classList.add('dragging');
  document.body.classList.add('is-dragging');

  const rect = state.card.getBoundingClientRect();
  const ghost = state.card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('dragging');
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  state.ghost = ghost;
  positionGhost(event);
}

function onPointerMove(event) {
  if (!dragState) return;
  if (!dragState.active) {
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    beginDrag(event);
  }
  event.preventDefault();
  positionGhost(event);
  updateDropTarget(event);
}

function onPointerUp(event) {
  if (!dragState) return;
  if (dragState.active) {
    updateDropTarget(event);
    finishDrag(true);
  } else {
    finishDrag(false);
  }
}

function onPointerCancel() {
  finishDrag(false);
}

function onDragKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    finishDrag(false);
  }
}

export function attachDropZone(ctx, listEl, { dateKey, period }) {
  // 投放目标通过 elementFromPoint 定位，这里只记录归属信息
  listEl.dataset.dropDate = dateKey;
  listEl.dataset.dropPeriod = period;
}

function bindCardDrag(ctx, card, dateKey, task) {
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.task-check, .add-task-btn')) return;
    if (dragState) return;

    dragState = {
      ctx,
      dateKey,
      taskId: task.id,
      card,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      ghost: null,
    };
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    document.addEventListener('keydown', onDragKey, true);
  });
}

/* ================= 任务卡片 ================= */

export function renderTaskCard(ctx, task, dateKey, { compact = false, flash = false } = {}) {
  const color = categoryColor(ctx.settings, task.category);
  const cls = [
    'task-card',
    `priority-${priorityClass(task.priority)}`,
    task.done ? 'done' : '',
    flash ? 'flash' : '',
    compact ? 'compact' : '',
  ].filter(Boolean).join(' ');

  const card = h('div', {
    class: cls,
    dataset: { taskId: task.id, dateKey },
    style: { '--cat-color': color },
    title: `${timeLabel(task.time)} · ${task.title}${task.notes ? `\n${task.notes}` : ''}`,
  });

  const check = h('button', {
    type: 'button',
    class: `task-check ${task.done ? 'checked' : ''}`,
    title: task.done ? '标为未完成' : '标为完成',
    'aria-checked': task.done ? 'true' : 'false',
  }, task.done ? '✓' : '');
  check.addEventListener('click', async (event) => {
    event.stopPropagation();
    await ctx.toggleTask(dateKey, task.id);
  });

  const meta = h('div', { class: 'task-meta' });
  if (task.time.type === 'exact') {
    meta.append(h('span', { class: 'task-time' }, timeLabel(task.time)));
  }
  if (!compact && task.category) {
    meta.append(h('span', { class: 'cat-chip', style: { '--cat-color': color } }, task.category));
  }
  if (task.priority && task.priority !== '中') {
    meta.append(h('span', { class: 'pri-chip' }, `!${task.priority}`));
  }
  if (task.attachments && task.attachments.length) {
    meta.append(h('span', { class: 'attach-mark' }, `📎 ${task.attachments.length}`));
  }

  const body = h('div', { class: 'task-body' },
    h('div', { class: 'task-title' }, task.title || '（无标题）'),
  );
  if (meta.childNodes.length) body.append(meta);

  const grip = h('span', { class: 'drag-grip', title: '拖动调整日期、时段或顺序', 'aria-hidden': 'true' }, '⠿');

  card.append(check, body, grip);
  bindCardDrag(ctx, card, dateKey, task);

  card.addEventListener('click', (event) => {
    if (card._justDragged) return;
    if (event.target.closest('.task-check, .task-mini-btn, .drag-grip')) return;
    ctx.openDetail(dateKey, task.id);
  });

  return card;
}

/* ================= 速记 ================= */

export function openQuickAdd(ctx, anchor, slot) {
  document.querySelectorAll('.quick-add').forEach((node) => node.remove());
  if (!anchor || !anchor.isConnected) return;

  const period = slot.period || 'morning';
  const time = { type: 'period', period };

  const input = h('input', {
    type: 'text',
    placeholder: '要做什么？回车保存',
    autocomplete: 'off',
  });

  const priority = h('select', { title: '优先级' },
    ['高', '中', '低'].map((p) => h('option', { value: p, selected: p === '中' }, `!${p}`)),
  );

  const categoryNames = ctx.settings.categories.map((c) => c.name);
  const initialCategory = categoryNames.includes(ctx.settings.lastCategory)
    ? ctx.settings.lastCategory
    : (categoryNames[0] || '其他');
  const category = h('select', { title: '类别' },
    ctx.settings.categories.map((c) => h('option', {
      value: c.name,
      selected: c.name === initialCategory,
    }, `#${c.name}`)),
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
  };

  const save = async () => {
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    ctx.settings.lastCategory = category.value;
    ctx.saveSettings();
    const task = createTask({
      title,
      time,
      priority: priority.value,
      category: category.value,
    });
    close();
    await ctx.addTask(slot.dateKey, task);
  };

  const onOutside = (event) => {
    if (!pop.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  const pop = h('div', { class: 'quick-add' },
    input,
    h('div', { class: 'quick-add-row' },
      h('span', { class: 'qa-time' }, `🕘 ${PERIOD_LABEL[period] || '上午'}`),
      priority,
      category,
      h('div', { class: 'qa-actions' },
        h('button', { type: 'button', class: 'mini-btn', onClick: close }, '取消'),
        h('button', { type: 'button', class: 'mini-btn', onClick: save }, '保存'),
      ),
    ),
    h('div', { class: 'qa-hint' }, '回车保存 · Esc 取消 · 精确时间可在任务详情里补'),
  );

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  });

  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth || 340;
  const height = pop.offsetHeight || 120;
  let left = Math.min(rect.left, window.innerWidth - width - 12);
  left = Math.max(12, left);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    input.focus();
  }, 0);
}

/* ================= 详情面板 ================= */

function defaultExactStart(period) {
  if (period === 'morning') return '09:00';
  if (period === 'afternoon') return '14:00';
  return '19:00';
}

export async function openDetail(ctx, dateKey, taskId) {
  const day = await ctx.loadDay(dateKey, { force: true });
  const original = day.tasks.find((task) => task.id === taskId);
  if (!original) {
    toast('任务不存在，可能已被删除');
    return;
  }

  const draft = structuredClone(original);
  let draftDate = dateKey;
  const objectUrls = new Set();

  const titleInput = h('input', { type: 'text', value: draft.title, placeholder: '任务标题' });
  const dateInput = h('input', { type: 'date', value: dateKey });

  const periodSelect = h('select', {},
    ['morning', 'afternoon', 'evening'].map((key) => h('option', {
      value: key,
      selected: periodOfTask(draft) === key,
    }, PERIOD_LABEL[key])),
  );

  const exactToggle = h('input', {
    type: 'checkbox',
    checked: draft.time.type === 'exact',
  });
  const startInput = h('input', {
    type: 'time',
    value: draft.time.type === 'exact' ? draft.time.start : '',
  });
  const endInput = h('input', {
    type: 'time',
    value: draft.time.type === 'exact' && draft.time.end ? draft.time.end : '',
  });

  const exactFields = h('div', { class: 'field-row exact-fields' }, startInput, endInput);
  const exactHint = h('div', { class: 'field-hint' }, '精确时间会决定所属时段');

  const syncPeriodFromStart = () => {
    const mins = hhmmToMinutes(startInput.value);
    if (mins == null) return;
    periodSelect.value = periodOfMinutes(mins);
  };

  const syncExactUI = () => {
    const enabled = exactToggle.checked;
    exactFields.classList.toggle('hidden', !enabled);
    exactHint.classList.toggle('hidden', !enabled);
    periodSelect.disabled = enabled;
    if (!enabled) return;
    if (!startInput.value) startInput.value = defaultExactStart(periodSelect.value);
    syncPeriodFromStart();
  };

  exactToggle.addEventListener('change', syncExactUI);
  startInput.addEventListener('input', () => {
    if (exactToggle.checked) syncPeriodFromStart();
  });

  const prioritySelect = h('select', {},
    ['高', '中', '低'].map((p) => h('option', { value: p, selected: draft.priority === p }, p)),
  );

  const categories = [...ctx.settings.categories];
  if (!categories.some((c) => c.name === draft.category)) {
    categories.push({ name: draft.category, color: '#94A3B8' });
  }
  const categorySelect = h('select', {},
    categories.map((c) => h('option', { value: c.name, selected: draft.category === c.name }, c.name)),
  );

  const notesInput = h('textarea', { placeholder: '备注、上下文、下一步……' });
  notesInput.value = draft.notes || '';

  /* 附件 */
  const attachList = h('div', { class: 'attach-list' });
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden' });
  const dropZone = h('div', { class: 'drop-zone' }, '拖入图片/文档，或点击选择文件');
  const ATTACH_HINT = '移除附件后，保存任务时才会删除磁盘文件';
  const attachHint = h('div', { class: 'field-hint' }, ATTACH_HINT);

  const pendingDeletes = [];
  let attachmentFolder = attachmentFolderOf(draft.attachments);
  let saving = false;

  const hasPendingAttachments = () => draft.attachments.some((att) => att.pending);

  const openFolderBtn = h('button', {
    type: 'button',
    class: 'mini-btn',
    onClick: async () => {
      if (hasPendingAttachments()) {
        toast('请先保存文件，附件还没有落盘', { type: 'info', duration: 2600 });
        return;
      }
      const folder = attachmentFolderOf(draft.attachments);
      if (!folder) return;
      try {
        await ctx.revealTaskFolder(dateKey, folder);
      } catch (err) {
        toast(err.message, { type: 'error', duration: 6000 });
      }
    },
  }, '打开文件夹');

  const refreshFolderButton = () => {
    const pending = hasPendingAttachments();
    const hasLocal = draft.attachments.some((att) => !att.pending && Boolean(attachmentFolderOf([att])));
    openFolderBtn.disabled = !pending && !hasLocal;
    openFolderBtn.classList.toggle('is-locked', pending);
    openFolderBtn.title = pending
      ? '请先保存文件'
      : hasLocal
        ? '在资源管理器中打开任务附件文件夹'
        : '添加附件后可用';
  };

  const renderAttachments = async () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    attachList.replaceChildren();
    refreshFolderButton();
    if (!draft.attachments.length) {
      attachList.append(h('div', { class: 'muted', style: { fontSize: '11px' } }, '暂无附件'));
      return;
    }
    for (const att of [...draft.attachments]) {
      const pending = Boolean(att.pending);
      const row = h('div', { class: `attach-item${pending ? ' pending' : ''}` });
      if (att.kind === 'image') {
        let url = null;
        if (pending && att.file) {
          url = URL.createObjectURL(att.file);
          objectUrls.add(url);
        } else {
          url = await ctx.attachmentUrl(dateKey, att.target);
          if (closed) return;
        }
        if (url) {
          row.append(h('img', { src: url, alt: att.label || '' }));
        } else {
          row.append(h('span', { class: 'att-kind' }, '🖼'));
        }
      } else if (att.kind === 'link') {
        row.append(h('span', { class: 'att-kind' }, '🔗'));
      } else {
        row.append(h('span', { class: 'att-kind' }, '📄'));
      }

      const name = h('span', {
        class: 'att-name',
        title: att.label || att.target || '',
      }, att.label || fileName(att.target));
      row.append(name);
      if (pending) row.append(h('span', { class: 'att-badge' }, '待保存'));

      row.append(h('button', {
        type: 'button',
        class: 'mini-btn',
        onClick: (event) => {
          event.stopPropagation();
          const index = draft.attachments.indexOf(att);
          if (index >= 0) draft.attachments.splice(index, 1);
          if (!pending && !/^https?:\/\//i.test(att.target || '') && attachmentFolderOf([att])) {
            if (!pendingDeletes.includes(att.target)) pendingDeletes.push(att.target);
          }
          renderAttachments();
        },
      }, '移除'));

      row.addEventListener('click', async (event) => {
        if (event.target.closest('button')) return;
        if (pending) {
          toast('请先保存文件，附件还没有落盘', { type: 'info', duration: 2600 });
          return;
        }
        try {
          await ctx.revealAttachment(dateKey, att);
        } catch (err) {
          toast(err.message, { type: 'error', duration: 6000 });
        }
      });

      attachList.append(row);
    }
  };

  const handleFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    for (const file of list) {
      draft.attachments.push({
        kind: file.type && file.type.startsWith('image/') ? 'image' : 'file',
        label: file.name || 'attachment',
        target: null,
        file,
        pending: true,
      });
    }
    await renderAttachments();
  };

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(event.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  const linkInput = h('input', { type: 'text', placeholder: 'https://…' });
  const addLink = () => {
    const url = linkInput.value.trim();
    if (!url) return;
    draft.attachments.push({ kind: 'link', label: url, target: url });
    linkInput.value = '';
    renderAttachments();
  };
  linkInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addLink();
    }
  });

  /* 面板骨架 */
  let closed = false;
  let backdrop = null;
  let closePromptOpen = false;

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    if (backdrop) backdrop.remove();
  }

  function snapshot() {
    return JSON.stringify({
      title: titleInput.value.trim(),
      date: dateInput.value,
      period: periodSelect.value,
      exact: exactToggle.checked,
      start: exactToggle.checked ? startInput.value : '',
      end: exactToggle.checked ? endInput.value : '',
      priority: prioritySelect.value,
      category: categorySelect.value,
      notes: notesInput.value.trim(),
      attachments: draft.attachments.map((att) => (
        att.pending
          ? `pending:${att.label}:${att.file ? att.file.size : ''}`
          : `${att.kind}:${att.label}:${att.target}`
      )),
    });
  }

  let initialState = '';
  const isDirty = () => snapshot() !== initialState;

  function onKey(event) {
    // 有弹窗时把按键交给弹窗处理
    if (document.querySelector('.modal-backdrop')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  }

  async function requestClose() {
    if (closed || closePromptOpen) return;
    if (saving) {
      toast('正在保存，请稍候…', { duration: 1600 });
      return;
    }
    if (!isDirty()) {
      close();
      return;
    }
    closePromptOpen = true;
    const choice = await askCloseChoice();
    closePromptOpen = false;
    if (choice === 'save') await save();
    else if (choice === 'discard') close();
  }

  function askCloseChoice() {
    return new Promise((resolve) => {
      let answered = false;
      const finish = (value) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      const modal = openModal({
        title: '未保存的修改',
        body: h('p', { style: { margin: '0', fontSize: '13px', lineHeight: '1.7' } },
          '这条任务还有未保存的修改，关闭前要保存吗？'),
        footer: [
          h('button', {
            type: 'button', class: 'pill-btn',
            onClick: () => { finish('edit'); modal.close(); },
          }, '继续编辑'),
          h('button', {
            type: 'button', class: 'pill-btn',
            onClick: () => { finish('discard'); modal.close(); },
          }, '不保存'),
          h('button', {
            type: 'button', class: 'pill-btn primary',
            onClick: () => { finish('save'); modal.close(); },
          }, '保存'),
        ],
        onClose: () => finish('edit'),
      });
    });
  }

  const deleteBtn = h('button', {
    type: 'button',
    class: 'pill-btn danger',
    onClick: async () => {
      const hasLocal = Boolean(attachmentFolderOf(draft.attachments))
        || pendingDeletes.length > 0;
      const hasPending = draft.attachments.some((att) => att.pending);
      const message = hasLocal
        ? '删除任务及其所有附件文件？此操作不可撤销。'
        : hasPending
          ? '删除这条任务？尚未保存的附件会被丢弃。'
          : '删除这条任务？此操作会直接修改 Markdown 文件。';
      const ok = await confirmDialog(message, {
        title: '删除任务', confirmLabel: '删除', danger: true,
      });
      if (!ok) return;
      close();
      await ctx.deleteTask(dateKey, draft.id);
    },
  }, '删除');

  const cancelBtn = h('button', {
    type: 'button', class: 'pill-btn', onClick: () => requestClose(),
  }, '取消');

  const saveBtn = h('button', {
    type: 'button', class: 'pill-btn primary', onClick: () => save(),
  }, '保存');

  function setSaving(busy, text = '') {
    panel.classList.toggle('is-saving', busy);
    for (const btn of [saveBtn, cancelBtn, deleteBtn]) btn.disabled = busy;
    if (busy) {
      saveBtn.replaceChildren(h('span', { class: 'spinner' }), text || '正在保存…');
      attachHint.textContent = text || ATTACH_HINT;
    } else {
      saveBtn.replaceChildren('保存');
      attachHint.textContent = ATTACH_HINT;
    }
  }

  const panel = h('div', { class: 'detail-panel' },
    h('div', { class: 'detail-head' },
      h('h2', {}, '任务详情'),
      h('button', { type: 'button', class: 'icon-btn', onClick: () => requestClose(), title: '关闭' }, '✕'),
    ),
    h('div', { class: 'detail-body' },
      h('div', { class: 'field' }, h('label', {}, '标题'), titleInput),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', {}, '日期'), dateInput),
        h('div', { class: 'field' }, h('label', {}, '优先级'), prioritySelect),
      ),
      h('div', { class: 'field' }, h('label', {}, '类别'), categorySelect),
      h('div', { class: 'field' },
        h('label', {}, '时段'),
        periodSelect,
        h('label', { class: 'check-label' }, exactToggle, ' 精确时间（可选）'),
        exactFields,
        exactHint,
      ),
      h('div', { class: 'field' }, h('label', {}, '备注'), notesInput),
      h('div', { class: 'field' },
        h('div', { class: 'field-label-row' },
          h('label', {}, '附件'),
          openFolderBtn,
        ),
        attachList,
        attachHint,
        dropZone,
        fileInput,
        h('div', { class: 'link-row' }, linkInput,
          h('button', { type: 'button', class: 'mini-btn', onClick: addLink }, '加链接')),
      ),
    ),
    h('div', { class: 'detail-foot' },
      deleteBtn,
      h('div', { class: 'spacer' }),
      cancelBtn,
      saveBtn,
    ),
  );

  backdrop = h('div', {
    class: 'detail-backdrop',
    onClick: (event) => {
      if (event.target === backdrop) requestClose();
    },
  }, panel);

  async function save() {
    if (saving) return false;
    const title = titleInput.value.trim();
    if (!title) {
      toast('标题不能为空', { type: 'error' });
      titleInput.focus();
      return false;
    }

    draft.title = title;
    draft.priority = prioritySelect.value;
    draft.category = categorySelect.value;
    draft.notes = notesInput.value.trim();
    draftDate = dateInput.value || dateKey;

    if (exactToggle.checked) {
      const start = startInput.value;
      if (!start) {
        toast('勾选了精确时间，请填写开始时间', { type: 'error' });
        startInput.focus();
        return false;
      }
      const mins = hhmmToMinutes(start);
      if (mins == null) {
        toast('开始时间格式不正确', { type: 'error' });
        return false;
      }
      periodSelect.value = periodOfMinutes(mins);
      draft.time = {
        type: 'exact',
        start,
        end: endInput.value || null,
      };
    } else {
      draft.time = { type: 'period', period: periodSelect.value };
    }

    if (pendingDeletes.length) {
      const ok = await confirmDialog(
        `保存后将删除 ${pendingDeletes.length} 个附件文件，此操作无法撤销。`,
        { title: '删除附件文件', confirmLabel: '删除并保存', danger: true },
      );
      if (!ok) return false;
    }

    const pendingFiles = draft.attachments.filter((att) => att.pending && att.file);
    const uploaded = [];
    saving = true;
    setSaving(true, pendingFiles.length ? `正在上传附件 0/${pendingFiles.length}…` : '正在保存…');

    try {
      if (pendingFiles.length) {
        // 先传到原日期所在月份：saveTask 会按需把整个任务文件夹改名或搬到新日期
        const folder = attachmentFolder || makeTaskFolderName(draft.id, draft.title);
        attachmentFolder = folder;
        for (let i = 0; i < pendingFiles.length; i++) {
          const att = pendingFiles[i];
          setSaving(true, `正在上传附件 ${i + 1}/${pendingFiles.length}…`);
          const stored = await ctx.store.copyAttachment(dateKey, folder, att.file);
          uploaded.push({ att, target: stored.target });
          att.target = stored.target;
          att.pending = false;
        }
        await renderAttachments();
      }

      setSaving(true, '正在保存…');
      const result = await ctx.saveTask(dateKey, draft, draftDate, { pendingDeletes });
      if (!result?.ok) {
        await rollbackUploads(uploaded);
        return false;
      }
      for (const { att } of uploaded) delete att.file;
      close();
      return true;
    } catch (err) {
      console.error('保存任务失败', err);
      await rollbackUploads(uploaded);
      toast(`保存失败：${err.message}`, { type: 'error', duration: 6000 });
      return false;
    } finally {
      saving = false;
      setSaving(false);
    }
  }

  async function rollbackUploads(list) {
    if (!list.length) return;
    try {
      await ctx.deleteAttachmentFiles(dateKey, list.map((item) => item.target));
    } catch (err) {
      console.warn('回滚上传附件失败', err);
    }
    for (const { att, target } of list) {
      if (att.target === target) {
        att.target = null;
        att.pending = true;
      }
    }
    await renderAttachments();
  }

  document.getElementById('overlay-root').append(backdrop);
  document.addEventListener('keydown', onKey, true);
  syncExactUI();
  initialState = snapshot();
  await renderAttachments();
  setTimeout(() => titleInput.focus(), 30);
}

