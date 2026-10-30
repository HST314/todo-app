// 数据仓库：通过本地 server.py 读写数据文件夹。
// 数据文件夹的绝对路径由服务端保存，浏览器不再持有目录句柄。

export class NoDirectoryError extends Error {
  constructor(message = '尚未选择数据文件夹') {
    super(message);
    this.name = 'NoDirectoryError';
  }
}

export class FileConflictError extends Error {
  constructor(message = '文件已被外部修改') {
    super(message);
    this.name = 'FileConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message = '文件不存在') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class NoServiceError extends Error {
  constructor(message = '本地服务不可用') {
    super(message);
    this.name = 'NoServiceError';
  }
}

async function api(method, endpoint, { query, body, headers } = {}) {
  let url = endpoint;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const text = params.toString();
    if (text) url += `?${text}`;
  }

  let response;
  try {
    response = await fetch(url, { method, body, headers, cache: 'no-store' });
  } catch {
    throw new NoServiceError('本地服务未启动，请运行 python server.py 后刷新页面');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应，通常说明请求没有走到 server.py
  }

  if (!data) {
    throw new NoServiceError('页面不是由 python server.py 提供，或本地服务未启动。请运行 python server.py 后访问 http://localhost:8000。');
  }

  if (!response.ok || data.ok === false) {
    const code = data.code || '';
    const message = data.error || `请求失败（HTTP ${response.status}）`;
    if (code === 'conflict') throw new FileConflictError(message);
    if (code === 'not-found') throw new NotFoundError(message);
    if (code === 'no-directory') throw new NoDirectoryError(message);
    throw new Error(message);
  }
  return data;
}

export class Store {
  constructor() {
    this.dataRoot = '';
    this.dirName = '';
    this.configured = false;
    this.exists = false;
    this.ready = false;
  }

  /** 兼容旧代码：就绪时返回数据根目录，否则 null。 */
  get dir() {
    return this.ready ? this.dataRoot : null;
  }

  applyStatus(status) {
    this.configured = Boolean(status.configured);
    this.exists = Boolean(status.exists);
    this.dataRoot = status.dataRoot || '';
    this.dirName = status.dirName || '';
    this.ready = this.configured && this.exists;
    return status;
  }

  async restore() {
    const status = await api('GET', '/api/status');
    return this.applyStatus(status);
  }

  async pickDirectory() {
    const status = await api('POST', '/api/select-folder');
    if (status.canceled) return { canceled: true };
    this.applyStatus(status);
    return status;
  }

  requireReady() {
    if (!this.ready) throw new NoDirectoryError();
  }

  /* ---------------- 目录与文件 ---------------- */

  async listMonths() {
    this.requireReady();
    const { entries } = await api('GET', '/api/list', { query: { path: '' } });
    return entries
      .filter((entry) => entry.kind === 'directory' && /^\d{4}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async listDayKeys(month) {
    this.requireReady();
    try {
      const { entries } = await api('GET', '/api/list', { query: { path: month } });
      return entries
        .filter((entry) => entry.kind === 'file' && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
        .map((entry) => entry.name.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  /** 读取一天。返回的 lastModified 用于写入前的冲突检测。 */
  async readDay(dateKey) {
    this.requireReady();
    const path = `${dateKey.slice(0, 7)}/${dateKey}.md`;
    try {
      const result = await api('GET', '/api/read', { query: { path } });
      return { exists: true, text: result.text, lastModified: result.mtime };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { exists: false, text: '', lastModified: null };
      }
      throw err;
    }
  }

  /**
   * 写入一天。expectedMtime 为 undefined 时不检查；为 null 表示预期文件不存在。
   * 磁盘上的 mtime 与预期不符时抛出 FileConflictError，由 UI 决定重载或覆盖。
   */
  async writeDay(dateKey, text, expectedMtime) {
    this.requireReady();
    const path = `${dateKey.slice(0, 7)}/${dateKey}.md`;
    const query = { path };
    if (expectedMtime === null) query.expect = 'absent';
    else if (expectedMtime !== undefined) query.expect = expectedMtime;

    const result = await api('PUT', '/api/write', {
      query,
      body: text,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
    return { lastModified: result.mtime };
  }

  /** 读取共享设置文件（数据目录下的 settings.json）。 */
  async readSharedSettings() {
    this.requireReady();
    try {
      const result = await api('GET', '/api/read', { query: { path: 'settings.json' } });
      return { exists: true, text: result.text, lastModified: result.mtime };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { exists: false, text: '', lastModified: null };
      }
      throw err;
    }
  }

  /** 写入共享设置文件。expectedMtime 语义同 writeDay。 */
  async writeSharedSettings(text, expectedMtime) {
    this.requireReady();
    const query = { path: 'settings.json' };
    if (expectedMtime === null) query.expect = 'absent';
    else if (expectedMtime !== undefined) query.expect = expectedMtime;

    const result = await api('PUT', '/api/write', {
      query,
      body: text,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
    return { lastModified: result.mtime };
  }

  async readMonth(month) {
    const keys = await this.listDayKeys(month);
    const out = new Map();
    await Promise.all(keys.map(async (key) => {
      try {
        out.set(key, await this.readDay(key));
      } catch {
        // 单个文件读失败不阻塞整月
      }
    }));
    return out;
  }

  /** 扫描全部日文件，供搜索与逾期使用。 */
  async readAllDays({ months = null } = {}) {
    const list = months || await this.listMonths();
    const out = [];
    for (const month of list) {
      const keys = await this.listDayKeys(month);
      for (const key of keys) {
        try {
          out.push({ dateKey: key, ...await this.readDay(key) });
        } catch {
          // 跳过无法读取的文件
        }
      }
    }
    return out;
  }

  /* ---------------- 附件（任务级文件夹） ---------------- */

  /** 把文件上传到 YYYY-MM/attachments/<folder>/，返回新的附件描述。 */
  async copyAttachment(dateKey, folder, file) {
    this.requireReady();
    if (!folder) throw new Error('缺少任务附件文件夹');
    const dir = `${dateKey.slice(0, 7)}/attachments/${folder}`;
    await api('POST', '/api/mkdir', { query: { path: dir } });
    const result = await api('POST', '/api/upload', {
      query: { dir, name: file.name || 'attachment' },
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    return {
      kind: file.type && file.type.startsWith('image/') ? 'image' : 'file',
      label: file.name || result.name,
      target: `attachments/${folder}/${result.name}`,
    };
  }

  /** 附件预览地址；仅支持新的任务级 attachments/ 路径。 */
  attachmentUrl(dateKey, target) {
    const parsed = parseAttachmentTarget(target);
    if (!parsed) return null;
    const path = `${dateKey.slice(0, 7)}/${target}`;
    return `/api/file?path=${encodeURIComponent(path)}`;
  }

  /** 删除单个附件文件，并清理变空的任务文件夹。 */
  async deleteAttachment(dateKey, target) {
    this.requireReady();
    const parsed = parseAttachmentTarget(target);
    if (!parsed) throw new Error('旧版 assets/ 附件不支持删除，请手动处理');
    const path = `${dateKey.slice(0, 7)}/attachments/${parsed.folder}/${parsed.file}`;
    await api('DELETE', '/api/entry', { query: { path, prune: '1' } });
  }

  /** 删除任务的所有附件文件夹（按 taskId 前缀扫描）。 */
  async deleteTaskFolders(dateKey, taskId) {
    this.requireReady();
    const month = dateKey.slice(0, 7);
    const dir = `${month}/attachments`;
    let entries;
    try {
      entries = (await api('GET', '/api/list', { query: { path: dir } })).entries;
    } catch {
      return 0;
    }

    const names = entries
      .filter((entry) => entry.kind === 'directory' && (entry.name === taskId || entry.name.startsWith(`${taskId}-`)))
      .map((entry) => entry.name);
    for (const name of names) {
      try {
        await api('DELETE', '/api/entry', { query: { path: `${dir}/${name}`, recursive: '1', prune: '1' } });
      } catch {
        // 单个目录删除失败不阻塞其余
      }
    }
    return names.length;
  }

  /**
   * 把任务文件夹复制到目标月份/目标名字，先不删除旧目录。
   * 调用方在 Markdown 保存成功后再调用 removeTaskFolder 提交。
   */
  async prepareTaskFolderMove(fromDate, toDate, oldFolder, newFolder) {
    this.requireReady();
    if (fromDate.slice(0, 7) === toDate.slice(0, 7) && oldFolder === newFolder) {
      return { ok: true, needed: false, targetExisted: true, targetCreated: false };
    }

    const from = `${fromDate.slice(0, 7)}/attachments/${oldFolder}`;
    const to = `${toDate.slice(0, 7)}/attachments/${newFolder}`;
    try {
      const stat = await api('GET', '/api/stat', { query: { path: from } });
      if (!stat.exists || stat.kind !== 'directory') {
        return { ok: false, error: '附件文件夹不存在，无法移动/改名' };
      }
    } catch (err) {
      return { ok: false, error: err.message || '附件文件夹检查失败' };
    }

    try {
      const result = await api('POST', '/api/copy-dir', { query: { from, to } });
      return {
        ok: true,
        needed: true,
        targetExisted: result.targetExisted,
        targetCreated: result.targetCreated,
      };
    } catch (err) {
      return { ok: false, error: err.message || '附件文件夹复制失败' };
    }
  }

  async removeTaskFolder(dateKey, folder) {
    this.requireReady();
    const path = `${dateKey.slice(0, 7)}/attachments/${folder}`;
    try {
      await api('DELETE', '/api/entry', { query: { path, recursive: '1', prune: '1' } });
    } catch {
      // 不存在则忽略
    }
  }
}

export function taskFolderSlug(title) {
  return String(title || '')
    .trim()
    .replace(/[<>:"/\\|?*()\s\u0000-\u001f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 32);
}

export function makeTaskFolderName(taskId, title) {
  return `${taskId}-${taskFolderSlug(title) || 'task'}`;
}

export function attachmentFolderOf(attachments) {
  for (const att of attachments || []) {
    const parsed = parseAttachmentTarget(att.target);
    if (parsed) return parsed.folder;
  }
  return null;
}

export function parseAttachmentTarget(target) {
  const text = String(target || '');
  const match = text.match(/^attachments\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { folder: match[1], file: match[2] };
}

export function attachmentFileName(target) {
  const parsed = parseAttachmentTarget(target);
  return parsed ? parsed.file : String(target || '').split('/').pop();
}
