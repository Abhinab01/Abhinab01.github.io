import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SCHEDULE_PATH = path.join(ROOT_DIR, 'ota', 'exam_schedule.json');
const SOURCES_PATH = path.join(__dirname, 'exam_sources.json');
const SYNC_LOG_PATH = path.join(ROOT_DIR, 'ota', 'sync_log.json');

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const POSITIVE_DATE_CUES = [
  'preliminary', 'prelims', 'tier-i', 'tier i', 'tier 1',
  'phase-i', 'phase i', 'phase 1', 'exam date', 'examination',
  'scheduled on', 'scheduled for', 'conducted on', 'test date', 'cbt',
];

const NEGATIVE_KEYWORDS = [
  'apply', 'application', 'registration', 'last date', 'closing date',
  'apply online', 'fee payment', 'admit card', 'call letter',
  'result', 'scorecard', 'cut off', 'cutoff', 'interview',
  'mains', 'phase-ii', 'phase ii', 'phase 2', 'tier-ii', 'tier ii', 'tier 2',
];

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isDateInValidWindow(isoDate, nowDate = new Date()) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const maxDate = today + 450 * 86400000;
  return target >= today && target <= maxDate;
}

export function parseDatesFromText(text, nowDate = new Date()) {
  const results = [];
  const src = String(text);

  const patterns = [
    // Multi-day or single: "14 & 15 March 2027", "29 November 2026", "29th Nov 2026"
    {
      re: /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:&|and|,|-|to)\s*\d{1,2}(?:st|nd|rd|th)?)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*,?\s*(20\d{2})\b/gi,
      extract: (m) => formatIsoDate(m[3], MONTHS[m[2].toLowerCase()], m[1]),
    },
    // "Nov 29, 2026" or "November 29, 2026"
    {
      re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/gi,
      extract: (m) => formatIsoDate(m[3], MONTHS[m[1].toLowerCase()], m[2]),
    },
    // "2026-11-29"
    {
      re: /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
      extract: (m) => formatIsoDate(m[1], m[2], m[3]),
    },
    // "29.11.2026" or "29/11/2026"
    {
      re: /\b(0?[1-9]|[12]\d|3[01])[./](0?[1-9]|1[0-2])[./](20\d{2})\b/g,
      extract: (m) => formatIsoDate(m[3], m[2], m[1]),
    },
  ];

  for (const { re, extract } of patterns) {
    let match;
    while ((match = re.exec(src)) !== null) {
      const iso = extract(match);
      if (iso && isDateInValidWindow(iso, nowDate)) {
        results.push({
          date: iso,
          index: match.index,
          raw: match[0],
        });
      }
    }
  }
  return results;
}

export function evaluateCandidatesFromText({
  examKey,
  text,
  sourceUrl,
  sourceType = 'official',
  includePatterns = [],
  excludePatterns = [],
  nowDate = new Date(),
}) {
  const candidates = parseDatesFromText(text, nowDate);
  const scored = [];

  for (const cand of candidates) {
    const start140 = Math.max(0, cand.index - 140);
    const end140 = Math.min(text.length, cand.index + cand.raw.length + 140);
    const window140 = text.slice(start140, end140);
    const lower140 = window140.toLowerCase();

    // Sentence-bounded negative keyword check within +-140 chars so adjacent sentences don't poison valid exam dates
    const preWindow = text.slice(start140, cand.index);
    const postWindow = text.slice(cand.index + cand.raw.length, end140);
    const preClause = preWindow.split(/[.\n;]/).pop() || '';
    const postClause = postWindow.split(/[.\n;]/)[0] || '';
    const localClauseLower = `${preClause} ${cand.raw} ${postClause}`.toLowerCase();

    const start240 = Math.max(0, cand.index - 240);
    const end240 = Math.min(text.length, cand.index + cand.raw.length + 240);
    const lower240 = text.slice(start240, end240).toLowerCase();

    const hasNegative =
      NEGATIVE_KEYWORDS.some((kw) => localClauseLower.includes(kw)) ||
      excludePatterns.some((kw) => localClauseLower.includes(kw.toLowerCase()));

    if (hasNegative) continue;

    const hasPositiveCue = POSITIVE_DATE_CUES.some((kw) => lower140.includes(kw));
    const hasIdentityCue =
      includePatterns.length === 0 ||
      includePatterns.some((pat) => lower240.includes(pat.toLowerCase()));

    if (!hasPositiveCue || !hasIdentityCue) continue;

    const confidence = sourceType === 'official' ? 'high' : 'medium';
    scored.push({
      examKey,
      detectedDate: cand.date,
      sourceUrl,
      snippet: window140.trim().slice(0, 220),
      confidence,
    });
  }

  return scored;
}

export function nextMonotonicRevision(currentRevision, nowDate = new Date()) {
  const y = nowDate.getUTCFullYear();
  const m = String(nowDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nowDate.getUTCDate()).padStart(2, '0');
  const todayRev = Number(`${y}${m}${d}01`);
  return Math.max((Number(currentRevision) || 0) + 1, todayRev);
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function extractTextFromResponse(res, typeHint) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (typeHint === 'pdf' || contentType.includes('application/pdf')) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const { extractText } = await import('unpdf');
    const result = await extractText(buf, { mergePages: true });
    return String(result.text || '').replace(/\s+/g, ' ').trim();
  }
  const html = await res.text();
  return stripHtml(html);
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
    items.push({
      text: stripHtml(`${title} ${desc}`),
      link,
    });
  }
  return items;
}

export async function runSync({ dryRun = false, nowDate = new Date() } = {}) {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));

  const autoUpdated = [];
  const pendingReview = [];
  const errors = [];
  let scheduleMutated = false;

  for (const [examKey, cfg] of Object.entries(sources)) {
    if (cfg.rolling === true) continue;
    const currentEntry = schedule.exams?.[examKey];
    if (!currentEntry) continue;

    let foundHigh = null;
    let foundMedium = null;

    // Step A: Official URLs
    for (const src of cfg.official_urls || []) {
      try {
        const res = await fetchWithTimeout(src.url, 10000);
        if (!res.ok) {
          errors.push({ examKey, url: src.url, error: `HTTP ${res.status}` });
          continue;
        }
        const text = await extractTextFromResponse(res, src.type);
        const cands = evaluateCandidatesFromText({
          examKey,
          text,
          sourceUrl: src.url,
          sourceType: 'official',
          includePatterns: src.include_patterns || [],
          excludePatterns: src.exclude_patterns || [],
          nowDate,
        });
        if (cands.length > 0) {
          foundHigh = cands[0];
          break;
        }
      } catch (err) {
        errors.push({ examKey, url: src.url, error: err.message || String(err) });
      }
    }

    // Step C: RSS Fallback if no high-confidence match
    if (!foundHigh && cfg.rss_fallback_query) {
      try {
        const res = await fetchWithTimeout(cfg.rss_fallback_query, 10000);
        if (res.ok) {
          const xml = await res.text();
          const items = parseRssItems(xml);
          for (const item of items) {
            const cands = evaluateCandidatesFromText({
              examKey,
              text: item.text,
              sourceUrl: item.link || cfg.rss_fallback_query,
              sourceType: 'rss',
              includePatterns: cfg.official_urls?.[0]?.include_patterns || [],
              excludePatterns: cfg.official_urls?.[0]?.exclude_patterns || [],
              nowDate,
            });
            if (cands.length > 0) {
              foundMedium = cands[0];
              break;
            }
          }
        } else {
          errors.push({ examKey, url: cfg.rss_fallback_query, error: `RSS HTTP ${res.status}` });
        }
      } catch (err) {
        errors.push({ examKey, url: cfg.rss_fallback_query, error: err.message || String(err) });
      }
    }

    if (foundHigh) {
      const dateChanged = currentEntry.official_date !== foundHigh.detectedDate;
      const confirmedUpgraded = currentEntry.is_confirmed !== true;
      if (dateChanged || confirmedUpgraded) {
        autoUpdated.push({
          examKey,
          previousDate: currentEntry.official_date,
          newDate: foundHigh.detectedDate,
          sourceUrl: foundHigh.sourceUrl,
          snippet: foundHigh.snippet,
        });
        currentEntry.official_date = foundHigh.detectedDate;
        currentEntry.is_confirmed = true;
        scheduleMutated = true;
      }
    } else if (foundMedium && foundMedium.detectedDate !== currentEntry.official_date) {
      pendingReview.push(foundMedium);
    }
  }

  if (scheduleMutated) {
    schedule.revision = nextMonotonicRevision(schedule.revision, nowDate);
    schedule.updated_at = nowDate.toISOString();
    if (!dryRun) {
      fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2) + '\n', 'utf8');
    }
  }

  const syncLog = {
    last_run_utc: nowDate.toISOString(),
    revision: schedule.revision,
    auto_updated: autoUpdated,
    pending_review: pendingReview,
    errors,
  };

  if (!dryRun) {
    fs.writeFileSync(SYNC_LOG_PATH, JSON.stringify(syncLog, null, 2) + '\n', 'utf8');
  }

  return { schedule, syncLog, scheduleMutated };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  const { syncLog, scheduleMutated } = await runSync({ dryRun });
  console.log(
    `[OTA Sync${dryRun ? ' DRY-RUN' : ''}] rev=${syncLog.revision} mutated=${scheduleMutated} auto_updated=${syncLog.auto_updated.length} pending_review=${syncLog.pending_review.length} errors=${syncLog.errors.length}`,
  );
  if (syncLog.errors.length > 0) {
    console.log('Errors/Fallbacks:', JSON.stringify(syncLog.errors, null, 2));
  }
}
