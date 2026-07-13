// arXiv client: build query URLs, fetch with polite pacing + retry/backoff, and
// parse the Atom response into paper objects. Independent Node port of the
// arxiv_query_url / fetch_query / parse_atom logic in the reference Python tool.

const log = (...parts) => console.log('[reporter:arxiv]', ...parts);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-memory min-interval gate shared across all fetches in a run, so we never
// hit export.arxiv.org faster than arxivMinIntervalSeconds. One run/day over a
// few scopes stays well within arXiv's limits, so no persistent state is kept.
let lastRequestAt = 0;

// Mirror Python urllib.parse.quote_plus: space -> '+', percent-encode the rest
// except the unreserved set and any explicitly-safe characters.
function quotePlus(input, safe = '') {
  const unreserved = /[A-Za-z0-9_.\-~]/;
  let out = '';
  for (const ch of input) {
    if (ch === ' ') {
      out += '+';
    } else if (unreserved.test(ch) || safe.includes(ch)) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

// Expand a quoted field query like author:"Jane Doe" into the AND-ed per-term
// form arXiv expects (author:Jane AND author:Doe). No-op for our default
// queries, but kept for parity with the reference normalizer.
function expandQuotedFields(query) {
  return query.replace(/\b([a-z]+):"([^"]+)"/g, (whole, field, phrase) => {
    const terms = phrase.match(/[A-Za-z0-9]+/g) || [];
    if (!terms.length) return whole;
    const expanded = terms.map((t) => `${field}:${t}`).join(' AND ');
    return terms.length > 1 ? `(${expanded})` : expanded;
  });
}

export function normalizeQuery(query) {
  const decoded = decodeURIComponent(String(query).trim().replace(/\+/g, ' '));
  return expandQuotedFields(decoded).replace(/\s+/g, ' ').trim();
}

/**
 * Build an arXiv API query URL. `opts.submittedDateRange` ({ start, end } as
 * 'YYYYMMDDHHMM' strings) appends an `AND submittedDate:[start TO end]` clause so
 * on-demand reports can target a specific day; omitting it (the default, used by
 * the scheduled reporter) queries without a date bound. The range is spliced in
 * after quotePlus() encoding — its safe set is only ':()', so the brackets and
 * spaces are pre-encoded here (%5B/%5D and '+').
 */
export function buildQueryUrl(query, maxResults, { submittedDateRange } = {}) {
  let searchQuery = quotePlus(normalizeQuery(query), ':()');
  if (submittedDateRange) {
    const { start, end } = submittedDateRange;
    searchQuery += '+AND+submittedDate:%5B' + start + '+TO+' + end + '%5D';
  }
  return (
    'https://export.arxiv.org/api/query?search_query=' +
    searchQuery +
    '&sortBy=submittedDate&sortOrder=descending&max_results=' +
    String(maxResults)
  );
}

// Honor the inter-request floor before each network call.
async function paceRequest(minIntervalSeconds) {
  const wait = minIntervalSeconds * 1000 - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Fetch one arXiv query, returning the raw Atom XML (or '' on failure).
 * Retries on 406/429/5xx with backoff, respecting Retry-After when present.
 */
export async function fetchQuery(query, maxResults, scope, cfg, opts) {
  const url = buildQueryUrl(query, maxResults, opts);
  const retries = Math.max(1, cfg.arxivRetries);
  const retryDelay = Math.max(1, cfg.arxivRetryDelaySeconds);
  const RETRYABLE = new Set([406, 429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= retries; attempt++) {
    await paceRequest(cfg.arxivMinIntervalSeconds);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': cfg.arxivUserAgent,
          Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.1',
        },
      });

      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          let wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
          if (wait == null) {
            wait = res.status === 429 ? retryDelay * attempt : retryDelay * 2 ** (attempt - 1);
          }
          log(`查询受限/异常: ${query} HTTP ${res.status}, ${wait.toFixed(0)}s 后重试 ${attempt + 1}/${retries}`);
          await sleep(wait * 1000);
          continue;
        }
        log(`查询失败: ${query} HTTP ${res.status}`);
        return '';
      }
      return await res.text();
    } catch (err) {
      if (attempt < retries) {
        const wait = retryDelay * 2 ** (attempt - 1);
        log(`查询异常: ${query} ${err.message}, ${wait.toFixed(0)}s 后重试 ${attempt + 1}/${retries}`);
        await sleep(wait * 1000);
        continue;
      }
      log(`查询失败: ${query} ${err.message}`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

// --- Atom parsing -------------------------------------------------------------
// arXiv returns Atom with a default namespace, so tags are unprefixed. We pull
// the handful of fields we need rather than depending on a full XML parser.

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so decoded entities aren't re-decoded
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function parseAtom(xml) {
  const papers = [];
  if (!xml || !xml.trim()) return papers;

  const entries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/g) || [];
  for (const entry of entries) {
    const rawId = tagText(entry, 'id');
    const idMatch = rawId.match(/arxiv\.org\/abs\/([0-9]+\.[0-9]+)/);
    const aid = idMatch ? idMatch[1] : rawId;
    const summary = tagText(entry, 'summary');

    const ghMatch = summary.match(/https?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+/);
    const github = ghMatch ? ghMatch[0].replace(/\.+$/, '') : '';

    let pdfUrl = '';
    for (const link of entry.match(/<link\b[^>]*>/g) || []) {
      if (/title="pdf"/.test(link)) {
        const href = link.match(/href="([^"]*)"/);
        if (href) pdfUrl = href[1];
      }
    }

    const authors = [];
    for (const author of entry.match(/<author\b[^>]*>[\s\S]*?<\/author>/g) || []) {
      const name = tagText(author, 'name');
      if (name) authors.push(name);
    }

    papers.push({
      id: aid,
      title: tagText(entry, 'title'),
      summary,
      published: tagText(entry, 'published'),
      authors,
      abs_url: idMatch ? 'https://arxiv.org/abs/' + aid : rawId,
      pdf_url: pdfUrl,
      github,
    });
  }
  return papers;
}
