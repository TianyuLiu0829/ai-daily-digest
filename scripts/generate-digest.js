#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var INDEX_PATH = path.join(ROOT, 'index.html');
var STATE_PATH = path.join(ROOT, '.digest-state.json');
var INPUT_PATH = path.join(ROOT, '.digest-last-input.json');
var OUTPUT_PATH = path.join(ROOT, '.digest-last-output.json');
var SOURCES_PATH = path.join(ROOT, 'config', 'sources.json');
var EDITORIAL_RULES_PATH = path.join(ROOT, 'config', 'editorial-rules.md');
var SCHEMA_PATH = path.join(ROOT, 'codex-output.schema.json');
var CODEX_BIN = process.env.CODEX_BIN || '/Applications/Codex.app/Contents/Resources/codex';
var MAX_ITEMS = parseInt(process.env.DIGEST_MAX_ITEMS || '8', 10);
var FETCH_TIMEOUT_MS = parseInt(process.env.DIGEST_FETCH_TIMEOUT_MS || '18000', 10);
var CODEX_TIMEOUT_MS = parseInt(process.env.DIGEST_CODEX_TIMEOUT_MS || '180000', 10);
var PAGES_URL = process.env.DIGEST_PAGES_URL || 'https://tianyuliu0829.github.io/ai-daily-digest/';

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
    var dateMatch = /(20\d\d-\d\d-\d\d(?:T[^\s<]*)?)/.exec(chunk);
    var date = dateMatch ? dateMatch[1] : '';
    if (!title || !link || !sameDay(date, iso)) continue;
    var afterTitle = chunk.replace(/^[\s\S]*?<\/a>/i, ' ').replace(/^[^\n]*\n/, ' ');
    var summary = compactText(afterTitle.replace(date, ' '), 560);
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
    published: date || ''
  };
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
  if (parsed.length > 0) {
    return {
      items: parsed,
      status: 'success',
      fallbackDate: ''
    };
  }
  previousIso = shiftISO(iso, -1);
  previous = parseSource(html, source, previousIso);
  if (previous.length > 0) {
    return {
      items: previous,
      status: 'previous_day',
      fallbackDate: previousIso
    };
  }
  return {
    items: parsed,
    status: 'no_today',
    fallbackDate: ''
  };
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
  var lowSignalWords = /bug fix|bugfix|minor fix|patch release|maintenance|typo|docs update|documentation update|sdk update|sdk release|dependency update|performance bug|ui polish/i;
  var rescueWords = /security|privacy|data loss|permission|agent|model|launch|release|pricing|price|free|subscription|copilot|workflow|automation|memory|browser|email|calendar|files|customer data|enterprise|consumer/i;
  var scored = [];
  var selected = [];
  var sourceCounts = {};
  var i;
  for (i = 0; i < items.length; i++) {
    var text = items[i].title + ' ' + items[i].summary;
    if (lowSignalWords.test(text) && !rescueWords.test(text)) continue;
    var score = 0;
    if (items[i].sourceCore) score += 1;
    if (highWords.test(text)) score += 3;
    if (/OpenAI|Google|DeepMind|Microsoft|GitHub|Cursor|Zapier|Canva|VentureBeat|TechCrunch|Decoder/i.test(items[i].sourceName)) score += 1;
    if (/official|blog|docs|changelog|release|model|tool|product|agent|automation|workflow|pricing|privacy|security/i.test(text)) score += 1;
    if (/funding|raises|valuation|stock|shares/i.test(text) && !/product|launch|acquire|acquisition|partnership|integrat/i.test(text)) score -= 2;
    scored.push({ item: items[i], score: score });
  }
  scored = scored.sort(function (a, b) {
    var as = a.score;
    var bs = b.score;
    return bs - as;
  });
  for (i = 0; i < scored.length; i++) {
    var sourceId = scored[i].item.sourceId;
    var current = sourceCounts[sourceId] || 0;
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

function fallbackDigest(items) {
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    out.push({
      itemId: items[i].id,
      titleZh: items[i].title,
      summaryZh: items[i].summary || '原始来源没有提供足够摘要，建议点开原文查看细节。',
      insightZh: '对轻度 AI 工作流用户：先判断这条新闻是否会影响你正在用的工具、价格、权限或自动化能力。如果会，记录一个可测试的小动作；如果不会，了解趋势即可，不必立刻追新。',
      category: i < 2 ? '头条' : '快讯',
      importance: i < 2 ? 'high' : 'normal'
    });
  }
  return { items: out };
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
  return {
    items: selectedItems,
    digest: { items: selectedDigest }
  };
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
    items: items
  };
  writeJson(INPUT_PATH, input);
  var prompt = [
    '你是 AI Daily Digest 的中文编辑。',
    '基于 stdin JSON 生成最多 ' + MAX_ITEMS + ' 条中文日报。',
    '严格按 editorialRules 筛选：优先消费者 AI、AI 工作流、工具选择、成本/权限/风险变化；排除小 bug fix、SDK patch、纯 hype、纯融资和无实际影响的 benchmark。',
    '候选新闻可能包含前一天内容，这是正常回退；可以总结，但不要把前一天内容写成今天刚发布。',
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

function renderCards(items, digest) {
  var html = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var raw = items[i];
    var d = digest.items[i] || {};
    var featured = d.importance === 'high' ? ' featured' : '';
    var badge = d.category || (i < 2 ? '头条' : '快讯');
    html.push('<div class="card' + featured + '" data-id="' + escapeHtml('n' + (i + 1)) + '" data-title="' + escapeHtml(d.titleZh || raw.title) + '" data-summary="' + escapeHtml(d.summaryZh || raw.summary) + '" data-link="' + escapeHtml(raw.link) + '">');
    html.push('<div class="card-check"><input type="checkbox" aria-label="选择此条新闻"></div>');
    html.push('<a class="card-link-area" href="' + escapeHtml(raw.link) + '" target="_blank" rel="noopener">');
    html.push('<div class="card-top"><div class="card-headline">' + escapeHtml(d.titleZh || raw.title) + '</div><span class="badge">' + escapeHtml(badge) + '</span></div>');
    html.push('<div class="card-body">' + escapeHtml(d.summaryZh || raw.summary || '此来源没有提供摘要。') + '</div>');
    html.push('</a>');
    html.push('<div class="card-footer-bar"><span class="card-source">' + escapeHtml(raw.sourceName) + '</span><span class="card-readtime">· 原文</span><a class="card-orig" href="' + escapeHtml(raw.link) + '" target="_blank" rel="noopener">阅读原文 ↗</a></div>');
    html.push('<div class="insight"><div class="insight-label">实用解读</div><div class="insight-text">' + escapeHtml(d.insightZh || '') + '</div></div>');
    html.push('</div>');
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
    if (sources[i].error) html.push('<small>' + escapeHtml(compactText(sources[i].error, 160)) + '</small>');
    html.push('</div>');
  }
  return html.join('\n');
}

function renderHtml(data) {
  var title = 'AI 日报';
  var status = statusLabel(data.overallStatus);
  var cards = data.items.length ? renderCards(data.items, data.digest) : '<div class="empty-card">今天没有抓到可用的当日内容。页面已更新状态，但未生成新闻卡片。</div>';
  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>' + title + ' — ' + escapeHtml(dateZh(data.date)) + '</title>\n' +
'<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">\n' +
'<style>\n' +
':root{--bg:#f5f4f0;--surface:#fff;--surface2:#f9f8f5;--border:rgba(0,0,0,.09);--border-h:rgba(0,0,0,.2);--text:#181614;--text2:#3d3a36;--text3:#888480;--purple:#4f3fcf;--purple-bg:rgba(79,63,207,.07);--green:#1a7a4e;--green-bg:rgba(26,122,78,.07);--amber:#92580a;--amber-bg:rgba(146,88,10,.08);--red:#b02020;--red-bg:rgba(176,32,32,.07);--insight-bg:#f0ede6;--insight-bdr:#ddd8ce;--selected-bg:#fffbeb;--selected-bdr:#d4a017;--font:\'Noto Sans SC\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;--mono:\'Space Mono\',\'Courier New\',monospace;}\n' +
'*,*:before,*:after{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:16px;line-height:1.75;-webkit-font-smoothing:antialiased}.page{max-width:820px;margin:0 auto;padding:0 1.75rem 8rem}.masthead{padding:3rem 0 2rem;border-bottom:1.5px solid var(--border);margin-bottom:1.25rem;position:relative;overflow:hidden}.masthead:after{content:\'AI\';position:absolute;right:-1rem;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:190px;font-weight:700;color:rgba(79,63,207,.04);line-height:1}.masthead-tag{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--text3);display:block;margin-bottom:.5rem}.masthead-title{font-size:clamp(34px,6vw,52px);font-weight:700;line-height:1.05;margin-bottom:.35rem}.masthead-title span{color:var(--purple)}.masthead-sub{font-size:13px;color:var(--text3);margin-bottom:.9rem}.masthead-sources{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}.masthead-date,.source-pill{font-family:var(--mono);font-size:10px;color:var(--text3)}.source-pill{padding:3px 9px;border-radius:20px;border:1px solid var(--border);text-decoration:none}.status-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin:0 0 2rem;padding:1rem 1.1rem}.status-head{display:flex;justify-content:space-between;gap:1rem;align-items:center;border-bottom:1px solid var(--border);padding-bottom:.75rem;margin-bottom:.75rem}.status-title{font-size:14px;font-weight:700}.status-badge{font-family:var(--mono);font-size:10px;border-radius:20px;padding:4px 10px;background:var(--purple-bg);color:var(--purple)}.status-badge.fetch_failed,.status-badge.parse_failed{background:var(--red-bg);color:var(--red)}.status-badge.no_today,.status-badge.previous_day{background:var(--amber-bg);color:var(--amber)}.source-row{display:grid;grid-template-columns:1fr auto;gap:.35rem 1rem;font-size:12px;padding:.45rem 0;border-bottom:1px solid rgba(0,0,0,.05)}.source-row:last-child{border-bottom:0}.source-row small{grid-column:1/-1;color:var(--text3)}.source-row.ok span{color:var(--green)}.source-row.warn span{color:var(--amber)}.source-row.core-fail{background:var(--red-bg);margin:.25rem -.5rem;padding:.5rem;border-radius:8px}.source-row.core-fail span{color:var(--red);font-weight:700}.core-tag{font-family:var(--mono);font-size:9px;margin-left:.45rem;color:var(--red)}.stat-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:2.5rem}.stat-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.9rem 1.1rem}.stat-num{font-family:var(--mono);font-size:22px;font-weight:700;line-height:1;margin-bottom:4px}.stat-label{font-size:12px;color:var(--text3)}.section-header{display:flex;align-items:center;gap:10px;margin:2.25rem 0 1.1rem}.section-icon{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;background:var(--purple-bg)}.section-title{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)}.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-bottom:.9rem;overflow:hidden;transition:border-color .2s,box-shadow .2s;position:relative}.card:hover{border-color:var(--border-h);box-shadow:0 2px 14px rgba(0,0,0,.07)}.card.featured{border-left:3px solid var(--purple)}.card.selected{background:var(--selected-bg);border-color:var(--selected-bdr)}.card-check{position:absolute;top:1rem;right:1rem;z-index:2}.card-check input{width:18px;height:18px;accent-color:var(--purple);cursor:pointer}.card-link-area{display:block;text-decoration:none;color:inherit;padding:1.2rem 3rem 0 1.4rem;transition:background .15s}.card-link-area:hover{background:var(--surface2)}.card-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:.5rem}.card-headline{font-size:16px;font-weight:700;line-height:1.5;flex:1}.card.featured .card-headline{color:var(--purple)}.badge{font-family:var(--mono);font-size:9px;letter-spacing:.06em;padding:3px 9px;border-radius:20px;white-space:nowrap;background:var(--purple-bg);color:var(--purple);margin-top:2px}.card-body{font-size:14.5px;color:var(--text2);line-height:1.8;padding:0 3rem .85rem 1.4rem}.card-footer-bar{display:flex;align-items:center;gap:8px;padding:.55rem 1.4rem .75rem;border-top:1px solid var(--border)}.card-source,.card-readtime{font-family:var(--mono);font-size:10px;color:var(--text3)}.card-orig{font-family:var(--mono);font-size:10px;color:var(--purple);text-decoration:none;margin-left:auto;opacity:.75}.insight{background:var(--insight-bg);border-top:1px solid var(--insight-bdr);padding:.9rem 1.4rem 1rem}.insight-label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--purple);margin-bottom:.35rem}.insight-text{font-size:13.5px;color:var(--text2);line-height:1.8}.empty-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.3rem;color:var(--text2)}#float-bar{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%) translateY(80px);background:var(--text);color:#fff;border-radius:40px;padding:.65rem 1.4rem;display:flex;align-items:center;gap:1rem;font-family:var(--mono);font-size:11px;white-space:nowrap;box-shadow:0 4px 24px rgba(0,0,0,.25);transition:transform .3s ease,opacity .3s;opacity:0;pointer-events:none;z-index:100}#float-bar.visible{transform:translateX(-50%) translateY(0);opacity:1;pointer-events:all}#float-count{font-weight:700;color:#9b8fff}.float-btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:20px;padding:.35rem .9rem;font-family:var(--mono);font-size:10px;cursor:pointer}.float-btn.primary{background:var(--purple);border-color:var(--purple)}.footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap}.footer-text,.footer-link{font-family:var(--mono);font-size:10px;color:var(--text3)}.footer-link{color:var(--purple);text-decoration:none}@media(max-width:600px){.page{padding:0 1rem 6rem}.masthead-title{font-size:30px}.stat-strip{grid-template-columns:1fr}#float-bar{width:calc(100% - 2rem);justify-content:center;gap:.5rem}.float-btn{padding:.35rem .55rem}.card-footer-bar{align-items:flex-start;flex-direction:column}.card-orig{margin-left:0}}\n' +
'</style>\n</head>\n<body>\n<div class="page">\n<header class="masthead"><span class="masthead-tag">AI Daily Digest · MVP First</span><h1 class="masthead-title">AI <span>日报</span></h1><p class="masthead-sub">本地抓取 · Codex 中文摘要 · 固定 GitHub Pages 页面</p><div class="masthead-sources"><span class="masthead-date">' + escapeHtml(dateZh(data.date)) + '</span><a class="source-pill" href="https://ai.tldr.tech/" target="_blank" rel="noopener">TLDR AI ↗</a><a class="source-pill" href="https://www.therundown.ai/" target="_blank" rel="noopener">The Rundown AI ↗</a></div></header>\n' +
'<div class="status-panel"><div class="status-head"><div><div class="status-title">抓取状态</div><div class="masthead-sub">更新时间：' + escapeHtml(data.generatedAt) + (data.codexError ? ' · Codex 摘要失败，已用本地降级摘要' : '') + '</div></div><span class="status-badge ' + escapeHtml(data.overallStatus) + '">' + escapeHtml(status) + '</span></div>' + renderSources(data.sourceResults) + '</div>\n' +
'<div class="stat-strip"><div class="stat-box"><div class="stat-num">' + data.items.length + '</div><div class="stat-label">精选新闻</div></div><div class="stat-box"><div class="stat-num">' + data.sourceResults.length + '</div><div class="stat-label">信息来源</div></div><div class="stat-box"><div class="stat-num">~' + Math.max(3, data.items.length * 2) + ' 分钟</div><div class="stat-label">完整阅读</div></div></div>\n' +
'<div class="section-header"><div class="section-icon">🚀</div><span class="section-title">今日精选</span></div>\n' +
cards +
'<div class="footer"><span class="footer-text">AI Daily Digest MVP · 固定 index.html · 不保留历史 report 链接</span><a class="footer-link" href="./" target="_self">固定页面链接</a></div>\n</div>\n' +
'<div id="float-bar"><span>已选 <span id="float-count">0</span> 条</span><button class="float-btn" onclick="clearAll()">清除选择</button><button class="float-btn primary" onclick="copySelection()">复制标题+链接</button></div>\n' +
'<script>\n' +
'var selectedIds = [];\nfunction hasSelected(id){var i;for(i=0;i<selectedIds.length;i++){if(selectedIds[i]===id){return true;}}return false;}\nfunction addSelected(id){if(!hasSelected(id)){selectedIds.push(id);}}\nfunction removeSelected(id){var out=[],i;for(i=0;i<selectedIds.length;i++){if(selectedIds[i]!==id){out.push(selectedIds[i]);}}selectedIds=out;}\nfunction updateFloatBar(){var bar=document.getElementById("float-bar");document.getElementById("float-count").innerHTML=String(selectedIds.length);if(selectedIds.length>0){bar.className="visible";}else{bar.className="";}}\nfunction buildText(){var lines=[],i,el,title,link;for(i=0;i<selectedIds.length;i++){el=document.querySelector("[data-id=\\"" + selectedIds[i] + "\\"]");if(!el){continue;}title=el.getAttribute("data-title")||"";link=el.getAttribute("data-link")||"";lines.push(title);lines.push(link);lines.push("");}return lines.join("\\n");}\nfunction fallbackCopy(text){var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);}\nfunction copySelection(){var text=buildText();var btn=document.querySelector(".float-btn.primary");var old=btn.innerHTML;function done(){btn.innerHTML="已复制 ✓";setTimeout(function(){btn.innerHTML=old;},1600);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text);done();});}else{fallbackCopy(text);done();}}\nfunction clearAll(){var boxes=document.querySelectorAll("input[type=checkbox]"),cards=document.querySelectorAll(".card"),i;selectedIds=[];for(i=0;i<boxes.length;i++){boxes[i].checked=false;}for(i=0;i<cards.length;i++){cards[i].className=cards[i].className.replace(/ selected/g,"");}updateFloatBar();}\nfunction wireCards(){var cards=document.querySelectorAll(".card[data-id]"),i;for(i=0;i<cards.length;i++){(function(card){var cb=card.querySelector("input[type=checkbox]");if(!cb){return;}cb.onchange=function(){var id=card.getAttribute("data-id");if(cb.checked){addSelected(id);if(card.className.indexOf("selected")===-1){card.className+=" selected";}}else{removeSelected(id);card.className=card.className.replace(/ selected/g,"");}updateFloatBar();};cb.onclick=function(e){if(e&&e.stopPropagation){e.stopPropagation();}};})(cards[i]);}}\nwireCards();\n' +
'</script>\n</body>\n</html>\n';
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
  var sourceResults = [];
  var allItems = [];
  var pending = sources.map(function (source) {
    return fetchWithTimeout(source.url).then(function (html) {
      var parsed = parseSourceWithFallback(html, source, iso);
      sourceResults.push({
        id: source.id,
        name: source.name,
        core: !!source.core,
        status: parsed.status,
        count: parsed.items.length,
        fallbackDate: parsed.fallbackDate,
        homepage: source.homepage
      });
      allItems = allItems.concat(parsed.items);
    }).catch(function (err) {
      var parseLike = /not found|usable|RSS item|parse/i.test(err.message);
      sourceResults.push({
        id: source.id,
        name: source.name,
        core: !!source.core,
        status: parseLike ? 'parse_failed' : 'fetch_failed',
        count: 0,
        error: err.message,
        homepage: source.homepage
      });
    });
  });

  Promise.all(pending).then(function () {
    var items = rankItems(dedupe(allItems));
    if (items.length === 0) {
      return { items: items, digest: fallbackDigest(items), codexError: '' };
    }
    return runCodexDigest(items, iso).then(function (digest) {
      var aligned = alignDigestItems(items, digest);
      return { items: aligned.items, digest: aligned.digest, codexError: '' };
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
    fs.writeFileSync(INDEX_PATH, renderHtml(data));
    var statePatch = {
      generatedDate: iso,
      generatedAt: data.generatedAt,
      overallStatus: data.overallStatus,
      itemCount: data.items.length,
      codexError: data.codexError || null,
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
