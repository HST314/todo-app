// 轻量 DOM / 弹层 / 提示工具。

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------------- Toast ---------------- */

export function toast(message, options = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return () => {};

  const node = h('div', { class: `toast ${options.type === 'error' ? 'error' : ''}` });
  const text = h('span', {}, message);
  node.append(text);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.remove();
  };

  if (options.actionLabel && typeof options.onAction === 'function') {
    const btn = h('button', {
      type: 'button',
      onClick: () => {
        options.onAction();
        close();
      },
    }, options.actionLabel);
    node.append(btn);
  }

  root.append(node);
  const duration = options.duration ?? 4200;
  if (duration > 0) setTimeout(close, duration);
  return close;
}

/* ---------------- 通用弹窗 ---------------- */

export function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('overlay-root');
  const card = h('div', { class: 'modal-card', style: wide ? { width: 'min(760px, 100%)' } : null });

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (onClose) onClose();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  const head = h('div', { class: 'modal-head' },
    h('h2', {}, title),
    h('button', { type: 'button', class: 'icon-btn', onClick: close, title: '关闭' }, '✕'),
  );

  const bodyEl = h('div', { class: 'modal-body' });
  appendChildren(bodyEl, [body]);

  const footEl = h('div', { class: 'modal-foot' });
  appendChildren(footEl, [footer]);

  card.append(head, bodyEl);
  if (footer) card.append(footEl);

  const overlay = h('div', {
    class: 'modal-backdrop',
    onClick: (event) => {
      if (event.target === overlay) close();
    },
  }, card);

  root.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => {
    const focusable = card.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
  }, 30);

  return { overlay, card, body: bodyEl, footer: footEl, close };
}

export function confirmDialog(message, { title = '确认', confirmLabel = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      body: h('p', { style: { margin: '0', fontSize: '13px', lineHeight: '1.7' } }, message),
      footer: [
        h('button', {
          type: 'button', class: 'pill-btn',
          onClick: () => { done(false); modal.close(); },
        }, '取消'),
        h('button', {
          type: 'button', class: `pill-btn ${danger ? 'danger' : 'primary'}`,
          onClick: () => { done(true); modal.close(); },
        }, confirmLabel),
      ],
      onClose: () => done(false),
    });
  });
}
