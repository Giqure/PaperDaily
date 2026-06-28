// Per-user push: after a reporter run, each user who enabled a push channel
// receives a digest of THEIR subscribed scopes via their chosen channels
// (email to their account address, Bark to their own device key).
//
// Transport is operator-level env (SMTP login, Bark server); recipients, the
// per-channel toggles, and each user's Bark key are per-user DB state. A user
// or channel that's unconfigured is skipped silently. Best-effort: a failure on
// one user/channel never aborts the rest, and never blocks the stored digest.

import { usersWithPushEnabled } from '../users/queries.js';
import { subscribedScopeNames } from '../subscriptions/queries.js';

const log = (...parts) => console.log('[reporter:push]', ...parts);

// In a web app the "full digest" lives in the app, not a local file.
const FULL_HINT = '完整内容见 PaperDaily 网页';

// Byte-aware truncation (Bark bodies are capped in bytes, and Chinese text is
// multi-byte).
function truncate(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > limit - 3) {
    out = out.slice(0, -1);
  }
  return out + '...';
}

// Keep only the scopes this user follows from the day's full results.
function sliceForUser(scopeResults, scopeNames) {
  const set = new Set(scopeNames);
  return scopeResults.filter((r) => set.has(r.scope.name));
}

// Flatten the first push_n items of every scope into [{ scope, item }, ...].
function selectedPushItems(scopeResults) {
  const selected = [];
  for (const { scope, items } of scopeResults) {
    const pushN = Math.min(scope.push_n, items.length);
    for (const item of items.slice(0, pushN)) selected.push({ scope, item });
  }
  return selected;
}

// --- Bark message builders (one per push mode) -------------------------------
// Each returns an array of { title, body } messages to deliver.

function summaryMessages(scopeResults, dateStr) {
  const selected = selectedPushItems(scopeResults);
  if (!selected.length) {
    return [{ title: `论文日报 · ${dateStr}`, body: '今日没有抓到可推送的新论文。' }];
  }
  const lines = [
    `今日共 ${scopeResults.length} 个方向, 精选 ${selected.length} 篇。${FULL_HINT}。`,
    '',
  ];
  selected.forEach(({ scope, item }, i) => {
    lines.push(`${i + 1}. [${scope.name}] ${item.paper.title}`);
    if (item.tldr) lines.push(`   ${item.tldr}`);
    lines.push(`   arXiv: ${item.paper.abs_url}`, '');
  });
  return [{ title: `论文日报 · ${dateStr} · ${selected.length}篇`, body: lines.join('\n') }];
}

function formatPushItem(item, index, summaryChars) {
  const p = item.paper;
  const lines = [`${index}. [${item.tag}] ${p.title}`];
  if (item.tldr) lines.push('亮点: ' + item.tldr);
  if (item.position) lines.push('定位: ' + item.position);
  let summary = item.zh_summary || '';
  if (summary && summaryChars) summary = truncate(summary, summaryChars);
  if (summary) lines.push('解读: ' + summary);
  if (item.highlights?.length) lines.push('要点: ' + item.highlights.join('；'));
  lines.push('arXiv: ' + p.abs_url);
  lines.push('代码: ' + item.code);
  return lines.join('\n');
}

function perScopeMessages(cfg, scopeResults, dateStr) {
  const msgs = [];
  for (const { scope, items } of scopeResults) {
    const pushN = Math.min(scope.push_n, items.length);
    if (!pushN) continue;
    const body = items.slice(0, pushN);
    const header = `${scope.name} · 推送前 ${pushN} 篇\n${FULL_HINT}。\n`;
    let text = header + body.map((it, i) => formatPushItem(it, i + 1)).join('\n\n');
    if (Buffer.byteLength(text, 'utf8') > cfg.push.bark.bodyLimit) {
      const perItem = Math.max(80, Math.floor(900 / pushN));
      text =
        header +
        '本方向内容超过 Bark 单条容量, 已压缩每篇解读；完整版本见网页。\n\n' +
        body.map((it, i) => formatPushItem(it, i + 1, perItem)).join('\n\n');
    }
    msgs.push({ title: `论文日报 ${scope.name} · ${pushN}篇 · ${dateStr}`, body: text });
  }
  if (!msgs.length) {
    msgs.push({ title: `论文日报 · ${dateStr}`, body: '今日没有抓到可推送的新论文。' });
  }
  return msgs;
}

function perItemMessages(scopeResults, dateStr) {
  const msgs = [];
  for (const { scope, items } of scopeResults) {
    const pushN = Math.min(scope.push_n, items.length);
    for (let i = 0; i < pushN; i++) {
      const item = items[i];
      const p = item.paper;
      const body = [`[${item.tag}] ${p.title}`];
      if (item.tldr) body.push('亮点: ' + item.tldr);
      if (item.position) body.push('', '文献定位: ' + item.position);
      body.push('', item.zh_summary || '');
      if (item.highlights?.length) {
        body.push('', '要点:');
        for (const h of item.highlights) body.push('- ' + h);
      }
      body.push('', 'arXiv: ' + p.abs_url, '代码: ' + item.code);
      msgs.push({ title: `论文日报 ${scope.name} ${i + 1}/${pushN} · ${dateStr}`, body: body.join('\n') });
    }
  }
  if (!msgs.length) {
    msgs.push({ title: `论文日报 · ${dateStr}`, body: '今日没有抓到可推送的新论文。' });
  }
  return msgs;
}

function buildBarkMessages(cfg, scopeResults, dateStr) {
  if (cfg.push.mode === 'per_item') return perItemMessages(scopeResults, dateStr);
  if (cfg.push.mode === 'per_scope') return perScopeMessages(cfg, scopeResults, dateStr);
  return summaryMessages(scopeResults, dateStr);
}

// --- Bark transport (operator server, per-user key) --------------------------

async function sendBark(cfg, key, title, body) {
  const server = cfg.push.bark.server.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(server + '/' + encodeURIComponent(key), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title,
        body: truncate(body, cfg.push.bark.bodyLimit),
        group: '论文日报',
        sound: 'birdsong',
      }),
    });
    const text = (await res.text().catch(() => '')).slice(0, 120);
    log(`Bark -> ${key.slice(0, 6)}…: HTTP ${res.status} ${text}`);
  } catch (err) {
    log(`Bark 推送失败 (${key.slice(0, 6)}…):`, err.message);
  } finally {
    clearTimeout(timer);
  }
}

// --- Email (full digest as Markdown + summary attachment) --------------------

export function renderMarkdown(scopeResults, dateStr) {
  const total = scopeResults.reduce((n, r) => n + r.items.length, 0);
  const lines = [
    `# 多范围论文日报 · ${dateStr}`,
    '',
    `范围数: ${scopeResults.length}; 论文数: ${total}`,
    '',
  ];
  for (const { scope, items } of scopeResults) {
    lines.push(`## ${scope.name} · Top${items.length}`, '');
    if (!items.length) {
      lines.push('今日没有抓到该范围的新论文。', '');
      continue;
    }
    items.forEach((item, idx) => {
      const p = item.paper;
      lines.push(`### ${idx + 1}. [${item.tag}] ${p.title}`, '');
      if (item.tldr) lines.push(`> ${item.tldr}`, '');
      if (p.authors?.length) {
        const authors = p.authors.slice(0, 6).join(', ') + (p.authors.length > 6 ? ' 等' : '');
        lines.push('**作者**: ' + authors);
      }
      if (p.published) lines.push('**发表时间**: ' + p.published);
      if (item.position) lines.push('**文献定位**: ' + item.position);
      lines.push('', item.zh_summary || '', '');
      if (item.highlights?.length) {
        lines.push('**亮点**:');
        for (const h of item.highlights) lines.push('- ' + h);
        lines.push('');
      }
      lines.push('**链接**:');
      lines.push(`- arXiv: ${p.abs_url}`);
      lines.push(`- PDF: ${p.pdf_url || '暂无'}`);
      lines.push(`- 代码: ${item.code}`);
      lines.push('');
    });
  }
  return lines.join('\n');
}

// True when the operator has fully configured the SMTP transport.
function emailConfigured(cfg) {
  const e = cfg.push.email;
  const user = e.smtpUser || e.from;
  return !!(e.from && e.smtpHost && user && e.smtpPassword);
}

// Build one SMTP transport for the whole run (lazy nodemailer import).
async function makeTransporter(cfg) {
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    log('未安装 nodemailer, 跳过邮件推送 (npm --workspace server i nodemailer)');
    return null;
  }
  const e = cfg.push.email;
  return nodemailer.createTransport({
    host: e.smtpHost,
    port: e.smtpPort,
    secure: e.smtpUseSsl, // true for 465, false for STARTTLS on 587
    auth: { user: e.smtpUser || e.from, pass: e.smtpPassword },
  });
}

async function sendUserEmail(cfg, transporter, user, scopeResults, dateStr) {
  const e = cfg.push.email;
  const selected = selectedPushItems(scopeResults);
  const lines = [`论文日报 ${dateStr}`, '', `精选 ${selected.length} 篇, 完整 Markdown 见附件。`, ''];
  selected.forEach(({ scope, item }, i) => {
    lines.push(`${i + 1}. [${scope.name}] ${item.paper.title}`);
    if (item.tldr) lines.push(`   ${item.tldr}`);
    lines.push(`   ${item.paper.abs_url}`, '');
  });
  const subject = `${e.subjectPrefix || '论文日报'} · ${dateStr} · ${selected.length}篇`;
  try {
    await transporter.sendMail({
      from: e.from,
      to: user.email,
      subject,
      text: lines.join('\n'),
      attachments: [
        { filename: `${dateStr}.md`, content: renderMarkdown(scopeResults, dateStr), contentType: 'text/markdown' },
      ],
    });
    log('邮件 ->', user.email);
  } catch (err) {
    log(`邮件推送失败 (${user.email}):`, err.message);
  }
}

/**
 * Fan the day's digest out to every push-enabled user, scoped to the scopes
 * each follows. Returns counts for logging/tests.
 */
export async function pushToUsers(cfg, scopeResults, dateStr) {
  const users = usersWithPushEnabled();
  if (!users.length) return { users: 0, emails: 0, bark: 0 };

  // One shared transporter for all emails this run; null if SMTP isn't set up.
  const transporter = emailConfigured(cfg) ? await makeTransporter(cfg) : null;
  if (users.some((u) => u.email_push_enabled) && !transporter) {
    log('有用户开启了邮件推送, 但服务端未配置 SMTP, 跳过所有邮件');
  }

  let emails = 0;
  let bark = 0;
  for (const user of users) {
    const slice = sliceForUser(scopeResults, subscribedScopeNames(user.id));
    if (!slice.length) continue; // user follows nothing collected today

    if (user.bark_push_enabled && user.bark_key) {
      for (const m of buildBarkMessages(cfg, slice, dateStr)) {
        await sendBark(cfg, user.bark_key, m.title, m.body);
      }
      bark++;
    }
    if (user.email_push_enabled && transporter) {
      await sendUserEmail(cfg, transporter, user, slice, dateStr);
      emails++;
    }
  }
  log(`推送完成: ${emails} 封邮件, ${bark} 个 Bark 用户`);
  return { users: users.length, emails, bark };
}
