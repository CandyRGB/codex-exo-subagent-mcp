import { createModelSettings } from './settings.js';
import { commandOutput } from './tool-output.js';
const $ = id => document.getElementById(id);
const icon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(s.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); s.append(use); return s; };
const node = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const states = { completed: '已完成', running: '进行中', cancelling: '正在停止', failed: '失败', cancelled: '已取消', interrupted: '已中断', timed_out: '已超时', unknown: '历史记录' };
const isActive = status => ['running', 'cancelling'].includes(status);
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const fullDate = value => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
function day(value) { const date = new Date(value); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); return date.toDateString() === today.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); }
function recentTime(value) { return day(value) === '今天' ? time(value) : day(value); }
let sessions = [], selectedId = null, data = null, etag = null, listSignature = '', scope = 'all', busy = false, loading = false, showAllRecent = false, settingsOpen = false;
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('subagent-projects') || '[]')); document.documentElement.dataset.theme = localStorage.getItem('subagent-theme') || 'dark'; } catch {}

async function json(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) { let message = '无法读取本机会话'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  return response.json();
}
function connection(ok, error = '') {
  $('connection-dot').classList.toggle('disconnected', !ok);
  $('connection-label').textContent = ok ? '本机记录已连接' : '连接已断开';
  $('error-banner').hidden = ok;
  if (!ok) $('error-banner').textContent = `${error}。请确认本地会话服务仍在运行。`;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 2200); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('浏览器未允许复制，请手动选择文本'); } }
const modelSettings = createModelSettings({ toast, onSaved: () => { void refresh(); } });

function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]+\))/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(previous, match.index)));
    const token = match[0];
    if (token.startsWith('`')) parent.append(node('code', '', token.slice(1, -1)));
    else if (token.startsWith('**')) parent.append(node('strong', '', token.slice(2, -2)));
    else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      let safe = false;
      try { safe = ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol); } catch {}
      if (safe) { const a = node('a', '', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      else parent.append(document.createTextNode(`${label} (${href})`));
    }
    previous = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(previous)));
}
function markdown(text, target) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim(); const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const block = node('div', 'code-block'); const heading = node('div', 'code-heading');
      heading.append(node('span', '', language || 'text'));
      const button = node('button', '', '复制代码'); button.type = 'button'; button.addEventListener('click', () => copy(code.join('\n'))); heading.append(button);
      const pre = node('pre'); pre.append(node('code', '', code.join('\n'))); block.append(heading, pre); target.append(block); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { const h = node(`h${Math.min(heading[1].length, 3)}`); inline(h, heading[2]); target.append(h); i++; continue; }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const list = node(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) { const li = node('li'); inline(li, lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, '')); list.append(li); }
      target.append(list); continue;
    }
    if (line.startsWith('> ')) { const quote = node('blockquote'); inline(quote, line.slice(2)); target.append(quote); i++; continue; }
    const paragraph = [];
    do { paragraph.push(lines[i++]); } while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,4}\s|[-*]\s|\d+\.\s|>\s)/.test(lines[i]));
    const p = node('p'); inline(p, paragraph.join('\n')); target.append(p);
  }
}

function select(id) { if (location.hash !== `#/session/${id}`) location.hash = `/session/${id}`; else void openSession(id); $('app').classList.remove('mobile-open'); }
function sessionButton(session, recent = false) {
  const button = node('button', `session-button${session.id === selectedId ? ' current' : ''}`);
  button.title = session.title;
  button.dataset.sessionId = session.id;
  if (session.id === selectedId) button.setAttribute('aria-current', 'page');
  if (recent) button.append(node('span', `session-dot${isActive(session.status) ? ' running' : ''}`));
  button.append(node('span', 'session-name', session.title));
  if (isActive(session.status)) button.append(node('span', 'status-dot running'));
  else if (recent) button.append(node('span', 'session-time', recentTime(session.updated_at)));
  button.addEventListener('click', () => select(session.id));
  return button;
}
function section(title, count) { const section = node('section', 'nav-section'); const label = node('h2', 'section-label'); label.append(node('span', '', title), node('span', '', String(count))); section.append(label); return section; }
function renderNavigation() {
  const q = $('search').value.trim().toLowerCase();
  const matching = sessions.filter(s => (scope === 'all' || isActive(s.status)) && (!q || `${s.title} ${s.cwd} ${s.model}`.toLowerCase().includes(q)));
  $('total-count').textContent = sessions.length;
  $('running-count').textContent = sessions.filter(s => isActive(s.status)).length;
  $('all-filter').classList.toggle('selected', scope === 'all');
  $('running-filter').classList.toggle('selected', scope === 'running');
  const fragment = document.createDocumentFragment();
  if (matching.some(s => s.pinned)) { const pinned = matching.filter(s => s.pinned); const group = section('置顶', pinned.length); pinned.forEach(s => group.append(sessionButton(s))); fragment.append(group); }
  const projects = new Map();
  for (const s of matching) { if (!projects.has(s.project_id)) projects.set(s.project_id, []); projects.get(s.project_id).push(s); }
  const projectSection = section('项目', projects.size);
  for (const [id, group] of projects) {
    const open = q || !collapsed.has(id);
    const button = node('button', 'project-button'); button.setAttribute('aria-expanded', String(Boolean(open))); button.title = group[0].cwd;
    const chevron = icon('chevron'); chevron.classList.add('chevron'); const folder = icon('folder'); folder.classList.add('folder-icon');
    button.append(chevron, folder, node('span', 'project-name', group[0].project), node('span', 'count', String(group.length)));
    button.addEventListener('click', () => { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); localStorage.setItem('subagent-projects', JSON.stringify([...collapsed])); renderNavigation(); });
    projectSection.append(button);
    if (open) { const list = node('div', 'project-sessions'); for (const s of group) list.append(sessionButton(s)); projectSection.append(list); }
  }
  fragment.append(projectSection);
  const recent = section('最近', matching.length); const list = node('div', 'recent-list');
  let lastDay = '';
  for (const session of matching.slice(0, showAllRecent || q ? Infinity : 15)) { const groupDay = day(session.updated_at); if (groupDay !== lastDay) { list.append(node('div', 'day-heading', groupDay)); lastDay = groupDay; } list.append(sessionButton(session, true)); }
  recent.append(list);
  if (matching.length > 15 && !showAllRecent && !q) { const more = node('button', 'show-all', `显示全部 ${matching.length} 条会话`); more.addEventListener('click', () => { showAllRecent = true; renderNavigation(); }); recent.append(more); }
  fragment.append(recent);
  if (!matching.length) fragment.append(node('div', 'empty-nav', sessions.length ? '没有匹配的会话。试试其他关键词。' : '暂无子代理记录。通过 Codex 调用模型后，会话会出现在这里。'));
  const scroll = $('navigation').scrollTop; $('navigation').replaceChildren(fragment); $('navigation').scrollTop = scroll;
}

function pretty(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function toolEntry(entry, opened) {
  const detail = node('details', 'tool-card'); detail.dataset.entryId = entry.id; detail.open = opened.has(entry.id);
  const summary = node('summary'); const symbol = icon('terminal'); symbol.classList.add('tool-icon');
  const cmd = entry.arguments?.cmd || entry.arguments?.command || (typeof entry.arguments === 'string' ? entry.arguments : '');
  const shell = /exec_command|command_execution|write_stdin/.test(entry.name);
  const label = shell ? '执行命令' : /file/.test(entry.name) ? '文件操作' : entry.name;
  const caption = node('span', 'tool-caption', `${label}${cmd ? ' · ' + cmd.split('\n')[0] : ''}`); caption.title = cmd;
  const status = node('span', `tool-state ${entry.status}`);
  if (entry.status === 'completed') status.append(icon('check'));
  status.append(document.createTextNode(entry.status === 'running' ? '执行中' : entry.status === 'failed' ? '执行失败' : '已执行'));
  const chevron = icon('chevron'); chevron.classList.add('tool-chevron'); summary.append(symbol, caption, status, chevron);
  const body = node('div', 'tool-details');
  if (!shell) body.append(node('div', 'tool-section-label', '参数'), node('pre', '', pretty(entry.arguments)));
  const output = shell ? commandOutput(entry.output) : pretty(entry.output) || '';
  const outputPath = `/api/sessions/${data.session.id}/entries/${entry.id}/output`;
  const outputBox = node('div', 'tool-output');
  const copyButton = node('button', 'icon-button tool-output-copy'); copyButton.type = 'button';
  copyButton.title = shell ? '复制命令输出' : '复制工具输出'; copyButton.setAttribute('aria-label', copyButton.title); copyButton.disabled = !output;
  copyButton.append(icon('copy')); copyButton.addEventListener('click', async () => {
    if (!entry.output_truncated) { await copy(output); return; }
    copyButton.disabled = true;
    try {
      const response = await fetch(outputPath);
      if (!response.ok) throw new Error('无法读取完整输出，请稍后重试');
      const full = await response.text(); await copy(shell ? commandOutput(full) : full);
    } catch (error) { toast(error.message); }
    finally { copyButton.disabled = false; }
  });
  outputBox.append(copyButton, node('pre', 'tool-output-text', output || '暂无输出')); body.append(outputBox);
  if (entry.output_truncated) { const full = node('a', 'tool-copy', '输出较长，下载完整输出'); full.href = outputPath; body.append(full); }
  detail.append(summary, body); return detail;
}
function messageEntry(entry) {
  if (entry.kind === 'user') { const article = node('article', 'message user-message'); article.setAttribute('aria-label', '任务指令'); const bubble = node('div', 'user-bubble'); markdown(entry.text, bubble); article.append(bubble, node('span', 'message-time', time(entry.at))); return article; }
  const name = /^deepseek/i.test(data?.session.model || '') ? 'DeepSeek' : data?.session.model || '子代理';
  const article = node('article', 'message assistant-message'); article.setAttribute('aria-label', `${name} 回复`);
  const label = node('div', 'assistant-label'); const avatar = node('span', 'agent-avatar'); avatar.append(icon('wave')); label.append(avatar, node('span', '', name), node('span', 'message-time', time(entry.at)));
  const content = node('div', 'message-content'); markdown(entry.text, content); article.append(label, content); return article;
}
function renderConversation(toBottom = false) {
  if (!data) return;
  const session = data.session;
  $('welcome').hidden = true; $('conversation').hidden = false; $('top-actions').hidden = false;
  $('project-label').textContent = session.project; $('project-label').title = session.cwd;
  $('breadcrumb-title').textContent = session.title; $('breadcrumb-title').title = session.title;
  $('model-label').textContent = session.model.replace(/^deepseek-v/i, 'DeepSeek V').replace(/-flash$/i, ' Flash');
  $('status-label').textContent = states[session.status] || session.status; $('status-label').className = `state-chip ${session.status}`;
  $('created-label').textContent = `${day(session.created_at)} ${time(session.created_at)}`;
  $('turns-label').textContent = `${session.user_turns} 轮对话 · ${session.tool_calls} 次工具执行`;
  $('pin-button').classList.toggle('active', session.pinned); $('pin-button').title = session.pinned ? '取消置顶' : '置顶会话';
  $('export-button').href = `/api/sessions/${session.id}/export`;
  $('load-earlier').hidden = data.earlier_cursor === null;
  const scroll = $('conversation-scroll'); const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140; const previousTop = scroll.scrollTop;
  const opened = new Set([...$('transcript').querySelectorAll('details[open]')].map(e => e.dataset.entryId));
  const fragment = document.createDocumentFragment();
  for (const entry of data.entries) fragment.append(entry.kind === 'tool' ? toolEntry(entry, opened) : messageEntry(entry));
  if (!data.entries.length) fragment.append(node('p', 'empty-nav', isActive(session.status) ? 'DeepSeek 已接收任务，正在等待第一条记录…' : '此会话暂未找到消息记录。'));
  $('transcript').replaceChildren(fragment);
  document.title = `${session.title} · 子代理会话`;
  requestAnimationFrame(() => { scroll.scrollTop = toBottom || nearBottom ? scroll.scrollHeight : previousTop; checkScroll(); });
}
function checkScroll() { const s = $('conversation-scroll'); $('jump-bottom').hidden = !data || s.scrollHeight - s.scrollTop - s.clientHeight < 200; }
async function loadList() {
  const result = await json('/api/sessions'); const signature = JSON.stringify(result.sessions);
  sessions = result.sessions;
  if (signature !== listSignature) { listSignature = signature; renderNavigation(); }
  if (!selectedId && sessions.length && !location.hash) select(sessions[0].id);
  if (selectedId && !sessions.some(s => s.id === selectedId)) {
    const replacement = sessions.find(s => s.job_ids.includes(selectedId));
    if (replacement) select(replacement.id);
    else {
      selectedId = null; data = null; etag = null;
      history.replaceState(null, '', location.pathname + location.search);
      $('conversation').hidden = true; $('top-actions').hidden = true; $('welcome').hidden = false;
      $('project-label').textContent = '子代理会话'; $('breadcrumb-title').textContent = '会话记录';
      document.title = '子代理会话 · Subagent';
      renderNavigation();
      if (sessions.length) select(sessions[0].id);
    }
  }
  connection(true);
}
async function loadDetail(initial = false) {
  if (!selectedId) return;
  const id = selectedId;
  const response = await fetch(`/api/sessions/${id}`, { headers: etag ? { 'If-None-Match': etag } : {} });
  if (id !== selectedId) return;
  if (response.status === 304) return;
  if (!response.ok) throw new Error((await response.json()).error || '无法打开会话');
  const fresh = await response.json();
  if (id !== selectedId) return;
  etag = response.headers.get('etag');
  if (data && !initial && data.entries[0]?.id !== fresh.entries[0]?.id && data.entries.length > fresh.entries.length) {
    const merged = new Map(data.entries.map(entry => [entry.id, entry])); fresh.entries.forEach(entry => merged.set(entry.id, entry));
    fresh.entries = [...merged.values()].sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6))); fresh.earlier_cursor = data.earlier_cursor;
  }
  data = fresh;
  renderConversation(initial);
}
async function openSession(id) {
  if (loading && selectedId === id) return;
  selectedId = id; etag = null; data = null; loading = true;
  $('conversation').hidden = true; $('welcome').hidden = false;
  renderNavigation();
  try { await loadDetail(true); connection(true); } catch (error) { if (selectedId === id) connection(false, error.message); } finally { loading = false; }
}
function fromHash() {
  if (location.hash === '#/settings/models') {
    settingsOpen = true; selectedId = null; data = null; etag = null;
    $('app').classList.add('settings-mode'); $('models-nav').classList.add('active');
    $('conversation-scroll').hidden = true; $('top-actions').hidden = true;
    $('project-label').textContent = '设置'; $('breadcrumb-title').textContent = '模型与连接';
    document.title = '模型与连接 · Subagent'; renderNavigation(); void modelSettings.show(); return;
  }
  settingsOpen = false; modelSettings.hide(); $('app').classList.remove('settings-mode'); $('models-nav').classList.remove('active'); $('conversation-scroll').hidden = false;
  const match = location.hash.match(/^#\/session\/([a-f0-9-]+)$/i);
  if (match) void openSession(match[1]);
  else if (sessions.length) select(sessions[0].id);
}
async function refresh() {
  if (busy) return; busy = true;
  try { await loadList(); if (!loading && !settingsOpen) await loadDetail(); } catch (error) { connection(false, error.message); } finally { busy = false; }
}

$('search').addEventListener('input', renderNavigation);
$('all-filter').addEventListener('click', () => { scope = 'all'; if (settingsOpen) location.hash = sessions[0] ? `/session/${sessions[0].id}` : ''; renderNavigation(); });
$('running-filter').addEventListener('click', () => { scope = 'running'; if (settingsOpen) location.hash = sessions.find(s => isActive(s.status)) ? `/session/${sessions.find(s => isActive(s.status)).id}` : ''; renderNavigation(); });
$('models-nav').addEventListener('click', () => { location.hash = '/settings/models'; $('app').classList.remove('mobile-open'); });
$('refresh-button').addEventListener('click', () => { etag = null; void refresh(); });
$('theme-toggle').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('subagent-theme', theme); });
$('sidebar-toggle').addEventListener('click', () => { $('app').classList.toggle(innerWidth <= 760 ? 'mobile-open' : 'sidebar-collapsed'); });
$('sidebar-backdrop').addEventListener('click', () => $('app').classList.remove('mobile-open'));
$('jump-bottom').addEventListener('click', () => { $('conversation-scroll').scrollTo({ top: $('conversation-scroll').scrollHeight, behavior: 'smooth' }); });
$('conversation-scroll').addEventListener('scroll', checkScroll, { passive: true });
$('load-earlier').addEventListener('click', async () => {
  if (!data || data.earlier_cursor === null) return;
  const beforeHeight = $('conversation-scroll').scrollHeight; const top = $('conversation-scroll').scrollTop; const id = selectedId;
  try {
    const older = await json(`/api/sessions/${id}?before=${data.earlier_cursor}`); if (id !== selectedId) return;
    data.entries = [...older.entries, ...data.entries]; data.earlier_cursor = older.earlier_cursor;
    renderConversation(); requestAnimationFrame(() => { $('conversation-scroll').scrollTop = top + $('conversation-scroll').scrollHeight - beforeHeight; });
  } catch (error) { toast(error.message); }
});
$('pin-button').addEventListener('click', async () => {
  if (!data) return;
  try { await json(`/api/sessions/${selectedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !data.session.pinned }) }); etag = null; await refresh(); } catch (error) { toast(error.message); }
});
$('rename-button').addEventListener('click', () => { if (data) { $('rename-input').value = data.session.title; $('rename-dialog').showModal(); $('rename-input').select(); } });
$('rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await json(`/api/sessions/${selectedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('rename-input').value.trim() }) }); $('rename-dialog').close(); etag = null; await refresh(); toast('会话名称已更新'); } catch (error) { toast(error.message); }
});
$('info-button').addEventListener('click', () => {
  if (!data) return;
  const fragment = document.createDocumentFragment(); const s = data.session;
  const rows = [['工作目录', s.cwd], ['模型与路由', `${s.model} · ${s.provider}`], ['会话来源', '由 MCP 调用，已关联任务记录'], ['创建时间', fullDate(s.created_at)], ['最后更新', fullDate(s.updated_at)], ['Token 用量', data.usage.status === 'reported' ? `输入 ${(data.usage.input_tokens || 0).toLocaleString()} · 输出 ${(data.usage.output_tokens || 0).toLocaleString()}` : '上游未提供有效统计，暂不可用']];
  for (const [label, value] of rows) { const row = node('div', 'info-row'); row.append(node('span', '', label), node('div', '', value)); fragment.append(row); }
  const id = node('div', 'info-row'); id.append(node('span', '', '会话 ID'), node('div', '', s.id)); const button = node('button', 'info-copy', '复制会话 ID'); button.addEventListener('click', () => copy(s.id)); id.append(button); fragment.append(id);
  $('info-content').replaceChildren(fragment); $('info-dialog').showModal();
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (innerWidth <= 760) $('app').classList.add('mobile-open'); $('search').focus(); } });
window.addEventListener('hashchange', fromHash);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
fromHash();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
