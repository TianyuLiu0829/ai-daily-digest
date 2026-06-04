# AI Daily Digest MVP

本项目先做本地 MVP，不做全量版本膨胀。

当前范围：

- 本地运行，优先用 Codex CLI 生成中文摘要，不使用 OpenAI/Gemini API key。
- 每天第一次运行时检查是否已生成；已生成则跳过。
- 抓取 AI 新闻来源，生成固定 `index.html`。
- 固定 GitHub Pages 链接，覆盖同一个页面，不创建每日历史链接。
- 页面顶部显示抓取状态：成功、无当日内容、抓取失败、解析失败。
- 核心来源失败会醒目标出，其他来源失败不阻塞整份日报。
- 页面支持勾选新闻，并一键复制标题+链接。
- 第一版不做 Gmail；Safari 直接收藏固定 Pages 页面或本地 `index.html`。

后续再加：

- Odysseus
- YouTube
- Reddit
- Gmail 通知

## 本地运行

```sh
node scripts/generate-digest.js
```

强制重新生成：

```sh
node scripts/generate-digest.js --force
```

不调用 Codex，只用本地降级摘要：

```sh
node scripts/generate-digest.js --force --no-codex
```

## Codex 非交互运行

本机已检测到 Codex CLI：

```text
/Applications/Codex.app/Contents/Resources/codex
```

CLI 支持非交互命令：

```sh
/Applications/Codex.app/Contents/Resources/codex exec --help
```

当前沙盒网络下，`codex doctor` 显示 ChatGPT/Codex endpoint 不可达；这更像是当前执行环境的网络限制，不代表你电脑真实网络一定不可用。脚本已做降级：Codex 不可用时仍会生成页面并在顶部显示状态。

## GitHub Pages 状态

已创建 public repo：

```text
https://github.com/TianyuLiu0829/ai-daily-digest
```

固定 Pages 链接：

```text
https://tianyuliu0829.github.io/ai-daily-digest/
```

当前 Pages 发布源为 `main` 分支根目录。发布时没有创建每日历史链接，只覆盖固定 `index.html`。

注意：本机命令行当前没有可用的 GitHub HTTPS/SSH 推送凭据，所以这次 `index.html` 是通过浏览器写入 GitHub 的。后续如果要让脚本自动推送，需要再配置 GitHub CLI、SSH key 或 token。

## 可选本地自动化

`launchd/com.ai-daily-digest.plist.template` 是 macOS 定时模板：登录时运行一次，之后每小时检查一次。由于脚本每天只生成一次，所以不会重复覆盖。

安装到 `~/Library/LaunchAgents` 需要写入用户系统目录，当前没有自动安装。
