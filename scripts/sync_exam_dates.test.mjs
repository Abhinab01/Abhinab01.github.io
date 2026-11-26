import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCandidatesFromText,
  nextMonotonicRevision,
  parseDatesFromText,
} from './sync_exam_dates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-26T00:00:00Z');

test('Extracts 2026-11-29 from CAT announcement and rejects registration/admit-card dates', () => {
  const sampleCat = `
    IIM CAT 2026 Official Notification:
    Last date to apply: 15 October 2026.
    Admit card: 12 November 2026.
    The Common Admission Test (CAT 2026) examination will be conducted on 29 November 2026 across 3 slots.
  `;
  const cands = evaluateCandidatesFromText({
    examKey: 'CAT',
    text: sampleCat,
    sourceUrl: 'https://iimcat.ac.in/',
    sourceType: 'official',
    includePatterns: ['CAT', 'Common Admission Test'],
    excludePatterns: ['admit card'],
    nowDate: NOW,
  });

  assert.equal(cands.length, 1);
  assert.equal(cands[0].detectedDate, '2026-11-29');
  assert.equal(cands[0].confidence, 'high');
});

test('Extracts 2027-05-24 from UPSC calendar and rejects Mains exam date', () => {
  const sampleUpsc = `
    UPSC Annual Calendar 2027:
    Civil Services (Preliminary) Examination 2027 scheduled on 24 May 2027.
    Last date for submission of application: 10 March 2027.
    Civil Services Mains exam: 20 June 2027.
  `;
  const cands = evaluateCandidatesFromText({
    examKey: 'CSAT',
    text: sampleUpsc,
    sourceUrl: 'https://upsc.gov.in/examinations/exam-calendar',
    sourceType: 'official',
    includePatterns: ['Civil Services (Preliminary)'],
    excludePatterns: ['Mains'],
    nowDate: NOW,
  });

  assert.equal(cands.length, 1);
  assert.equal(cands[0].detectedDate, '2027-05-24');
  assert.equal(cands[0].confidence, 'high');
});

test('Parses multi-day ranges and takes first exam day', () => {
  const dates = parseDatesFromText('IBPS Clerk Prelims scheduled on 14 & 15 March 2027', NOW);
  assert.equal(dates.length, 1);
  assert.equal(dates[0].date, '2027-03-14');
});

test('Monotonic revision bump advances cleanly and rolling exams (GMAT/GRE) are flagged rolling: true', () => {
  const rev1 = nextMonotonicRevision(1, NOW);
  assert.equal(rev1, 2026112601);
  const rev2 = nextMonotonicRevision(2026112601, NOW);
  assert.equal(rev2, 2026112602);

  const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'exam_sources.json'), 'utf8'));
  assert.equal(sources.GMAT.rolling, true);
  assert.equal(sources.GRE.rolling, true);
});
