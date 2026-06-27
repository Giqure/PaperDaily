// Curation: pick the top-N papers per scope with an OpenAI-compatible chat API,
// with a keyword-tag fallback when no key is configured or the call fails.
// Independent Node port of build_curate_prompt / call_openai_api /
// parse_curate_response / keyword_tag / pwc_code / build_items.

const log = (...parts) => console.log('[reporter:curate]', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Join an OpenAI-compatible base url with a path, collapsing a duplicated /v1
// (base ".../v1" + path "/v1/chat/..." -> ".../v1/chat/...").
function apiUrl(base, path) {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1') && path.startsWith('/v1/')) {
    return trimmed + path.slice(3);
  }
  return trimmed + path;
}

function buildCuratePrompt(scope, candidates) {
  const targetN = Math.min(scope.top_n, candidates.length);
  const listing = candidates
    .slice(0, scope.max_candidates)
    .map(
      (p, i) =>
        `[${i}] 标题: ${p.title}\n发表时间: ${p.published || ''}\n摘要: ${(p.summary || '').slice(0, 900)}`
    )
    .join('\n\n');

  const interestLine = scope.interests
    ? `读者在本范围特别关注: ${scope.interests}。相关论文可优先进入前列。\n`
    : '';

  return (
    '你是具身智能和机器人方向的资深科研助理。\n' +
    `当前检索范围是: ${scope.name}。\n` +
    interestLine +
    `请从候选论文中选出最值得关注的 ${targetN} 篇, 并按重要性从高到低排序。` +
    '只依据标题和摘要, 不要编造摘要中没有的数字、baseline、代码或结论。' +
    '若是推断, 必须写明「推测」或「可能」。\n' +
    '每篇输出字段:\n' +
    '- idx: 候选编号\n' +
    '- tag: 简短中文方向标签\n' +
    '- tldr: 一句话亮点, 20-35字\n' +
    '- position: 文献定位, 1-2句, 说明它接在哪条研究脉络上\n' +
    '- zh_summary: 中文解读, 5-8句, 讲清问题、方法、创新、实验结果、价值和局限\n' +
    '- highlights: 2-4条短要点数组\n' +
    '只输出能被 JSON.parse 解析的 JSON 数组, 不要 markdown, 不要额外文字。' +
    '字符串内部不要使用英文双引号或换行, 术语引用用中文引号「」。' +
    '格式: [{"idx":0,"tag":"...","tldr":"...","position":"...","zh_summary":"...","highlights":["..."]}]\n\n' +
    `候选列表:\n${listing}`
  );
}

async function callChatApi(cfg, prompt) {
  const apiKey = cfg.openaiApiKey;
  if (!apiKey) {
    log('未配置 OPENAI_API_KEY, 跳过 AI 精选');
    return null;
  }

  const url = apiUrl(cfg.openaiBaseUrl, '/v1/chat/completions');
  const body = JSON.stringify({
    model: cfg.openaiModel,
    max_tokens: cfg.apiMaxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const attempts = Math.max(1, cfg.apiRetries);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      log(`调用 OpenAI-compatible API (${cfg.openaiModel}, 第${attempt}/${attempts}次)...`);
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log('API HTTP错误:', res.status, detail.slice(0, 500));
      } else {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        if (Array.isArray(content)) {
          return content
            .map((part) =>
              typeof part === 'object' && part ? String(part.text ?? part.content ?? '') : String(part)
            )
            .join('');
        }
        return String(content);
      }
    } catch (err) {
      log('API 调用失败:', err.message);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(5000);
  }
  return null;
}

function parseCurateResponse(raw, candidates, targetN) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    log('模型输出未找到 JSON 数组');
    return null;
  }
  const blob = match[0];
  let data;
  try {
    data = JSON.parse(blob);
  } catch {
    try {
      data = JSON.parse(blob.replace(/[\r\n\t]/g, ' '));
      log('JSON 经容错修复后解析成功');
    } catch (err) {
      log('JSON 解析失败:', err.message);
      return null;
    }
  }
  if (!Array.isArray(data)) return null;

  const cleaned = [];
  const seen = new Set();
  for (const item of data) {
    const idx = Number(item?.idx);
    if (!Number.isInteger(idx) || seen.has(idx) || idx < 0 || idx >= candidates.length) {
      continue;
    }
    seen.add(idx);
    let highlights = item.highlights;
    if (!Array.isArray(highlights)) highlights = highlights == null ? [] : [highlights];
    cleaned.push({
      idx,
      tag: String(item.tag ?? '论文').trim(),
      tldr: String(item.tldr ?? '').trim(),
      position: String(item.position ?? '').trim(),
      zh_summary: String(item.zh_summary ?? '').trim(),
      highlights: highlights.map((x) => String(x).trim()).filter(Boolean),
    });
  }
  return cleaned.slice(0, targetN).length ? cleaned.slice(0, targetN) : null;
}

const KEYWORD_TAGS = [
  ['vision-language-action', 'VLA'], ['vla', 'VLA'],
  ['manipulat', '机器人操作'], ['grasp', '抓取'],
  ['navigat', '导航'], ['humanoid', '人形机器人'],
  ['dexterous', '灵巧手'], ['sim-to-real', 'Sim2Real'],
  ['world model', '世界模型'], ['locomot', '运动控制'],
  ['reinforcement', '强化学习'], ['embodied', '具身智能'],
];

function keywordTag(text) {
  const low = text.toLowerCase();
  for (const [kw, tag] of KEYWORD_TAGS) {
    if (low.includes(kw)) return tag;
  }
  return '论文';
}

// Code link: prefer a github url found in the abstract, else ask
// paperswithcode, else "暂无". Best-effort — never throws.
async function lookupCode(paper) {
  if (paper.github) return paper.github;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(
      `https://paperswithcode.com/api/v1/papers/${paper.id}/repositories/`,
      { signal: controller.signal }
    ).finally(() => clearTimeout(timer));
    if (res.ok) {
      const data = await res.json();
      const url = data?.results?.[0]?.url;
      if (url) return url;
    }
  } catch {
    // ignore — code link is optional
  }
  return '暂无';
}

/**
 * Curate candidates into ranked items for a scope. Uses the AI endpoint when
 * available, falling back to keyword tags. Returns the archive item shape:
 * { paper, tag, tldr, position, zh_summary, highlights, code }.
 */
export async function curate(scope, candidates, cfg) {
  const targetN = Math.min(scope.top_n, candidates.length);
  let items = [];

  if (targetN) {
    const raw = await callChatApi(cfg, buildCuratePrompt(scope, candidates));
    const curated = raw ? parseCurateResponse(raw, candidates, targetN) : null;
    if (curated) {
      items = curated.map((c) => ({
        paper: candidates[c.idx],
        tag: c.tag,
        tldr: c.tldr,
        position: c.position,
        zh_summary: c.zh_summary,
        highlights: c.highlights,
      }));
    }
  }

  if (!items.length) {
    log(`范围[${scope.name}] 使用关键词兜底模式`);
    items = candidates.slice(0, targetN).map((paper) => ({
      paper,
      tag: keywordTag(`${paper.title} ${paper.summary}`),
      tldr: '',
      position: '',
      zh_summary: '(未启用或未成功调用 AI 精选) ' + (paper.summary || '').slice(0, 500),
      highlights: [],
    }));
  }

  for (const item of items) {
    item.code = await lookupCode(item.paper);
  }
  return items;
}
