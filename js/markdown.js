// Markdown 任务文件解析 / 序列化。
// 文件结构：标题 + "## 任务" + "## 备注" + 其他原样保留的章节。

import { PERIOD_LABEL, PERIOD_ORDER, periodOfTask, periodRank } from './date.js';

const PRIORITIES = ['高', '中', '低'];
const FALLBACK_CATEGORY = '其他';

export function genTaskId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return 't-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createTask(overrides = {}) {
  return {
    id: genTaskId(),
    title: '',
    done: false,
    time: { type: 'period', period: 'morning' },
    priority: '中',
    category: FALLBACK_CATEGORY,
    notes: '',
    attachments: [],
    ...overrides,
  };
}

export function normalizeTask(task) {
  const out = createTask();
  Object.assign(out, task);
  if (!out.id) out.id = genTaskId();
  if (!PRIORITIES.includes(out.priority)) out.priority = '中';
  if (!out.category) out.category = FALLBACK_CATEGORY;
  if (!out.time || typeof out.time !== 'object') out.time = { type: 'period', period: 'morning' };

  // v1.1：只保留“时段 / 可选精确时间”，未安排或无时段时间统一归入上午
  if (out.time.type === 'exact') {
    if (!out.time.start || !/^\d{1,2}:\d{2}$/.test(out.time.start)) {
      out.time = { type: 'period', period: 'morning' };
    } else {
      out.time = {
        type: 'exact',
        start: out.time.start.padStart(5, '0'),
        end: out.time.end && /^\d{1,2}:\d{2}$/.test(out.time.end) ? out.time.end.padStart(5, '0') : null,
      };
    }
  } else if (out.time.type === 'period') {
    if (!PERIOD_ORDER.includes(out.time.period)) out.time = { type: 'period', period: 'morning' };
  } else {
    out.time = { type: 'period', period: 'morning' };
  }

  if (!Array.isArray(out.attachments)) out.attachments = [];
  out.done = Boolean(out.done);
  return out;
}

/* ---------------- 时间元数据 ---------------- */

export function formatTimeToken(time) {
  if (!time || time.type === 'none') return '@上午';
  if (time.type === 'period') return `@${PERIOD_LABEL[time.period] || '上午'}`;
  if (time.type === 'exact') {
    if (time.end) return `@${time.start}-${time.end}`;
    return `@${time.start}`;
  }
  return '@上午';
}

export function parseTimeToken(token) {
  if (!token) return { type: 'period', period: 'morning' };
  if (token === '未安排') return { type: 'period', period: 'morning' };
  if (token === '上午') return { type: 'period', period: 'morning' };
  if (token === '下午') return { type: 'period', period: 'afternoon' };
  if (token === '晚上') return { type: 'period', period: 'evening' };
  const m = token.match(/^(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?$/);
  if (m) {
    return { type: 'exact', start: m[1].padStart(5, '0'), end: m[2] ? m[2].padStart(5, '0') : null };
  }
  return { type: 'none' };
}

export function timeLabel(time) {
  if (!time || time.type === 'none') return '上午';
  if (time.type === 'period') return PERIOD_LABEL[time.period] || '上午';
  if (time.type === 'exact') return time.end ? `${time.start}–${time.end}` : time.start;
  return '上午';
}

/* ---------------- 单行任务 ---------------- */

const META_PATTERNS = [
  { key: 'id', re: /\s\^t-[A-Za-z0-9-]{1,}\s*$/ },
  { key: 'time', re: /\s@(上午|下午|晚上|未安排|\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)\s*$/ },
  { key: 'priority', re: /\s!(高|中|低)\s*$/ },
  { key: 'category', re: /\s#([^\s#]+)\s*$/ },
];

export function parseTaskLine(line) {
  const m = line.match(/^-\s+\[([ xX])\]\s+(.*)$/);
  if (!m) return null;

  const done = m[1].toLowerCase() === 'x';
  let rest = m[2];
  const meta = { id: null, time: null, priority: null, category: null };

  // 从行尾反复剥离元数据，顺序不限
  for (let guard = 0; guard < 6; guard++) {
    let matched = false;
    for (const p of META_PATTERNS) {
      if (meta[p.key] !== null) continue;
      const hit = rest.match(p.re);
      if (!hit) continue;
      const value = hit[1] !== undefined ? hit[1] : hit[0].replace(/^\s\^/, '');
      meta[p.key] = p.key === 'id' ? value : value;
      rest = rest.slice(0, hit.index);
      matched = true;
      break;
    }
    if (!matched) break;
  }

  return normalizeTask({
    id: meta.id || undefined,
    title: rest.trim(),
    done,
    time: meta.time ? parseTimeToken(meta.time) : { type: 'none' },
    priority: meta.priority || '中',
    category: meta.category || FALLBACK_CATEGORY,
  });
}

export function taskToLine(task) {
  const box = task.done ? 'x' : ' ';
  const parts = [`- [${box}] ${task.title.trim()}`];
  parts.push(formatTimeToken(task.time));
  if (task.priority && task.priority !== '中') parts.push(`!${task.priority}`);
  if (task.category && task.category !== FALLBACK_CATEGORY) parts.push(`#${task.category}`);
  if (task.id) parts.push(`^${task.id}`);
  return parts.join(' ');
}

/* ---------------- 附件行 ---------------- */

function parseAttachmentLine(line) {
  const body = line.replace(/^\s*-\s+/, '').trim();
  if (!body) return null;

  let m = body.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (m) return { kind: 'image', label: m[1] || fileName(m[2]), target: m[2] };

  m = body.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
  if (m) {
    const target = m[2];
    return { kind: /^https?:\/\//i.test(target) ? 'link' : 'file', label: m[1] || fileName(target), target };
  }

  if (/^https?:\/\//i.test(body)) return { kind: 'link', label: body, target: body };
  if (body) return { kind: 'file', label: fileName(body), target: body };
  return null;
}

export function fileName(path) {
  const clean = String(path).split(/[?#]/)[0];
  return clean.split(/[\\/]/).pop() || clean;
}

export function attachmentToLine(att) {
  if (att.kind === 'image') return `  - ![${att.label || fileName(att.target)}](${att.target})`;
  return `  - [${att.label || fileName(att.target)}](${att.target})`;
}

/* ---------------- 日文件 ---------------- */

function splitSections(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      sections.push(current);
      current = { heading: h[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function parseTaskSection(lines) {
  const tasks = [];
  const loose = [];
  let current = null;

  const flush = () => { current = null; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (/^-\s+\[[ xX]\]/.test(line)) {
      flush();
      const task = parseTaskLine(line);
      if (task) {
        tasks.push(task);
        current = task;
      }
      continue;
    }

    if (current && /^\s{2,}/.test(raw)) {
      const trimmed = raw.trim();
      if (/^>\s?/.test(trimmed)) {
        const noteLine = trimmed.replace(/^>\s?/, '');
        current.notes = current.notes ? `${current.notes}\n${noteLine}` : noteLine;
      } else if (/^-\s+\[[ xX]\]/.test(trimmed)) {
        // v1 不支持子任务：缩进的 checkbox 当作备注保留，避免被误识别成附件
        current.notes = current.notes ? `${current.notes}\n${trimmed}` : trimmed;
      } else if (/^-\s+/.test(trimmed)) {
        const att = parseAttachmentLine(raw);
        if (att) current.attachments.push(att);
      } else {
        current.notes = current.notes ? `${current.notes}\n${trimmed}` : trimmed;
      }
      continue;
    }

    // 任务区里的其他内容原样保留
    loose.push(raw);
  }

  return { tasks, loose };
}

/** 按上午 → 下午 → 晚上分组，组内保持原顺序。 */
export function groupTasksByPeriod(tasks) {
  const buckets = { morning: [], afternoon: [], evening: [] };
  for (const task of tasks) {
    const period = periodOfTask(task);
    (buckets[period] || buckets.morning).push(task);
  }
  return [...buckets.morning, ...buckets.afternoon, ...buckets.evening];
}

export function normalizeTaskOrder(tasks) {
  return groupTasksByPeriod(tasks);
}

/**
 * 把任务插入到某时段的第 index 个位置（index 为 Infinity 时追加到末尾）。
 * 返回新的已分组数组，不修改原数组。
 */
export function insertTaskAtPeriod(tasks, task, period, index = Infinity) {
  const ordered = groupTasksByPeriod(tasks);
  const rank = periodRank(period);
  const existing = ordered.filter((t) => periodOfTask(t) === period);
  const firstIndex = ordered.findIndex((t) => periodOfTask(t) === period);

  if (firstIndex === -1) {
    let insertAt = ordered.findIndex((t) => periodRank(periodOfTask(t)) > rank);
    if (insertAt === -1) insertAt = ordered.length;
    ordered.splice(insertAt, 0, task);
  } else {
    const position = Math.max(0, Math.min(Number(index) || 0, existing.length));
    ordered.splice(firstIndex + position, 0, task);
  }
  return ordered;
}

export function parseDayFile(text, dateKey) {
  if (!text || !text.trim()) {
    return { dateKey, tasks: [], note: '', extras: [], loose: [] };
  }

  const sections = splitSections(text);
  let tasks = [];
  let note = '';
  let loose = [];
  const extras = [];

  for (const sec of sections) {
    const heading = sec.heading || '';
    if (heading.includes('任务')) {
      const parsed = parseTaskSection(sec.lines);
      tasks = parsed.tasks;
      loose = parsed.loose;
    } else if (heading.includes('备注')) {
      note = sec.lines.join('\n').trim();
    } else if (heading) {
      extras.push({ heading, body: sec.lines.join('\n').replace(/\s+$/, '') });
    }
  }

  // 没有 "## 任务" 标题时，容错：把全文里的 checkbox 行都当任务
  if (!sections.some((s) => (s.heading || '').includes('任务'))) {
    const parsed = parseTaskSection(text.split('\n'));
    if (parsed.tasks.length) {
      tasks = parsed.tasks;
      loose = parsed.loose;
    }
  }

  return { dateKey, tasks: normalizeTaskOrder(tasks), note, extras, loose };
}

export function serializeDayFile(day) {
  const { dateKey, tasks = [], note = '', extras = [], loose = [] } = day;
  const [y, m, d] = dateKey.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];

  const out = [`# ${dateKey} ${weekday}`, '', '## 任务', ''];

  for (const task of groupTasksByPeriod(tasks)) {
    out.push(taskToLine(task));
    if (task.notes) {
      for (const line of String(task.notes).split('\n')) out.push(`  > ${line}`);
    }
    for (const att of task.attachments || []) out.push(attachmentToLine(att));
  }

  if (loose.length) {
    out.push('');
    out.push(...loose);
  }

  if (note && note.trim()) {
    out.push('', '## 备注', '', note.trim());
  }

  for (const extra of extras) {
    out.push('', `## ${extra.heading}`, '');
    if (extra.body && extra.body.trim()) out.push(extra.body.trim());
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export { PRIORITIES, FALLBACK_CATEGORY };
