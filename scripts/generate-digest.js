#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var INDEX_PATH = path.join(ROOT, 'index.html');
var STATE_PATH = path.join(ROOT, '.digest-state.json');
var INPUT_PATH = path.join(ROOT, '.digest-last-input.json');
var OUTPUT_PATH = path.join(ROOT, '.digest-last-output.json');
var REPAIR_OUTPUT_PATH = path.join(ROOT, '.digest-last-repair-output.json');
var RENDER_PATH = path.join(ROOT, '.digest-last-render.json');
var SOURCE_CACHE_PATH = path.join(ROOT, '.digest-source-cache.json');
var AUDIT_PATH = path.join(ROOT, '.digest-last-audit.json');
var SOURCES_PATH = path.join(ROOT, 'config', 'sources.json');
var EDITORIAL_RULES_PATH = path.join(ROOT, 'config', 'editorial-rules.md');
var SCHEMA_PATH = path.join(ROOT, 'codex-output.schema.json');
var TEMPLATE_PATH = path.join(ROOT, 'templates', 'digest.html');
var CODEX_BIN = resolveCodexBin();
var DISPLAY_CATEGORY_IDS = ['news', 'app', 'fund', 'research', 'github'];
var MIN_ITEMS_PER_CATEGORY = parseInt(process.env.DIGEST_MIN_ITEMS_PER_CATEGORY || '5', 10);
var DEFAULT_MAX_ITEMS = Math.max(30, MIN_ITEMS_PER_CATEGORY * DISPLAY_CATEGORY_IDS.length);
var MAX_ITEMS = parseInt(process.env.DIGEST_MAX_ITEMS || String(DEFAULT_MAX_ITEMS), 10);
var FETCH_TIMEOUT_MS = parseInt(process.env.DIGEST_FETCH_TIMEOUT_MS || '18000', 10);
var CODEX_TIMEOUT_MS = parseInt(process.env.DIGEST_CODEX_TIMEOUT_MS || '180000', 10);
var PAGES_URL = process.env.DIGEST_PAGES_URL || 'https://tianyuliu0829.github.io/ai-daily-digest/';
var REQUIRED_CATEGORY_IDS = DISPLAY_CATEGORY_IDS;
var DEFAULT_FALLBACK_DAYS = parseInt(process.env.DIGEST_FALLBACK_DAYS || '7', 10);
var GENERIC_FALLBACK_INSIGHT = '对轻度 AI 工作流用户：先判断这条新闻是否会影响你正在用的工具、价格、权限或自动化能力。';
var SOURCE_CACHE_LIMIT = parseInt(process.env.DIGEST_SOURCE_CACHE_LIMIT || '40', 10);

function resolveCodexBin() {
  var candidates = [
    process.env.CODEX_BIN || '',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT Classic.app/Contents/Resources/codex'
  ];
  var i;
  var found;
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  found = childProcess.spawnSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  if (!found.error && found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  return process.env.CODEX_BIN || candidates[1];
}

function hasFlag(name) {
  return process.argv.indexOf(name) !== -1;
}

function pad(num) {
  return num < 10 ? '0' + num : '' + num;
}

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function shiftISO(iso, days) {
  var d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function dateZh(iso) {
  var parts = iso.split('-');
  return parts[0] + '年' + parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日';
}

function dateTimeText(dateText) {
  var date;
  if (!dateText) return '发布时间未知';
  date = new Date(dateText);
  if (isNaN(date.getTime())) return dateText;
  return date.getFullYear() + '年' + pad(date.getMonth() + 1) + '月' + pad(date.getDate()) + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function readText(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function runCommand(command, args) {
  var result = childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null
  };
}

function runCommandOrThrow(command, args) {
  var result = runCommand(command, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed: ' + compactText(result.stderr || result.stdout, 700));
  }
  return result;
}

function hasGitChanges() {
  var result = runCommand('git', ['status', '--porcelain']);
  if (result.error || result.status !== 0) return true;
  return result.stdout.trim().length > 0;
}

function hasIndexChange() {
  var result = runCommand('git', ['status', '--porcelain', '--', 'index.html']);
  if (result.error || result.status !== 0) return true;
  return result.stdout.trim().length > 0;
}

function hasUnpushedCommits() {
  var upstream = runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.error || upstream.status !== 0) return false;
  var result = runCommand('git', ['rev-list', '--count', '@{u}..HEAD']);
  if (result.error || result.status !== 0) return true;
  return parseInt(result.stdout.trim() || '0', 10) > 0;
}

function publishToGitHub(iso) {
  if (hasFlag('--no-publish')) {
    return {
      published: false,
      skipped: true,
      reason: 'disabled by --no-publish'
    };
  }
  runCommandOrThrow('git', ['add', 'index.html']);
  if (!hasIndexChange()) {
    if (hasUnpushedCommits()) {
      runCommandOrThrow('git', ['push']);
      return {
        published: true,
        skipped: false,
        reason: 'pushed pending commits',
        url: PAGES_URL
      };
    }
    return {
      published: true,
      skipped: true,
      reason: 'index.html unchanged',
      url: PAGES_URL
    };
  }
  runCommandOrThrow('git', ['commit', '-m', 'Update AI Daily Digest for ' + iso]);
  runCommandOrThrow('git', ['push']);
  return {
    published: true,
    skipped: false,
    reason: 'pushed index.html',
    url: PAGES_URL
  };
}

function updateState(patch) {
  var state = readJson(STATE_PATH, {});
  var key;
  for (key in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      state[key] = patch[key];
    }
  }
  writeJson(STATE_PATH, state);
  return state;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function (_, code) {
      return String.fromCharCode(parseInt(code, 10));
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch (err) {
    return url || '';
  }
}

function sameDay(dateText, iso) {
  if (!dateText) return false;
  var date = new Date(dateText);
  if (isNaN(date.getTime())) {
    return String(dateText).indexOf(iso) !== -1;
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) === iso;
}

function compactText(text, max) {
  text = stripTags(text);
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function fetchWithTimeout(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'AI Daily Digest MVP/0.1'
    }
  }).then(function (res) {
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).catch(function (err) {
    clearTimeout(timer);
    throw err;
  });
}

function fetchJsonWithTimeout(url) {
  return fetchWithTimeout(url).then(function (text) {
    return JSON.parse(text);
  });
}

function extractGitHubRepo(url) {
  var match = /^https?:\/\/github\.com\/([^\/?#]+)\/([^\/?#]+)/i.exec(String(url || ''));
  if (!match) return null;
  if (/^(topics|features|marketplace|collections|about|pricing|login|join)$/i.test(match[1])) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, '')
  };
}

function compactNumber(num) {
  num = parseInt(num || 0, 10);
  if (num >= 10000) return Math.round(num / 1000) / 10 + '万';
  if (num >= 1000) return Math.round(num / 100) / 10 + 'k';
  return String(num);
}

function monthsSince(dateText) {
  var date = new Date(dateText);
  var now = new Date();
  if (isNaN(date.getTime())) return 999;
  return (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
}

function repoIsRecentlyMaintained(meta) {
  return meta && (meta.pushed_at || meta.updated_at) && monthsSince(meta.pushed_at || meta.updated_at) <= 18;
}

function enrichWithGitHubMeta(item, meta, intro) {
  var repoName = meta.full_name || item.title;
  var description = meta.description || item.summary || '';
  var license = meta.license && meta.license.spdx_id ? meta.license.spdx_id : '未标明';
  var topics = Array.isArray(meta.topics) && meta.topics.length ? meta.topics.slice(0, 6).join(', ') : '未标明';
  var maintained = meta.archived ? '项目已归档' : (repoIsRecentlyMaintained(meta) ? '仍在维护' : '最近维护信号偏弱');
  item.title = repoName + (description ? '：' + compactText(description, 80) : '');
  item.summary = compactText((intro ? intro + ' ' : '') +
    '用途：' + (description || '仓库描述有限，需要打开项目页确认。') +
    ' 热度：' + compactNumber(meta.stargazers_count) + ' stars，' + compactNumber(meta.forks_count) + ' forks。' +
    ' 维护：最近 push ' + dateTimeText(meta.pushed_at || meta.updated_at) + '，' + maintained + '。' +
    ' 许可证：' + license + '。主题：' + topics + '。', 700);
  item.link = meta.html_url || item.link;
  item.published = meta.pushed_at || meta.updated_at || item.published;
  item.categoryOverride = 'github';
  item.repoArchived = !!meta.archived;
  item.repoMaintained = !meta.archived && repoIsRecentlyMaintained(meta);
  item.repoStars = parseInt(meta.stargazers_count || 0, 10);
  item.repoForks = parseInt(meta.forks_count || 0, 10);
  item.repoLicense = license;
  item.repoTopics = Array.isArray(meta.topics) ? meta.topics.slice(0, 8) : [];
  item.repoPushedAt = meta.pushed_at || '';
  return item;
}

function enrichDirectGitHubItem(item) {
  var repo = extractGitHubRepo(item.link);
  if (!repo) return Promise.resolve(item);
  return fetchJsonWithTimeout('https://api.github.com/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo)).then(function (meta) {
    return enrichWithGitHubMeta(item, meta, 'GitHub 项目实用性检查。');
  }).catch(function () {
    item.categoryOverride = 'github';
    return item;
  });
}

function parseNextData(html) {
  var match = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
}

function collectHelloGithubProjects(node, categoryName, out) {
  var key;
  var i;
  var nextCategory = categoryName;
  if (!node) return;
  if (node.category_name) nextCategory = node.category_name;
  if (Array.isArray(node)) {
    for (i = 0; i < node.length; i++) collectHelloGithubProjects(node[i], nextCategory, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (node.github_url && node.name) {
    out.push({
      name: node.name,
      fullName: node.full_name || '',
      description: node.description || node.description_en || '',
      githubUrl: node.github_url,
      stars: parseInt(node.stars || 0, 10),
      forks: parseInt(node.forks || 0, 10),
      watch: parseInt(node.watch || 0, 10),
      publishAt: node.publish_at || '',
      categoryName: nextCategory || ''
    });
  }
  for (key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      collectHelloGithubProjects(node[key], nextCategory, out);
    }
  }
}

function helloGithubProjectScore(project) {
  var text = project.name + ' ' + project.description + ' ' + project.categoryName;
  var score = 0;
  if (project.categoryName === '人工智能') score += 25;
  if (/人工智能|AI|agent|智能体|LLM|大模型|Claude|Codex|Cursor|Gemini|ChatGPT|编程助手|Token|模型|workflow/i.test(text)) score += 10;
  if (/工具|助手|工作流|coding|code|price|usage|memory|desktop|CLI/i.test(text)) score += 3;
  score += Math.min(6, Math.log(Math.max(project.stars, 1)) / Math.log(10));
  return score;
}

function enrichHelloGithubItem(item) {
  return fetchWithTimeout(item.link).then(function (html) {
    var data = parseNextData(html);
    var projects = [];
    var chosen;
    var pending;
    if (!data) return item;
    collectHelloGithubProjects(data, '', projects);
    projects = projects.sort(function (a, b) {
      return helloGithubProjectScore(b) - helloGithubProjectScore(a);
    });
    chosen = projects.slice(0, Math.max(MIN_ITEMS_PER_CATEGORY, 5));
    if (chosen.length === 0) return item;
    pending = chosen.map(function (project, index) {
      var cloned = {};
      var key;
      var repo = extractGitHubRepo(project.githubUrl);
      for (key in item) {
        if (Object.prototype.hasOwnProperty.call(item, key)) cloned[key] = item[key];
      }
      cloned.id = item.id + '-hg-' + index;
      cloned.title = project.name + '：' + compactText(project.description, 90);
      cloned.summary = compactText('HelloGitHub ' + (project.categoryName || '开源') + '项目。用途：' + project.description +
        ' 热度：' + compactNumber(project.stars) + ' stars，' + compactNumber(project.forks) + ' forks。来源发布时间：' + dateTimeText(project.publishAt) + '。', 700);
      cloned.link = project.githubUrl;
      cloned.published = project.publishAt || item.published;
      cloned.categoryOverride = 'github';
      if (!repo) return Promise.resolve(cloned);
      return fetchJsonWithTimeout('https://api.github.com/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo)).then(function (meta) {
        return enrichWithGitHubMeta(cloned, meta, 'HelloGitHub 推荐项目，已用 GitHub 元数据复核。');
      }).catch(function () {
        return cloned;
      });
    });
    return Promise.all(pending);
  }).catch(function () {
    item.categoryOverride = 'github';
    return item;
  });
}

function enrichGitHubItems(items) {
  var pending = [];
  var i;
  for (i = 0; i < items.length; i++) {
    if (items[i].sourceId === 'hellogithub') {
      pending.push(enrichHelloGithubItem(items[i]));
    } else if (rawCategory(items[i]) === 'github' || extractGitHubRepo(items[i].link)) {
      pending.push(enrichDirectGitHubItem(items[i]));
    } else {
      pending.push(Promise.resolve(items[i]));
    }
  }
  return Promise.all(pending).then(function (groups) {
    var out = [];
    var i;
    var j;
    for (i = 0; i < groups.length; i++) {
      if (Array.isArray(groups[i])) {
        for (j = 0; j < groups[i].length; j++) out.push(groups[i][j]);
      } else {
        out.push(groups[i]);
      }
    }
    return out;
  });
}

function parseRss(xml, source, iso) {
  var items = [];
  var itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  var match;
  while ((match = itemRegex.exec(xml)) !== null) {
    var block = match[0];
    var title = firstXml(block, 'title');
    var link = firstXml(block, 'link');
    var date = firstXml(block, 'pubDate') || firstXml(block, 'dc:date');
    var summary = firstXml(block, 'description') || firstXml(block, 'content:encoded');
    if (title && link && sameDay(date, iso)) {
      items.push(makeItem(source, title, summary, link, date));
    }
  }
  if (items.length === 0 && xml.indexOf('<item') === -1) {
    throw new Error('RSS item not found');
  }
  return items;
}

function firstXml(block, tag) {
  var pattern = new RegExp('<' + tag.replace(':', '\\:') + '[^>]*>([\\s\\S]*?)<\\/' + tag.replace(':', '\\:') + '>', 'i');
  var match = pattern.exec(block);
  return match ? stripTags(match[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
}

function parseTldrHtml(html, source, iso) {
  var items = [];
  var sections = html.split(/<h2\b|##\s+/i);
  var i;
  for (i = 1; i < sections.length; i++) {
    var chunk = sections[i];
    var linkMatch = /href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    var mdMatch = /\[[^\]]+\]\(([^)]+)\)/.exec(chunk);
    var title = '';
    var link = '';
    if (linkMatch) {
      link = absoluteUrl(linkMatch[1], source.url);
      title = stripTags(linkMatch[2]);
    } else if (mdMatch) {
      link = absoluteUrl(mdMatch[1], source.url);
      title = stripTags(chunk.split('\n')[0] || '');
    }
    var dateMatch = /(20\d\d-\d\d-\d\d(?:T[^\s<"'>]*)?)/.exec(chunk);
    var date = dateMatch ? dateMatch[1] : '';
    if (!title || !link || !sameDay(date, iso)) continue;
    var afterTitle = chunk.replace(/^[\s\S]*?<\/a>/i, ' ').replace(/^[^\n]*\n/, ' ');
    var summary = compactText(afterTitle.replace(/20\d\d-\d\d-\d\d(?:T[^\s<"'>]*)?/g, ' '), 560);
    if (/sponsor/i.test(title + ' ' + summary)) continue;
    items.push(makeItem(source, title, summary, link, date));
  }
  return items;
}

function parseGenericHtml(html, source) {
  var items = [];
  var seen = {};
  var anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = anchorRegex.exec(html)) !== null) {
    var link = absoluteUrl(match[1], source.url);
    var title = stripTags(match[2]);
    if (title.length < 24 || title.length > 180) continue;
    if (!/^https?:\/\//.test(link)) continue;
    if (seen[link]) continue;
    seen[link] = true;
    items.push(makeItem(source, title, '', link, ''));
    if (items.length >= 8) break;
  }
  if (items.length === 0) throw new Error('no usable links found');
  return items;
}

function makeItem(source, title, summary, link, date) {
  return {
    id: source.id + '-' + Math.random().toString(36).slice(2, 8),
    sourceId: source.id,
    sourceName: source.name,
    sourceCore: !!source.core,
    title: compactText(title, 180),
    summary: compactText(summary, 700),
    link: link,
    published: date || '',
    categoryOverride: source.category || ''
  };
}

function cloneItem(item) {
  var out = {};
  var key;
  for (key in item) {
    if (Object.prototype.hasOwnProperty.call(item, key)) out[key] = item[key];
  }
  return out;
}

function cloneCachedSourceItems(source, sourceCache) {
  var cached = sourceCache && sourceCache[source.id] && Array.isArray(sourceCache[source.id].items) ? sourceCache[source.id] : null;
  var out = [];
  var i;
  var cloned;
  if (!cached) return out;
  for (i = 0; i < cached.items.length; i++) {
    cloned = cloneItem(cached.items[i]);
    cloned.sourceCacheFallback = true;
    cloned.sourceCacheDate = cached.updatedAt || '';
    cloned.sourceId = cloned.sourceId || source.id;
    cloned.sourceName = cloned.sourceName || source.name;
    cloned.sourceCore = !!source.core;
    out.push(cloned);
  }
  return out;
}

function cacheSourceItems(sourceCache, source, items) {
  if (!items || items.length === 0) return false;
  sourceCache[source.id] = {
    updatedAt: nowText(),
    sourceName: source.name,
    homepage: source.homepage || '',
    items: items.slice(0, SOURCE_CACHE_LIMIT).map(function (item) {
      var cloned = cloneItem(item);
      delete cloned.sourceCacheFallback;
      delete cloned.sourceCacheDate;
      return cloned;
    })
  };
  return true;
}

function buildEvidenceForItem(item) {
  var facts = [];
  var limits = [];
  facts.push('来源：' + item.sourceName);
  facts.push('发布时间：' + dateTimeText(item.published));
  facts.push('栏目线索：' + rawCategory(item));
  if (item.sourceCore) facts.push('核心源');
  if (item.repoStars !== undefined) facts.push('GitHub 热度：' + compactNumber(item.repoStars) + ' stars，' + compactNumber(item.repoForks) + ' forks');
  if (item.repoPushedAt) facts.push('最近 push：' + dateTimeText(item.repoPushedAt));
  if (item.repoLicense) facts.push('许可证：' + item.repoLicense);
  if (item.repoTopics && item.repoTopics.length) facts.push('topics：' + item.repoTopics.slice(0, 6).join(', '));
  if (item.repoArchived) limits.push('GitHub 仓库已 archived，不应作为可直接采用的新工具推荐');
  if (item.repoMaintained === false) limits.push('维护信号偏弱，需要谨慎');
  if (item.sourceCacheFallback) limits.push('来源本次未提供可用新内容，使用最近一次成功抓取的候选补位');
  if (!item.summary) limits.push('原始摘要为空，只能依据标题和来源判断');
  return {
    facts: facts,
    usefulDetails: compactText(item.summary || item.title, 360),
    limits: limits
  };
}

function prepareCodexInputItems(items) {
  return items.map(function (item) {
    return {
      id: item.id,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      sourceCore: !!item.sourceCore,
      title: compactText(item.title, 160),
      summary: compactText(item.summary, rawCategory(item) === 'github' ? 520 : 420),
      link: item.link,
      published: item.published || '',
      categoryOverride: item.categoryOverride || '',
      categoryHint: rawCategory(item),
      evidence: buildEvidenceForItem(item)
    };
  });
}

function inputItemsAreCompact(items) {
  return Array.isArray(items) && items.length > 0 && !!items[0].evidence;
}

function parseSource(html, source, iso) {
  if (source.parser === 'rss') return parseRss(html, source, iso);
  if (source.parser === 'tldrHtml') return parseTldrHtml(html, source, iso);
  return parseGenericHtml(html, source, iso);
}

function parseSourceWithFallback(html, source, iso) {
  var parsed = parseSource(html, source, iso);
  var previousIso;
  var previous;
  var maxFallbackDays;
  var i;
  var combined = parsed.slice();
  var fallbackDate = '';
  var fallbackCount = 0;
  var seenLinks = {};
  for (i = 0; i < combined.length; i++) {
    seenLinks[combined[i].link.replace(/[?#].*$/, '')] = true;
  }
  if (parsed.length > 0) {
    maxFallbackDays = Math.max(0, parseInt(source.fallbackDays || String(DEFAULT_FALLBACK_DAYS), 10));
    for (i = 1; i <= maxFallbackDays; i++) {
      previousIso = shiftISO(iso, -i);
      previous = parseSource(html, source, previousIso);
      previous.forEach(function (item) {
        var key = item.link.replace(/[?#].*$/, '');
        if (seenLinks[key]) return;
        seenLinks[key] = true;
        combined.push(item);
        fallbackCount++;
      });
    }
    return {
      items: combined,
      status: 'success',
      fallbackDate: fallbackCount > 0 ? shiftISO(iso, -maxFallbackDays) : ''
    };
  }
  maxFallbackDays = Math.max(1, parseInt(source.fallbackDays || String(DEFAULT_FALLBACK_DAYS), 10));
  for (i = 1; i <= maxFallbackDays; i++) {
    previousIso = shiftISO(iso, -i);
    previous = parseSource(html, source, previousIso);
    if (previous.length > 0) {
      fallbackDate = previousIso;
      combined = combined.concat(previous);
      for (i = i + 1; i <= maxFallbackDays; i++) {
        previousIso = shiftISO(iso, -i);
        previous = parseSource(html, source, previousIso);
        combined = combined.concat(previous);
      }
      return {
        items: combined,
        status: 'previous_day',
        fallbackDate: fallbackDate
      };
    }
  }
  return {
    items: parsed,
    status: 'no_today',
    fallbackDate: ''
  };
}

function rawCategory(item) {
  var text = item.sourceName + ' ' + item.title + ' ' + item.summary + ' ' + item.link;
  if (item.categoryOverride) return item.categoryOverride;
  if (/github|hellogithub/i.test(item.sourceName + ' ' + item.link)) return 'github';
  if (/融资|募资|funding|fundraise|raised|raises|valuation|估值|ipo|收购|acquisition/i.test(text)) return 'fund';
  if (/论文|研究|benchmark|模型训练|开源模型|arxiv|paper|research|technical report|eval|inference|training/i.test(text)) return 'research';
  if (/product|launch|app|tool|agent|workflow|automation|copilot|cursor|chatgpt|claude|gemini|产品|工具|发布|上线|工作流/i.test(text)) return 'app';
  return 'news';
}

function hasCategory(items, categoryId) {
  var i;
  for (i = 0; i < items.length; i++) {
    if (rawCategory(items[i]) === categoryId) return true;
  }
  return false;
}

function countCategory(items, categoryId) {
  var count = 0;
  var i;
  for (i = 0; i < items.length; i++) {
    if (rawCategory(items[i]) === categoryId) count++;
  }
  return count;
}

function hasSource(items, sourceId) {
  var i;
  for (i = 0; i < items.length; i++) {
    if (items[i].sourceId === sourceId) return true;
  }
  return false;
}

function pushCategoryCandidate(selected, scored, categoryId) {
  var i;
  var candidate;
  for (i = 0; i < scored.length; i++) {
    candidate = scored[i].item;
    if (selected.indexOf(candidate) !== -1) continue;
    if (rawCategory(candidate) !== categoryId) continue;
    selected.push(candidate);
    return true;
  }
  return false;
}

function pushSourceCandidate(selected, scored, sourceId) {
  var i;
  var candidate;
  for (i = 0; i < scored.length; i++) {
    candidate = scored[i].item;
    if (selected.indexOf(candidate) !== -1) continue;
    if (candidate.sourceId !== sourceId) continue;
    selected.push(candidate);
    return true;
  }
  return false;
}

function ensureRequiredCategoryCandidates(selected, scored) {
  var i;
  var filled;
  for (i = 0; i < REQUIRED_CATEGORY_IDS.length; i++) {
    filled = true;
    while (countCategory(selected, REQUIRED_CATEGORY_IDS[i]) < MIN_ITEMS_PER_CATEGORY && filled) {
      filled = pushCategoryCandidate(selected, scored, REQUIRED_CATEGORY_IDS[i]);
    }
  }
  if (!hasSource(selected, 'hellogithub')) {
    pushSourceCandidate(selected, scored, 'hellogithub');
  }
  return selected;
}

function dedupe(items) {
  var out = [];
  var seen = {};
  var i;
  for (i = 0; i < items.length; i++) {
    var key = items[i].link.replace(/[?#].*$/, '');
    var titleKey = items[i].title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').slice(0, 80);
    if (seen[key] || seen[titleKey]) continue;
    seen[key] = true;
    seen[titleKey] = true;
    out.push(items[i]);
  }
  return out;
}

function rankItems(items) {
  var highWords = /openai|anthropic|google|deepmind|nvidia|microsoft|meta|apple|amazon|claude|chatgpt|gemini|copilot|codex|cursor|perplexity|deepseek|qwen|mistral|llama|agent|agents|automation|workflow|memory|browser|email|calendar|files|notion|canva|adobe|zapier|price|pricing|free|subscription|privacy|copyright|security|safety|policy|regulation|china/i;
  var lowSignalWords = /bug fix|bugfix|minor fix|patch release|maintenance|typo|docs update|documentation update|sdk update|sdk release|dependency update|performance bug|ui polish|rumor|rumour|unconfirmed|speculation|speculative/i;
  var rescueWords = /security|privacy|data loss|permission|agent|model|launch|release|pricing|price|free|subscription|copilot|workflow|automation|memory|browser|email|calendar|files|customer data|enterprise|consumer/i;
  var scored = [];
  var selected = [];
  var sourceCounts = {};
  var i;
  for (i = 0; i < items.length; i++) {
    var text = items[i].title + ' ' + items[i].summary;
    if (lowSignalWords.test(text) && !rescueWords.test(text)) continue;
    if (items[i].repoArchived) continue;
    var score = 0;
    if (items[i].sourceCore) score += 1;
    if (highWords.test(text)) score += 3;
    if (/OpenAI|Google|DeepMind|Microsoft|GitHub|Cursor|Zapier|Canva|VentureBeat|TechCrunch|Decoder/i.test(items[i].sourceName)) score += 1;
    if (/official|blog|docs|changelog|release|model|tool|product|agent|automation|workflow|pricing|privacy|security/i.test(text)) score += 1;
    if (/funding|raises|valuation|stock|shares/i.test(text) && !/product|launch|acquire|acquisition|partnership|integrat/i.test(text)) score -= 1;
    if (rawCategory(items[i]) === 'fund' || rawCategory(items[i]) === 'research' || rawCategory(items[i]) === 'github') score += 1;
    if (items[i].repoMaintained === false) score -= 2;
    if (items[i].sourceCacheFallback) score -= 1;
    scored.push({ item: items[i], score: score });
  }
  scored = scored.sort(function (a, b) {
    var as = a.score;
    var bs = b.score;
    return bs - as;
  });
  ensureRequiredCategoryCandidates(selected, scored);
  for (i = 0; i < scored.length; i++) {
    var sourceId = scored[i].item.sourceId;
    var current = sourceCounts[sourceId] || 0;
    if (selected.indexOf(scored[i].item) !== -1) {
      sourceCounts[sourceId] = current + 1;
      continue;
    }
    if (current >= 3) continue;
    selected.push(scored[i].item);
    sourceCounts[sourceId] = current + 1;
    if (selected.length >= MAX_ITEMS) return selected;
  }
  for (i = 0; i < scored.length; i++) {
    if (selected.indexOf(scored[i].item) !== -1) continue;
    selected.push(scored[i].item);
    if (selected.length >= MAX_ITEMS) return selected;
  }
  return selected;
}

function categoryLabelForItem(item, index) {
  var category = rawCategory(item);
  if (category === 'github') return 'GitHub';
  if (category === 'fund') return '融资';
  if (category === 'research') return '研究';
  if (category === 'app') return '产品';
  return index < 2 ? '头条' : '快讯';
}

function fallbackDigest(items) {
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    out.push({
      itemId: items[i].id,
      titleZh: items[i].title,
      summaryZh: items[i].summary || '原始来源没有提供足够摘要，建议点开原文查看细节。',
      insightZh: '对轻度 AI 工作流用户：先判断这条新闻是否会影响你正在用的工具、价格、权限或自动化能力。如果会，记录一个可测试的小动作；如果不会，了解趋势即可，不必立刻追新。',
      category: categoryLabelForItem(items[i], i),
      importance: i < 2 ? 'high' : 'normal'
    });
  }
  return { items: out };
}

function hasDigestCategory(items, digestItems, categoryId) {
  var i;
  for (i = 0; i < items.length; i++) {
    if (classifyDigestItem(items[i], digestItems[i] || {}) === categoryId) return true;
  }
  return false;
}

function countDigestCategory(items, digestItems, categoryId) {
  var count = 0;
  var i;
  for (i = 0; i < items.length; i++) {
    if (classifyDigestItem(items[i], digestItems[i] || {}) === categoryId) count++;
  }
  return count;
}

function ensureRequiredDigestCategories(selectedItems, selectedDigest, allItems) {
  var i;
  var j;
  var categoryId;
  var item;
  var alreadySelected = {};
  for (i = 0; i < selectedItems.length; i++) alreadySelected[selectedItems[i].id] = true;
  for (i = 0; i < REQUIRED_CATEGORY_IDS.length; i++) {
    categoryId = REQUIRED_CATEGORY_IDS[i];
    for (j = 0; j < allItems.length; j++) {
      if (countDigestCategory(selectedItems, selectedDigest, categoryId) >= MIN_ITEMS_PER_CATEGORY) break;
      item = allItems[j];
      if (alreadySelected[item.id] || rawCategory(item) !== categoryId) continue;
      selectedItems.push(item);
      selectedDigest.push(fallbackDigest([item]).items[0]);
      alreadySelected[item.id] = true;
      break;
    }
  }
  if (!hasSource(selectedItems, 'hellogithub')) {
    for (j = 0; j < allItems.length; j++) {
      item = allItems[j];
      if (alreadySelected[item.id] || item.sourceId !== 'hellogithub') continue;
      selectedItems.push(item);
      selectedDigest.push(fallbackDigest([item]).items[0]);
      alreadySelected[item.id] = true;
      break;
    }
  }
}

function alignDigestItems(items, digest) {
  var rawById = {};
  var selectedItems = [];
  var selectedDigest = [];
  var seen = {};
  var i;
  var entry;
  var raw;
  for (i = 0; i < items.length; i++) {
    rawById[items[i].id] = items[i];
  }
  for (i = 0; i < digest.items.length; i++) {
    entry = digest.items[i];
    raw = rawById[entry.itemId];
    if (!raw || seen[entry.itemId]) continue;
    if (!entry.titleZh || !entry.summaryZh || !entry.insightZh) continue;
    seen[entry.itemId] = true;
    selectedItems.push(raw);
    selectedDigest.push(entry);
  }
  if (selectedItems.length === 0) {
    return {
      items: items,
      digest: fallbackDigest(items)
    };
  }
  ensureRequiredDigestCategories(selectedItems, selectedDigest, items);
  return {
    items: selectedItems,
    digest: { items: selectedDigest }
  };
}

function chineseCharCount(text) {
  var match = String(text || '').match(/[\u4e00-\u9fff]/g);
  return match ? match.length : 0;
}

function latinWordCount(text) {
  var match = String(text || '').match(/[A-Za-z][A-Za-z'’-]{2,}/g);
  return match ? match.length : 0;
}

function looksUntranslated(text, minLatinWords, minChineseChars) {
  var value = compactText(text || '', 600);
  if (!value) return true;
  return chineseCharCount(value) < minChineseChars && latinWordCount(value) >= minLatinWords;
}

function isGenericFallbackInsight(text) {
  return String(text || '').indexOf(GENERIC_FALLBACK_INSIGHT) !== -1;
}

function needsDigestRepair(raw, digestItem) {
  if (!raw || !digestItem) return true;
  if (!digestItem.titleZh || !digestItem.summaryZh || !digestItem.insightZh) return true;
  if (looksUntranslated(digestItem.titleZh, 4, 2)) return true;
  if (looksUntranslated(digestItem.summaryZh, 8, 4)) return true;
  if (looksUntranslated(digestItem.insightZh, 8, 4)) return true;
  if (isGenericFallbackInsight(digestItem.insightZh)) return true;
  return false;
}

function findDigestRepairTargets(items, digest) {
  var targets = [];
  var digestItems = digest && Array.isArray(digest.items) ? digest.items : [];
  var i;
  for (i = 0; i < items.length; i++) {
    if (needsDigestRepair(items[i], digestItems[i])) {
      targets.push({
        raw: items[i],
        currentDigest: digestItems[i] || fallbackDigest([items[i]]).items[0]
      });
    }
  }
  return targets;
}

function mergeDigestRepair(digest, repairedDigest) {
  var repairedById = {};
  var merged = [];
  var i;
  var entry;
  if (!repairedDigest || !Array.isArray(repairedDigest.items)) return digest;
  for (i = 0; i < repairedDigest.items.length; i++) {
    entry = repairedDigest.items[i];
    if (entry && entry.itemId) repairedById[entry.itemId] = entry;
  }
  for (i = 0; i < digest.items.length; i++) {
    entry = digest.items[i];
    merged.push(repairedById[entry.itemId] || entry);
  }
  return { items: merged };
}

function runCodexDigestRepair(targets, iso) {
  if (hasFlag('--no-codex')) {
    return Promise.reject(new Error('Codex disabled by --no-codex'));
  }
  if (!fs.existsSync(CODEX_BIN)) {
    return Promise.reject(new Error('Codex CLI not found: ' + CODEX_BIN));
  }
  var input = {
    date: iso,
    instruction: '请只修复这些中文日报条目中的漏翻译、英文摘要或通用 fallback 解读。',
    editorialRules: readText(EDITORIAL_RULES_PATH, ''),
    targets: targets
  };
  var prompt = [
    '你是 AI Daily Digest 的中文质量检查编辑。',
    '以下条目已经入选日报，但存在英文标题/摘要、缺少中文实用解读，或使用了通用 fallback 文案。',
    '只修复 stdin JSON 中 targets 里的条目；每条必须原样返回 currentDigest.itemId。',
    'titleZh 必须是自然中文标题，可以保留必要英文产品名、公司名、项目名。',
    'summaryZh 必须是 2-3 句中文摘要；不要照搬英文原句。',
    'insightZh 必须给对轻度 AI 工作流用户的明确判断：可以试用、值得关注、暂不急用、适合个人 workflow、需要谨慎或先观察。',
    '如果原文信息有限，明确写信息有限；不要编造原文没有的信息。',
    'category 和 importance 沿用 currentDigest，除非明显错误。',
    '只输出符合 schema 的 JSON。'
  ].join('\n');

  return new Promise(function (resolve, reject) {
    var args = [
      '-c', 'model_reasoning_effort="low"',
      '--ask-for-approval', 'never',
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--output-schema', SCHEMA_PATH,
      '--output-last-message', REPAIR_OUTPUT_PATH,
      '-'
    ];
    var child = childProcess.spawn(CODEX_BIN, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    var stdout = '';
    var stderr = '';
    var timer = setTimeout(function () {
      child.kill('SIGTERM');
      reject(new Error('Codex repair timeout'));
    }, CODEX_TIMEOUT_MS);
    child.stdout.on('data', function (data) { stdout += data.toString(); });
    child.stderr.on('data', function (data) { stderr += data.toString(); });
    child.on('error', function (err) {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Codex repair exit ' + code + ': ' + compactText(stderr || stdout, 500)));
        return;
      }
      try {
        var text = fs.existsSync(REPAIR_OUTPUT_PATH) ? fs.readFileSync(REPAIR_OUTPUT_PATH, 'utf8') : stdout;
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('Codex repair JSON parse failed: ' + err.message));
      }
    });
    child.stdin.write(prompt + '\n\n<stdin>\n' + JSON.stringify(input, null, 2) + '\n</stdin>\n');
    child.stdin.end();
  });
}

function repairDigestQuality(items, digest, iso) {
  var targets = findDigestRepairTargets(items, digest);
  if (targets.length === 0 || hasFlag('--no-codex')) {
    return Promise.resolve({ digest: digest, repairedCount: 0, error: '' });
  }
  return runCodexDigestRepair(targets, iso).then(function (repairedDigest) {
    return {
      digest: mergeDigestRepair(digest, repairedDigest),
      repairedCount: targets.length,
      error: ''
    };
  });
}

function auditDigestData(data) {
  var items = data && Array.isArray(data.items) ? data.items : [];
  var digest = data && data.digest ? data.digest : { items: [] };
  var digestItems = Array.isArray(digest.items) ? digest.items : [];
  var repairTargets = findDigestRepairTargets(items, digest);
  var categoryCounts = {};
  var issues = [];
  var i;
  var categoryId;
  var item;
  var digestItem;
  for (i = 0; i < DISPLAY_CATEGORY_IDS.length; i++) categoryCounts[DISPLAY_CATEGORY_IDS[i]] = 0;
  for (i = 0; i < items.length; i++) {
    categoryId = classifyDigestItem(items[i], digestItems[i] || {});
    categoryCounts[categoryId] = (categoryCounts[categoryId] || 0) + 1;
    item = items[i];
    digestItem = digestItems[i] || {};
    if (!item.published) {
      issues.push({ severity: 'warn', type: 'missing_published_time', itemId: item.id, title: digestItem.titleZh || item.title });
    }
    if (item.repoArchived) {
      issues.push({ severity: 'error', type: 'github_archived_repo', itemId: item.id, title: digestItem.titleZh || item.title });
    } else if (item.repoMaintained === false) {
      issues.push({ severity: 'warn', type: 'github_weak_maintenance', itemId: item.id, title: digestItem.titleZh || item.title });
    }
    if (item.sourceCacheFallback) {
      issues.push({ severity: 'info', type: 'source_cache_fallback_item', itemId: item.id, title: digestItem.titleZh || item.title });
    }
  }
  if (items.length !== digestItems.length) {
    issues.push({ severity: 'error', type: 'item_digest_count_mismatch', itemCount: items.length, digestCount: digestItems.length });
  }
  for (i = 0; i < repairTargets.length; i++) {
    issues.push({
      severity: 'error',
      type: 'needs_translation_or_insight_repair',
      itemId: repairTargets[i].currentDigest.itemId,
      title: repairTargets[i].currentDigest.titleZh || repairTargets[i].raw.title
    });
  }
  for (i = 0; i < REQUIRED_CATEGORY_IDS.length; i++) {
    categoryId = REQUIRED_CATEGORY_IDS[i];
    if ((categoryCounts[categoryId] || 0) < MIN_ITEMS_PER_CATEGORY) {
      issues.push({
        severity: 'warn',
        type: 'category_below_target',
        category: categoryId,
        count: categoryCounts[categoryId] || 0,
        target: MIN_ITEMS_PER_CATEGORY
      });
    }
  }
  if (data && Array.isArray(data.sourceResults)) {
    for (i = 0; i < data.sourceResults.length; i++) {
      if (data.sourceResults[i].status === 'fetch_failed' || data.sourceResults[i].status === 'parse_failed') {
        issues.push({
          severity: data.sourceResults[i].core ? 'error' : 'warn',
          type: 'source_failed',
          sourceId: data.sourceResults[i].id,
          sourceName: data.sourceResults[i].name,
          status: data.sourceResults[i].status,
          usedCache: !!data.sourceResults[i].usedCache
        });
      }
    }
  }
  return {
    date: data ? data.date : '',
    generatedAt: data ? data.generatedAt : '',
    overallStatus: data ? data.overallStatus : '',
    itemCount: items.length,
    digestCount: digestItems.length,
    categoryCounts: categoryCounts,
    sourceCount: data && Array.isArray(data.sourceResults) ? data.sourceResults.length : 0,
    issueCount: issues.length,
    errorCount: issues.filter(function (issue) { return issue.severity === 'error'; }).length,
    warnCount: issues.filter(function (issue) { return issue.severity === 'warn'; }).length,
    infoCount: issues.filter(function (issue) { return issue.severity === 'info'; }).length,
    issues: issues
  };
}

function printAudit(audit) {
  console.log('AI Daily Digest audit: ' + (audit.errorCount ? 'needs attention' : 'ok'));
  console.log('Date: ' + (audit.date || 'unknown') + ', items=' + audit.itemCount + ', issues=' + audit.issueCount + ', errors=' + audit.errorCount + ', warnings=' + audit.warnCount);
  console.log('Categories: ' + JSON.stringify(audit.categoryCounts));
  audit.issues.slice(0, 20).forEach(function (issue) {
    console.log('- [' + issue.severity + '] ' + issue.type + (issue.title ? ': ' + compactText(issue.title, 90) : '') + (issue.sourceName ? ': ' + issue.sourceName : ''));
  });
  if (audit.issues.length > 20) console.log('- ... ' + (audit.issues.length - 20) + ' more');
}

function runCodexDigest(items, iso) {
  if (hasFlag('--no-codex')) {
    return Promise.reject(new Error('Codex disabled by --no-codex'));
  }
  if (!fs.existsSync(CODEX_BIN)) {
    return Promise.reject(new Error('Codex CLI not found: ' + CODEX_BIN));
  }
  var input = {
    date: iso,
    instruction: '请把这些 AI 新闻生成中文日报条目。面向轻度 AI 工作流用户，避免空泛，输出必须符合 schema。',
    editorialRules: readText(EDITORIAL_RULES_PATH, ''),
    items: prepareCodexInputItems(items)
  };
  writeJson(INPUT_PATH, input);
  var prompt = [
    '你是 AI Daily Digest 的中文编辑。',
    '基于 stdin JSON 生成最多 ' + MAX_ITEMS + ' 条中文日报。',
    '尽量让行业新闻、产品应用、融资动态、研究技术、GitHub 每个板块至少 ' + MIN_ITEMS_PER_CATEGORY + ' 条；如果某板块可信候选不足，不要用谣言、小 bug fix 或无用更新硬凑。',
    '严格按 editorialRules 筛选：优先消费者 AI、AI 工作流、工具选择、成本/权限/风险变化；排除小 bug fix、SDK patch、纯 hype、纯融资和无实际影响的 benchmark。',
    '候选新闻可能包含前一天内容，这是正常回退；可以总结，但不要把前一天内容写成今天刚发布。',
    'GitHub/HelloGitHub 候选已包含项目用途、stars/forks 和最近更新时间；摘要必须说明它解决什么问题、是否仍在维护、为什么值得或不值得轻度 AI 工作流用户尝试。',
    '如果候选不足，不要硬凑数量；只保留真正会改变实际使用方式的信息。',
    '每条必须原样返回候选中的唯一 id，字段名为 itemId；不要改写、猜测或省略 itemId。',
    '每条包含：itemId、中文标题、2-3 句中文摘要、对轻度 AI 工作流用户的实用解读、分类、重要性。',
    '实用解读必须给明确今日判断，例如：可以试用、值得关注、暂不急用、适合个人 workflow、需要谨慎、先观察。',
    '不要编造原文没有的信息；如果信息不足，明确写信息有限。',
    '只输出符合 schema 的 JSON。'
  ].join('\n');

  return new Promise(function (resolve, reject) {
    var args = [
      '-c', 'model_reasoning_effort="low"',
      '--ask-for-approval', 'never',
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--output-schema', SCHEMA_PATH,
      '--output-last-message', OUTPUT_PATH,
      '-'
    ];
    var child = childProcess.spawn(CODEX_BIN, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    var stdout = '';
    var stderr = '';
    var timer = setTimeout(function () {
      child.kill('SIGTERM');
      reject(new Error('Codex timeout'));
    }, CODEX_TIMEOUT_MS);
    child.stdout.on('data', function (data) { stdout += data.toString(); });
    child.stderr.on('data', function (data) { stderr += data.toString(); });
    child.on('error', function (err) {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Codex exit ' + code + ': ' + compactText(stderr || stdout, 500)));
        return;
      }
      try {
        var text = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : stdout;
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('Codex JSON parse failed: ' + err.message));
      }
    });
    child.stdin.write(prompt + '\n\n<stdin>\n' + JSON.stringify(input, null, 2) + '\n</stdin>\n');
    child.stdin.end();
  });
}

function statusLabel(status) {
  if (status === 'success') return '成功';
  if (status === 'previous_day') return '昨日内容';
  if (status === 'no_today') return '无当日内容';
  if (status === 'fetch_failed') return '抓取失败';
  if (status === 'parse_failed') return '解析失败';
  return '未知';
}

function sourceStatusClass(status, core) {
  if (status === 'success') return 'ok';
  if (status === 'previous_day') return 'warn';
  if (core && (status === 'fetch_failed' || status === 'parse_failed')) return 'core-fail';
  return 'warn';
}

var CATEGORY_CONFIG = [
  { id: 'news', label: '行业新闻', en: 'Industry News', color: 'red' },
  { id: 'app', label: '产品应用', en: 'Products & Apps', color: 'blue' },
  { id: 'fund', label: '融资动态', en: 'Funding & Business', color: 'green' },
  { id: 'research', label: '研究技术', en: 'Research & Engineering', color: 'purple' },
  { id: 'github', label: 'GitHub', en: 'GitHub & Open Source', color: 'amber' }
];

function classifyDigestItem(raw, digestItem) {
  var category = digestItem.category || '';
  var text = raw.sourceName + ' ' + raw.title + ' ' + raw.summary + ' ' + category;
  var categoryOverride = rawCategory(raw);
  if (categoryOverride === 'github' || categoryOverride === 'fund') return categoryOverride;
  if (category === '融资') return 'fund';
  if (category === '公司' || category === '政策' || category === '头条' || category === '快讯') return 'news';
  if (categoryOverride === 'research') return 'research';
  if (/github/i.test(raw.sourceName + ' ' + raw.link)) return 'github';
  if (/融资|募资|funding|fundraise|valuation|估值|ipo|收购|acquisition/i.test(text)) return 'fund';
  if (category === '研究' || /论文|研究|benchmark|模型训练|开源模型|arxiv/i.test(text)) return 'research';
  if (category === '产品' || category === '工具' || category === '实操') return 'app';
  return 'news';
}

function renderCard(raw, digestItem, index, categoryId) {
  var featured = digestItem.importance === 'high' ? ' featured' : '';
  var badge = digestItem.category || '快讯';
  var title = digestItem.titleZh || raw.title;
  var summary = digestItem.summaryZh || raw.summary || '此来源没有提供摘要。';
  var insight = digestItem.insightZh || '信息有限，建议打开原文确认细节后再决定是否调整当前工作流。';
  return '<div class="card c-' + categoryId + featured + '" data-id="n' + (index + 1) + '" data-title="' + escapeHtml(title) + '" data-link="' + escapeHtml(raw.link) + '">' +
    '<div class="card-row"><label class="card-chk"><input type="checkbox" aria-label="选择此条新闻"></label><div class="card-body-wrap">' +
    '<a class="card-lnk" href="' + escapeHtml(raw.link) + '" target="_blank" rel="noopener">' +
    '<div class="card-top"><div class="card-headline">' + escapeHtml(title) + '</div><span class="badge b-' + categoryId + '">' + escapeHtml(badge) + '</span></div>' +
    '<div class="card-published">发布时间：' + escapeHtml(dateTimeText(raw.published)) + '</div>' +
    '<div class="card-text">' + escapeHtml(summary) + '</div></a>' +
    '<div class="card-ft"><span class="card-src">' + escapeHtml(raw.sourceName) + '</span><a class="card-orig" href="' + escapeHtml(raw.link) + '" target="_blank" rel="noopener">阅读原文</a></div>' +
    '</div></div><div class="insight"><div class="ins-lbl">AI 解读</div><div class="ins-txt">' + escapeHtml(insight) + '</div></div></div>';
}

function groupDigestItems(items, digest) {
  var grouped = {};
  var i;
  var categoryId;
  for (i = 0; i < CATEGORY_CONFIG.length; i++) grouped[CATEGORY_CONFIG[i].id] = [];
  for (i = 0; i < items.length; i++) {
    categoryId = classifyDigestItem(items[i], digest.items[i] || {});
    grouped[categoryId].push({
      raw: items[i],
      digest: digest.items[i] || {},
      index: i
    });
  }
  return grouped;
}

function renderFilterButtons(grouped, total) {
  var html = ['<button class="filter-btn active" type="button" data-filter="all">全部 <span class="ct">' + total + '</span></button>'];
  var i;
  var config;
  for (i = 0; i < CATEGORY_CONFIG.length; i++) {
    config = CATEGORY_CONFIG[i];
    html.push('<button class="filter-btn" type="button" data-filter="' + config.id + '"><span class="dot dot-' + config.id + '"></span>' + config.label + ' <span class="ct">' + grouped[config.id].length + '</span></button>');
  }
  return html.join('\n');
}

function renderSections(grouped) {
  var html = [];
  var i;
  var j;
  var config;
  var entries;
  for (i = 0; i < CATEGORY_CONFIG.length; i++) {
    config = CATEGORY_CONFIG[i];
    entries = grouped[config.id];
    html.push('<section class="sec" data-section="' + config.id + '">');
    html.push('<div class="sec-hd"><span class="sec-name ' + config.color + '">' + config.label + '</span><span class="sec-en">' + config.en + '</span><span class="sec-ct">' + entries.length + ' 条</span></div>');
    if (entries.length === 0) {
      html.push('<div class="empty-section">本期没有符合筛选标准的内容</div>');
    } else {
      for (j = 0; j < entries.length; j++) {
        html.push(renderCard(entries[j].raw, entries[j].digest, entries[j].index, config.id));
      }
    }
    html.push('</section>');
  }
  return html.join('\n');
}

function renderSourcePills(sources) {
  var html = [];
  var i;
  for (i = 0; i < sources.length; i++) {
    if (!sources[i].homepage) continue;
    html.push('<a class="src-pill" href="' + escapeHtml(sources[i].homepage) + '" target="_blank" rel="noopener">' + escapeHtml(sources[i].name) + '</a>');
  }
  return html.join('\n');
}

function renderSources(sources) {
  var html = [];
  var i;
  for (i = 0; i < sources.length; i++) {
    html.push('<div class="source-row ' + sourceStatusClass(sources[i].status, sources[i].core) + '">');
    html.push('<div><strong>' + escapeHtml(sources[i].name) + '</strong>' + (sources[i].core ? '<span class="core-tag">核心源</span>' : '') + '</div>');
    html.push('<span>' + statusLabel(sources[i].status) + (sources[i].count ? ' · ' + sources[i].count + '条' : '') + '</span>');
    if (sources[i].fallbackDate) html.push('<small>使用 ' + escapeHtml(dateZh(sources[i].fallbackDate)) + ' 内容</small>');
    if (sources[i].usedCache) html.push('<small>本次使用该来源最近一次成功候选补位 · ' + sources[i].cachedCount + '条</small>');
    if (sources[i].error) html.push('<small>' + escapeHtml(compactText(sources[i].error, 160)) + '</small>');
    html.push('</div>');
  }
  return html.join('\n');
}

function renderStatusPanel(data) {
  var hasFailure = data.overallStatus === 'fetch_failed' || data.overallStatus === 'parse_failed';
  var codexNote = data.codexError ? ' · Codex 摘要失败，已使用本地降级摘要' : '';
  return '<details class="status-panel"' + (hasFailure ? ' open' : '') + '>' +
    '<summary class="status-summary"><span class="status-title">抓取状态</span><span class="status-meta">更新时间 ' + escapeHtml(data.generatedAt) + codexNote + '</span><span class="status-badge ' + escapeHtml(data.overallStatus) + '">' + escapeHtml(statusLabel(data.overallStatus)) + '</span></summary>' +
    '<div class="source-list">' + renderSources(data.sourceResults) + '</div></details>';
}

function replaceTemplateToken(template, token, value) {
  return template.split('{{' + token + '}}').join(String(value));
}

function renderHtml(data) {
  var grouped = groupDigestItems(data.items, data.digest);
  var template = readText(TEMPLATE_PATH, '');
  if (!template) throw new Error('Digest template not found: ' + TEMPLATE_PATH);
  template = replaceTemplateToken(template, 'DATE_ZH', escapeHtml(dateZh(data.date)));
  template = replaceTemplateToken(template, 'TOTAL', data.items.length);
  template = replaceTemplateToken(template, 'SOURCE_COUNT', data.sourceResults.length);
  template = replaceTemplateToken(template, 'UPDATE_TIME', escapeHtml(data.generatedAt));
  template = replaceTemplateToken(template, 'SOURCE_PILLS', renderSourcePills(data.sourceResults));
  template = replaceTemplateToken(template, 'FILTER_BUTTONS', renderFilterButtons(grouped, data.items.length));
  template = replaceTemplateToken(template, 'STATUS_PANEL', renderStatusPanel(data));
  template = replaceTemplateToken(template, 'SECTIONS', renderSections(grouped));
  return template;
}

function computeOverallStatus(sourceResults, items) {
  var coreFailed = false;
  var anySuccess = false;
  var anyPreviousDay = false;
  var anyFetchFailed = false;
  var anyParseFailed = false;
  var i;
  for (i = 0; i < sourceResults.length; i++) {
    if (sourceResults[i].core && (sourceResults[i].status === 'fetch_failed' || sourceResults[i].status === 'parse_failed')) coreFailed = true;
    if (sourceResults[i].status === 'success') anySuccess = true;
    if (sourceResults[i].status === 'previous_day') anyPreviousDay = true;
    if (sourceResults[i].status === 'fetch_failed') anyFetchFailed = true;
    if (sourceResults[i].status === 'parse_failed') anyParseFailed = true;
  }
  if (items.length > 0 && !coreFailed && anySuccess) return 'success';
  if (items.length > 0 && !coreFailed && anyPreviousDay) return 'previous_day';
  if (items.length > 0 && anyFetchFailed) return 'fetch_failed';
  if (items.length > 0 && anyParseFailed) return 'parse_failed';
  if (anyFetchFailed) return 'fetch_failed';
  if (anyParseFailed) return 'parse_failed';
  return 'no_today';
}

function main() {
  var iso = todayISO();
  var state = readJson(STATE_PATH, {});
  var isMiddayRun = hasFlag('--midday');
  var isFinalRun = hasFlag('--final');
  var generationPhase = isFinalRun ? 'final' : (isMiddayRun ? 'midday' : 'preliminary');

  if (hasFlag('--publish-only')) {
    try {
      var publishOnlyResult = publishToGitHub(iso);
      updateState({
        generatedDate: state.generatedDate || iso,
        pagesPublished: publishOnlyResult.published,
        publishedUrl: publishOnlyResult.url || state.publishedUrl || PAGES_URL,
        publishedAt: publishOnlyResult.published ? nowText() : state.publishedAt,
        publishStatus: publishOnlyResult.reason,
        publishError: null
      });
      console.log('Publish check: ' + publishOnlyResult.reason);
    } catch (err) {
      updateState({
        pagesPublished: false,
        publishError: err.message,
        publishFailedAt: nowText()
      });
      console.error('Publish failed: ' + err.message);
      process.exitCode = 1;
    }
    return;
  }

  if (hasFlag('--audit-last')) {
    var auditCachedData = readJson(RENDER_PATH, null);
    var audit;
    if (!auditCachedData) {
      console.error('No cached digest render data found.');
      process.exitCode = 1;
      return;
    }
    audit = auditDigestData(auditCachedData);
    writeJson(AUDIT_PATH, audit);
    if (hasFlag('--json')) {
      console.log(JSON.stringify(audit, null, 2));
    } else {
      printAudit(audit);
    }
    if (audit.errorCount > 0) process.exitCode = 1;
    return;
  }

  if (hasFlag('--rerender-last')) {
    var cachedData = readJson(RENDER_PATH, null);
    var cachedInput;
    var repaired;
    if (!cachedData) {
      console.error('No cached digest render data found.');
      process.exitCode = 1;
      return;
    }
    cachedInput = readJson(INPUT_PATH, null);
    if (cachedInput && Array.isArray(cachedInput.items) && !inputItemsAreCompact(cachedInput.items) && cachedInput.items.length > cachedData.items.length) {
      repaired = alignDigestItems(cachedInput.items, cachedData.digest || fallbackDigest(cachedData.items || []));
      cachedData.items = repaired.items;
      cachedData.digest = repaired.digest;
      writeJson(RENDER_PATH, cachedData);
    }
    fs.writeFileSync(INDEX_PATH, renderHtml(cachedData));
    console.log('Re-rendered index.html from cached digest data.');
    try {
      var rerenderPublishResult = publishToGitHub(cachedData.date || iso);
      updateState({
        pagesPublished: rerenderPublishResult.published,
        publishedUrl: rerenderPublishResult.url || state.publishedUrl || PAGES_URL,
        publishedAt: rerenderPublishResult.published ? nowText() : state.publishedAt,
        publishStatus: rerenderPublishResult.reason,
        publishError: null
      });
      console.log('Publish check: ' + rerenderPublishResult.reason);
    } catch (err) {
      updateState({
        pagesPublished: false,
        publishError: err.message,
        publishFailedAt: nowText()
      });
      console.error('Publish failed: ' + err.message);
      process.exitCode = 1;
    }
    return;
  }

  if (hasFlag('--repair-last')) {
    var repairCachedData = readJson(RENDER_PATH, null);
    var repairCachedInput;
    var repairAligned;
    if (!repairCachedData) {
      console.error('No cached digest render data found.');
      process.exitCode = 1;
      return;
    }
    repairCachedInput = readJson(INPUT_PATH, null);
    if ((!Array.isArray(repairCachedData.items) || repairCachedData.items.length === 0) && repairCachedInput && Array.isArray(repairCachedInput.items) && !inputItemsAreCompact(repairCachedInput.items)) {
      repairAligned = alignDigestItems(repairCachedInput.items, repairCachedData.digest || fallbackDigest(repairCachedData.items || []));
      repairCachedData.items = repairAligned.items;
      repairCachedData.digest = repairAligned.digest;
    }
    repairDigestQuality(repairCachedData.items || [], repairCachedData.digest || fallbackDigest(repairCachedData.items || []), repairCachedData.date || iso).then(function (repairResult) {
      repairCachedData.digest = repairResult.digest;
      if (findDigestRepairTargets(repairCachedData.items || [], repairCachedData.digest).length === 0) repairCachedData.codexError = '';
      writeJson(RENDER_PATH, repairCachedData);
      fs.writeFileSync(INDEX_PATH, renderHtml(repairCachedData));
      console.log('Repaired cached digest quality: items=' + repairResult.repairedCount);
      if (hasFlag('--no-publish')) return;
      try {
        var repairPublishResult = publishToGitHub(repairCachedData.date || iso);
        updateState({
          pagesPublished: repairPublishResult.published,
          publishedUrl: repairPublishResult.url || state.publishedUrl || PAGES_URL,
          publishedAt: repairPublishResult.published ? nowText() : state.publishedAt,
          publishStatus: repairPublishResult.reason,
          codexError: repairCachedData.codexError || null,
          publishError: null
        });
        console.log('Publish check: ' + repairPublishResult.reason);
      } catch (err) {
        updateState({
          pagesPublished: false,
          publishError: err.message,
          publishFailedAt: nowText()
        });
        console.error('Publish failed: ' + err.message);
        process.exitCode = 1;
      }
    }).catch(function (err) {
      console.error('Repair failed: ' + err.message);
      process.exitCode = 1;
    });
    return;
  }

  if (!hasFlag('--force') && state.generatedDate === iso && state.pagesPublished === true && state.overallStatus !== 'no_today' && fs.existsSync(INDEX_PATH)) {
    console.log('AI Daily Digest already published for ' + iso + '. Use --force to regenerate.');
    return;
  }

  if (!hasFlag('--force') && state.generatedDate === iso && state.overallStatus !== 'no_today' && fs.existsSync(INDEX_PATH)) {
    try {
      var retryResult = publishToGitHub(iso);
      updateState({
        pagesPublished: retryResult.published,
        publishedUrl: retryResult.url || state.publishedUrl || PAGES_URL,
        publishedAt: retryResult.published ? nowText() : state.publishedAt,
        publishStatus: retryResult.reason,
        publishError: null
      });
      console.log('AI Daily Digest already generated for ' + iso + '. Publish check: ' + retryResult.reason);
    } catch (err) {
      updateState({
        pagesPublished: false,
        publishError: err.message,
        publishFailedAt: nowText()
      });
      console.error('Publish failed: ' + err.message);
      process.exitCode = 1;
    }
    return;
  }

  var sources = readJson(SOURCES_PATH, []);
  var sourceCache = readJson(SOURCE_CACHE_PATH, {});
  var sourceCacheDirty = false;
  var sourceResults = [];
  var allItems = [];
  var pending = sources.map(function (source) {
    return fetchWithTimeout(source.url).then(function (html) {
      var parsed = parseSourceWithFallback(html, source, iso);
      var cachedItems = [];
      if (parsed.items.length > 0) {
        sourceCacheDirty = cacheSourceItems(sourceCache, source, parsed.items) || sourceCacheDirty;
      } else {
        cachedItems = cloneCachedSourceItems(source, sourceCache);
      }
      sourceResults.push({
        id: source.id,
        name: source.name,
        core: !!source.core,
        status: parsed.status,
        count: parsed.items.length,
        cachedCount: cachedItems.length,
        usedCache: cachedItems.length > 0,
        fallbackDate: parsed.fallbackDate,
        homepage: source.homepage
      });
      allItems = allItems.concat(parsed.items.length > 0 ? parsed.items : cachedItems);
    }).catch(function (err) {
      var parseLike = /not found|usable|RSS item|parse/i.test(err.message);
      var cachedItems = cloneCachedSourceItems(source, sourceCache);
      sourceResults.push({
        id: source.id,
        name: source.name,
        core: !!source.core,
        status: parseLike ? 'parse_failed' : 'fetch_failed',
        count: 0,
        cachedCount: cachedItems.length,
        usedCache: cachedItems.length > 0,
        error: err.message,
        homepage: source.homepage
      });
      allItems = allItems.concat(cachedItems);
    });
  });

  Promise.all(pending).then(function () {
    if (sourceCacheDirty) writeJson(SOURCE_CACHE_PATH, sourceCache);
    return enrichGitHubItems(dedupe(allItems));
  }).then(function (enrichedItems) {
    var items = rankItems(enrichedItems);
    if (items.length === 0) {
      return { items: items, digest: fallbackDigest(items), codexError: '' };
    }
    return runCodexDigest(items, iso).then(function (digest) {
      var aligned = alignDigestItems(items, digest);
      return repairDigestQuality(aligned.items, aligned.digest, iso).then(function (repairResult) {
        return { items: aligned.items, digest: repairResult.digest, codexError: '' };
      }).catch(function (repairErr) {
        return {
          items: aligned.items,
          digest: aligned.digest,
          codexError: 'Codex quality repair failed: ' + repairErr.message
        };
      });
    }).catch(function (err) {
      return { items: items, digest: fallbackDigest(items), codexError: err.message };
    });
  }).then(function (result) {
    var computedStatus = computeOverallStatus(sourceResults, result.items);
    if (computedStatus === 'no_today' && fs.existsSync(INDEX_PATH)) {
      updateState({
        generatedDate: iso,
        generatedAt: nowText(),
        overallStatus: 'no_today',
        itemCount: 0,
        lastAttemptAt: nowText(),
        generationPhase: generationPhase,
        middayDate: isMiddayRun ? iso : state.middayDate,
        finalizedDate: isFinalRun ? iso : state.finalizedDate,
        pagesPublished: true,
        publishStatus: 'retained previous page',
        publishError: null
      });
      console.log('No today content yet; previous page retained.');
      return;
    }
    var data = {
      date: iso,
      generatedAt: nowText(),
      sourceResults: sourceResults.sort(function (a, b) { return (b.core ? 1 : 0) - (a.core ? 1 : 0); }),
      items: result.items,
      digest: result.digest,
      codexError: result.codexError,
      overallStatus: computedStatus
    };
    writeJson(RENDER_PATH, data);
    fs.writeFileSync(INDEX_PATH, renderHtml(data));
    var statePatch = {
      generatedDate: iso,
      generatedAt: data.generatedAt,
      overallStatus: data.overallStatus,
      itemCount: data.items.length,
      codexError: data.codexError || null,
      generationPhase: generationPhase,
      pagesPublished: false,
      publishStatus: null,
      publishError: null
    };
    writeJson(STATE_PATH, statePatch);
    console.log('Generated index.html: ' + statusLabel(data.overallStatus) + ', items=' + data.items.length);
    if (data.codexError) console.log('Codex fallback: ' + data.codexError);
    try {
      var publishResult = publishToGitHub(iso);
      updateState({
        pagesPublished: publishResult.published,
        publishedUrl: publishResult.url || PAGES_URL,
        publishedAt: publishResult.published ? nowText() : null,
        middayDate: isMiddayRun && publishResult.published ? iso : state.middayDate,
        finalizedDate: isFinalRun && publishResult.published ? iso : state.finalizedDate,
        publishStatus: publishResult.reason,
        publishError: null
      });
      console.log('Publish check: ' + publishResult.reason);
    } catch (err) {
      updateState({
        pagesPublished: false,
        publishError: err.message,
        publishFailedAt: nowText()
      });
      console.error('Publish failed: ' + err.message);
      process.exitCode = 1;
    }
  }).catch(function (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

main();
