// Operator-level push: after a reporter run, notify configured channels with a
// summary of everything generated. This is NOT per-user — it sends one digest
// to the operator's Bark device(s) and/or email recipients, mirroring the
// Don_daily_paper_report Python tool. Per-user push would require storing each
// user's channels (see note in reporter docs).
//
// Every channel is skipped silently when its required config is absent, so push
// is fully opt-in via env.

const log = (...parts) => console.log('[reporter:push]', ...parts);

// Byte-aware truncation (Bark bodies are capped in bytes, and Chinese text is
// multi-byte). Mirrors the Python _truncate.
function truncate(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > limit - 3) {
    out = out.slice(0, -1);
  }
  return out + '...';
}

// In a web app the "full digest" lives in the app, not a local file.
const FULL_HINT = '完整内容见 PaperDaily 网页';

// --- Bark --------------------------------------------------------------------

function barkTargets(cfg) {
  const server = cfg.push.bark.server.replace(/\/+$/, '');
  const seen = new Set();
  const out = [];
  for (const key of cfg.push.bark.keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ server, key });
  }
  return out;
}

async function pushBark(cfg, title, body) {
  const targets = barkTargets(cfg);
  if (!targets.length) return;
  const payload = JSON.stringify({
    title,
    body: truncate(body, cfg.push.bark.bodyLimit),
    group: '论文日报',
    sound: 'birdsong',
  });
  for (let i = 0; i < targets.length; i++) {
    const { server, key } = targets[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(server + '/' + key, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: payload,
      });
      const text = (await res.text().catch(() => '')).slice(0, 200);
      log(`Bark 推送[target${i + 1}]: HTTP ${res.status} ${text}`);
    } catch (err) {
      log(`Bark 推送失败[target${i + 1}]:`, err.message);
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- shared selection --------------------------------------------------------

// Flatten the first push_n items of every scope into [{ scope, item }, ...].
function selectedPushItems(scopeResults) {
  const selected = [];
  for (const { scope, items } of scopeResults) {
    const pushN = Math.min(scope.push_n, items.length);
    for (const item of items.slice(0, pushN)) selected.push({ scope, item });
  }
  return selected;
}

// --- Bark push modes ---------------------------------------------------------

async function pushSummaryDigest(cfg, scopeResults, dateStr) {
  const selected = selectedPushItems(scopeResults);
  if (!selected.length) {
    await pushBark(cfg, `论文日报 · ${dateStr}`, '今日没有抓到可推送的新论文。');
    return;
  }
  const lines = [
    `今日共 ${scopeResults.length} 个方向, 精选 ${selected.length} 篇。${FULL_HINT}。`,
    '',
  ];
  selected.forEach(({ scope, item }, i) => {
    lines.push(`${i + 1}. [${scope.name}] ${item.paper.title}`);
    if (item.tldr) lines.push(`   ${item.tldr}`);
    lines.push(`   arXiv: ${item.paper.abs_url}`);
    lines.push('');
  });
  await pushBark(cfg, `论文日报 · ${dateStr} · ${selected.length}篇`, lines.join('\n'));
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

async function pushScopeDigest(cfg, scope, items, dateStr) {
  const pushN = Math.min(scope.push_n, items.length);
  if (!pushN) return;
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
  await pushBark(cfg, `论文日报 ${scope.name} · ${pushN}篇 · ${dateStr}`, text);
}

async function pushItemDigest(cfg, scope, items, dateStr) {
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
    await pushBark(cfg, `论文日报 ${scope.name} ${i + 1}/${pushN} · ${dateStr}`, body.join('\n'));
  }
}

async function pushDigests(cfg, scopeResults, dateStr) {
  if (!barkTargets(cfg).length) {
    log('未配置 Bark key, 跳过 iPhone 推送');
    return;
  }
  const mode = cfg.push.mode;
  if (mode === 'per_item') {
    for (const { scope, items } of scopeResults) {
      await pushItemDigest(cfg, scope, items, dateStr);
    }
  } else if (mode === 'per_scope') {
    let sent = false;
    for (const { scope, items } of scopeResults) {
      if (items.length) {
        await pushScopeDigest(cfg, scope, items, dateStr);
        sent = true;
      }
    }
    if (!sent) await pushBark(cfg, `论文日报 · ${dateStr}`, '今日没有抓到可推送的新论文。');
  } else {
    await pushSummaryDigest(cfg, scopeResults, dateStr);
  }
}

// --- Markdown (email body + attachment) --------------------------------------

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

// --- Email -------------------------------------------------------------------

async function sendEmailDigest(cfg, scopeResults, dateStr, markdown) {
  const e = cfg.push.email;
  if (!e.to.length) {
    log('未配置 EMAIL_TO, 跳过邮件推送');
    return;
  }
  const user = e.smtpUser || e.from;
  if (!(e.from && e.smtpHost && user && e.smtpPassword)) {
    log('邮件配置不完整, 跳过邮件推送');
    return;
  }

  // nodemailer is only needed when email push is configured, so load it lazily.
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    log('未安装 nodemailer, 跳过邮件推送 (npm --workspace server i nodemailer)');
    return;
  }

  const selected = selectedPushItems(scopeResults);
  const lines = [`论文日报 ${dateStr}`, '', `精选 ${selected.length} 篇, 完整 Markdown 见附件。`, ''];
  selected.forEach(({ scope, item }, i) => {
    lines.push(`${i + 1}. [${scope.name}] ${item.paper.title}`);
    if (item.tldr) lines.push(`   ${item.tldr}`);
    lines.push(`   ${item.paper.abs_url}`, '');
  });
  const subject = `${e.subjectPrefix || '论文日报'} · ${dateStr} · ${selected.length}篇`;

  const transporter = nodemailer.createTransport({
    host: e.smtpHost,
    port: e.smtpPort,
    secure: e.smtpUseSsl, // true for 465, false for STARTTLS on 587
    auth: { user, pass: e.smtpPassword },
  });

  try {
    await transporter.sendMail({
      from: e.from,
      to: e.to.join(', '),
      subject,
      text: lines.join('\n'),
      attachments: [{ filename: `${dateStr}.md`, content: markdown, contentType: 'text/markdown' }],
    });
    log('邮件推送成功:', e.to.join(', '));
  } catch (err) {
    log('邮件推送失败:', err.message);
  }
}

/**
 * Push the day's digest to every configured channel. Best-effort: a channel
 * that's unconfigured or errors is logged and skipped, never throwing.
 */
export async function pushAll(cfg, scopeResults, dateStr) {
  const markdown = renderMarkdown(scopeResults, dateStr);
  await pushDigests(cfg, scopeResults, dateStr);
  await sendEmailDigest(cfg, scopeResults, dateStr, markdown);
}
