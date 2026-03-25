# overleaf-sync (ov)

手动同步本地与 Overleaf 项目的 CLI 工具。

GitHub: https://github.com/LiangChengBupt/overleaf-sync-tool

## 功能概览

- 手动同步：`ov sync`（不会后台自动频繁同步）
- 双向同步：本地 <-> 远端（上传/下载/删除）
- 文本冲突自动合并（可合并时）
- 复用 Overleaf Workshop 的项目配置文件：`.overleaf/settings.json`

## 安装方式

### 1) 从源码安装（当前推荐）

```bash
git clone https://github.com/LiangChengBupt/overleaf-sync-tool.git
cd overleaf-sync-tool
npm install
npm run build
npm link
```

安装后验证：

```bash
which ov
ov --version
```

预期 `which ov` 指向你的 npm 全局 bin（例如 `~/.npm-global/bin/ov`）。

### 2) 从 npm 安装

```bash
npm install -g overleaf-sync
```

## 升级（源码安装方式）

```bash
cd overleaf-sync-tool
git pull
npm install
npm run build
npm link
```

## 卸载

```bash
npm unlink -g overleaf-sync
hash -r
which ov
```

如果仍有旧残留链接（例如 `/usr/local/bin/ov`）：

```bash
sudo rm -f /usr/local/bin/ov
hash -r
which ov
```

## 项目配置（每个项目都要有）

项目根目录需要存在：`.overleaf/settings.json`

可通过两种方式获取：

1. 用 Overleaf Workshop 打开一次项目（自动生成）
2. 用 `ov uri` 生成后手动写入

示例：

```json
{
  "uri": "overleaf-workshop://www.overleaf.com/my-paper?user%3D<userId>%26project%3D<projectId>",
  "serverName": "www.overleaf.com",
  "projectName": "my-paper",
  "enableCompileNPreview": false,
  "ignore-patterns": [
    "**/*.aux",
    "**/*.log"
  ]
}
```

## 登录与凭据

首次登录（或 cookie 过期后重新登录）：

```bash
ov login --server www.overleaf.com --cookie "overleaf_session2=..."
```

凭据保存位置：

- `~/.overleaf-sync/credentials.json`

说明：

- 同一个 Overleaf 服务器下，多个项目可复用同一份登录凭据。
- cookie 过期时会报认证失败，重新执行 `ov login` 即可。

## 使用

```bash
# 查看当前项目配置
ov config

# 同步一次
ov sync

# 详细日志
ov sync --verbose

# 指定配置文件
ov sync --config /path/to/.overleaf/settings.json
```

推荐日常流程：

```bash
cd "/path/to/your/project"
ov sync --verbose
```

## 常见问题

- `Authentication failed`
  - 重新执行 `ov login`（cookie 失效）。

- `missing/bad ?projectId=... query flag on handshake`
  - 使用最新代码重新安装并 link：
    `npm install && npm run build && npm link`

- `node_modules` 权限问题（之前用了 sudo 安装）
  - 修复权限后重装：
    `sudo chown -R "$USER":staff /path/to/overleaf-sync-tool && rm -rf node_modules && npm install`

- 看到 `(DEP0044) util.isArray is deprecated`
  - 这是旧版 socket.io-client 的弃用警告，通常不影响同步。

## 与 Overleaf Workshop 的关系

- 本工具是独立 CLI，可以单独安装和使用。
- 但配置格式与 Workshop 兼容，且可复用其登录信息来源。

## License

MIT
