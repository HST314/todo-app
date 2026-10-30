# 本地服务

`server.py` 是拾光唯一的后端。它只做三件事：

1. 提供 `index.html`、CSS、JS 等静态文件；
2. 保存数据目录的绝对路径，并代理页面对该目录的全部读写；
3. 调用系统文件管理器打开文件夹、定位文件。

## 为什么需要它

浏览器出于安全考虑：

- 不会把用户所选文件夹的绝对路径暴露给网页；
- 不允许网页直接唤起系统文件管理器；
- 不能用 `file://` 方式访问本地数据目录。

所以目录选择、路径保存和文件读写都交给本地服务。服务只监听本机，不联网。

## 启动

```bash
cd todo-app
python server.py
```

打开 <http://localhost:8000>。

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址。不要随意改成 `0.0.0.0` |
| `--port` | `8000` | 端口，被占用时换一个 |
| `--data` | 无 | 直接指定数据目录，跳过首次选择 |

示例：

```bash
python server.py --port 8080
python server.py --data "D:\File\科研\TODO\todo-app\data"
```

## 配置

- 数据目录保存在 `todo-app/config.json`；
- 该文件已加入 `.gitignore`，因为里面是本机绝对路径；
- 修改数据目录请用页面里的「更换文件夹」，或启动时传 `--data`；
- 不要手动把 `config.json` 提交到 Git。

## HTTP 接口

页面通过这些接口读写数据。所有路径都是相对数据根目录的相对路径。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 是否已配置、路径是否存在 |
| POST | `/api/select-folder` | 打开系统目录选择框并保存路径 |
| GET | `/api/list?path=` | 列出目录内容 |
| GET | `/api/stat?path=` | 文件/目录是否存在、mtime、大小 |
| GET | `/api/read?path=` | 读取 UTF-8 文本 |
| PUT | `/api/write?path=&expect=` | 写入文本，`expect` 用于冲突检测 |
| POST | `/api/mkdir?path=` | 创建目录（含父目录） |
| POST | `/api/upload?dir=&name=` | 上传附件，流式写入 |
| GET | `/api/file?path=` | 读取附件原始字节 |
| DELETE | `/api/entry?path=&recursive=&prune=` | 删除文件/目录，可清理空目录 |
| POST | `/api/copy-dir?from=&to=` | 递归复制目录 |
| GET | `/api/reveal?path=&select=` | 打开文件夹或定位文件 |

写入冲突时返回 `409` 和 `code: conflict`；文件不存在返回 `404` 和 `code: not-found`。

## 安全边界

- 默认只监听 `127.0.0.1`；
- 校验 `Origin` / `Referer`，只接受本机页面调用；
- 所有路径解析后必须落在数据根目录内，拒绝 `..`、绝对路径和符号链接逃逸；
- 静态服务不暴露 `config.json`；
- 唤起文件管理器通过参数数组调用 `explorer` / `open` / `xdg-open`，不拼接 shell 命令；
- 文本写入使用临时文件 + `os.replace`，避免半截文件；
- 附件上传流式写盘，不会一次性读进内存。

它不是一个多用户服务：没有账号、没有鉴权、没有加密。请只在本机使用，不要暴露到公网。

## 静态文件

页面必须由 `server.py` 提供，不能：

- 直接双击 `index.html`（`file://` 下没有 `/api/*`）；
- 用 `python -m http.server` 代替（没有 API，也无法打开文件夹）。

如果页面提示「无法连接本地服务」或「页面不是由 python server.py 提供」，说明当前不是由 `server.py` 在提供服务。

## 故障排查

### 端口被占用

```text
OSError: [WinError 10048] 通常每个套接字地址只允许使用一次
```

换端口：

```bash
python server.py --port 8080
```

然后访问 <http://localhost:8080>。

### 403 仅允许本机页面调用

不要用局域网 IP 或机器名访问，使用：

```text
http://localhost:8000
http://127.0.0.1:8000
```

### 目录选择框打不开

Windows 需要 Python 自带 `tkinter`。如果提示缺少模块，可以：

- 重新安装带 Tcl/Tk 的 Python；
- 或者启动时用 `--data` 直接指定目录。

### 提示数据文件夹不存在

数据目录被移动或删除。打开设置重新选择，或：

```bash
python server.py --data "新的路径"
```

### 「打开文件夹」没反应

- 确认使用的是 `python server.py`，而不是其它静态服务器；
- 确认数据目录和附件路径仍然存在；
- 查看服务端终端的错误信息。

### 上传大文件很慢

附件会完整复制进数据目录，这是有意设计。大文件上传期间不要关闭页面；失败会自动回滚。

## 相关文档

- [数据与备份](data.md)
- [附件管理](attachments.md)
- [常见问题](faq.md)
