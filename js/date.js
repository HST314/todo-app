// 日期与时段工具。全部使用本地时间，避免 toISOString 的时区偏移。

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const WEEKDAYS_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

export const PERIODS = [
  { key: 'morning', label: '上午', start: 6 * 60, end: 12 * 60, color: 'var(--period-morning)' },
  { key: 'afternoon', label: '下午', start: 12 * 60, end: 18 * 60, color: 'var(--period-afternoon)' },
  { key: 'evening', label: '晚上', start: 18 * 60, end: 30 * 60, color: 'var(--period-evening)' },
];

export const PERIOD_LABEL = { morning: '上午', afternoon: '下午', evening: '晚上' };
export const PERIOD_ORDER = ['morning', 'afternoon', 'evening'];

export function periodRank(period) {
  const index = PERIOD_ORDER.indexOf(period);
  return index === -1 ? 0 : index;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function monthKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function monthKeyFromDateKey(key) {
  return key.slice(0, 7);
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - day);
  return d;
}

export function endOfWeek(date) {
  return addDays(startOfWeek(date), 6);
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function daysInMonth(date) {
  return endOfMonth(date).getDate();
}

/** ISO 周编号与年份，用于 hash 路由 */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function isoWeekKey(date) {
  const { year, week } = isoWeek(date);
  return `${year}-W${pad2(week)}`;
}

export function dateFromIsoWeek(year, week) {
  // 该 ISO 周的周一
  const jan4 = new Date(year, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const week1Monday = addDays(jan4, -jan4Day);
  return addDays(week1Monday, (week - 1) * 7);
}

export function weekdayLabel(date) {
  return WEEKDAYS[(date.getDay() + 6) % 7];
}

export function formatDateLabel(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdayLabel(date)}`;
}

export function formatDateShort(date) {
  return `${pad2(date.getMonth() + 1)}月${pad2(date.getDate())}日`;
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(date) {
  return isSameDay(date, new Date());
}

export function minutesToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function hhmmToMinutes(value) {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** 00:00-05:59 归入晚上（凌晨），用于三列看板 */
export function periodOfMinutes(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  if (m >= 6 * 60 && m < 12 * 60) return 'morning';
  if (m >= 12 * 60 && m < 18 * 60) return 'afternoon';
  return 'evening';
}

export function periodOfTask(task) {
  if (task.time.type === 'period') return task.time.period;
  if (task.time.type === 'exact') {
    const mins = hhmmToMinutes(task.time.start);
    return periodOfMinutes(mins ?? 6 * 60);
  }
  // v1.1：取消“未安排”，无时段任务统一归入上午
  return 'morning';
}

