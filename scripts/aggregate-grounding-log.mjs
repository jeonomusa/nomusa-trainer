#!/usr/bin/env node
/**
 * GROUNDING_LOG stderr 라인 또는 JSONL stdin 집계.
 *
 * 사용:
 *   pnpm grounding:aggregate < grounding-lines.txt
 *   grep '\[grounding\]' prod.log | node scripts/aggregate-grounding-log.mjs
 *   rg '^\[grounding\]' *.log | node scripts/aggregate-grounding-log.mjs
 *
 * 한 줄 형식: [grounding] {"ts":"...","route":"...", ...}
 */

import readline from "node:readline";

function parseRow(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  const i = s.indexOf("{");
  if (i === -1) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}

function bump(map, key) {
  const k = key ?? "(missing)";
  map[k] = (map[k] || 0) + 1;
}

function pct(n, d) {
  if (!d) return "—";
  return `${((100 * n) / d).toFixed(1)}%`;
}

const byReason = Object.create(null);
const byRoute = Object.create(null);
const byStrength = Object.create(null);
const bySubject = Object.create(null);
/** subject 와 reason 교차 — 키 "subject⇥reason" */
const bySubjectReason = Object.create(null);
/** 과목별 reason 건수 — subject → reason → count */
const subjectToReasonCounts = Object.create(null);
/** 과목별 총 로그 행 수 */
const subjectTotals = Object.create(null);
let total = 0;
let skipped = 0;

let legacyTrue = 0;
let legacyFalse = 0;
let groundedRows = 0;

let scoreNullTrue = 0;
let scoreNullFalse = 0;
let scoreNullUnset = 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const row = parseRow(line);
  if (!row) {
    skipped++;
    continue;
  }
  total++;

  bump(byRoute, row.route);
  bump(byReason, row.groundingReasonType);
  bump(byStrength, row.groundingStrength);

  const sub = String(row.subject || "").trim() || "(no subject)";
  bump(bySubject, sub);
  bump(subjectTotals, sub);
  const rKey = row.groundingReasonType ?? "(missing)";
  bump(bySubjectReason, `${sub}\t${rKey}`);
  if (!subjectToReasonCounts[sub]) subjectToReasonCounts[sub] = Object.create(null);
  bump(subjectToReasonCounts[sub], rKey);

  if (row.legacyUngrounded === true) legacyTrue++;
  else legacyFalse++;

  const isLegacy =
    row.legacyUngrounded === true || row.groundingReasonType === "legacy_ungrounded";
  if (!isLegacy) groundedRows++;

  if (row.scoreNull === true) scoreNullTrue++;
  else if (row.scoreNull === false) scoreNullFalse++;
  else scoreNullUnset++;

  if (typeof row.subject === "undefined" && row.route === "exam-grounded-explain") {
    /* 구버전 로그 호환 — 집계는 (no subject)로 이미 포함됨 */
  }
}

function printSorted(title, obj, denom = total) {
  console.log(`\n## ${title}`);
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    console.log("  (없음)");
    return;
  }
  const max = rows[0][1];
  for (const [k, v] of rows) {
    const bar = "█".repeat(Math.ceil((v / max) * 20));
    console.log(`  ${String(v).padStart(5)}  ${pct(v, denom).padStart(7)}  ${bar}  ${k}`);
  }
}

/** 과목별: 상위 reason + 해당 과목 내 비율 (절대 걉수 많은 과목부터) */
function printSubjectReasonShares(topSubjects = 15, reasonsPerSubject = 5) {
  console.log("\n## subject 내부 reason 비율 (해당 과목 로그 행 대비 %)");

  const subs = Object.entries(subjectTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topSubjects);

  if (subs.length === 0) {
    console.log("  (없음)");
    return;
  }

  for (const [sub, nSub] of subs) {
    const reasons = subjectToReasonCounts[sub] || {};
    const top = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, reasonsPerSubject);
    if (top.length === 0) continue;
    console.log(`\n  ▶ ${sub}  (과목 내 ${nSub}건)`);
    const max = top[0][1];
    for (const [reason, cnt] of top) {
      const bar = "░".repeat(Math.ceil((cnt / max) * 12));
      console.log(
        `      ${String(cnt).padStart(4)}  ${pct(cnt, nSub).padStart(7)}  ${bar}  ${reason}`,
      );
    }
  }
}

console.log("=== Grounding log 요약 ===");
console.log(`총 파싱 성공: ${total}건  (무시 줄: ${skipped})`);

if (total === 0) {
  console.error(
    "\n입력 없음 또는 파싱 실패. 한 줄 예:\n  [grounding] {\"route\":\"grade-answer\",\"groundingReasonType\":\"legacy_ungrounded\",...}\n",
  );
  process.exit(total === 0 && skipped === 0 ? 0 : 1);
}

console.log("\n## 코호트");
console.log(
  `  legacyUngrounded true:  ${legacyTrue} (${pct(legacyTrue, total)})`,
);
console.log(
  `  legacyUngrounded false: ${legacyFalse} (${pct(legacyFalse, total)})`,
);
console.log(
  `  grounded 추정 행 (legacy_ungrounded·legacyUngrounded 제외 합계): ${groundedRows} (${pct(groundedRows, total)})`,
);

console.log("\n## scoreNull (채점 경로 중심, explain은 대부분 null)");
console.log(`  true:      ${scoreNullTrue} (${pct(scoreNullTrue, total)})`);
console.log(`  false:     ${scoreNullFalse} (${pct(scoreNullFalse, total)})`);
console.log(`  unset/null:${scoreNullUnset} (${pct(scoreNullUnset, total)})`);

printSorted("route", byRoute);
printSorted("groundingReasonType", byReason);
printSorted("groundingStrength", byStrength);
printSorted("subject (상위 과목)", bySubject);
printSorted("subject + reasonType (TAB 구분 첫 필드만 과목)", bySubjectReason);
printSubjectReasonShares();
