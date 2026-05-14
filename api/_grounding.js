/**
 * 자료 근거(quote) 검증 및 materials 정규화 — grade-answer / exam-grounded-explain 공통
 */

export const GROUNDING_DEFAULT_LIMITS = {
  MAX_ITEMS: 24,
  MAX_TEXT_PER_ITEM: 16000,
  MAX_TOTAL_CHARS: 48000,
};

export function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function quoteMatchesMaterial(quote, materialText) {
  const q = normalizeWhitespace(quote);
  const body = normalizeWhitespace(materialText);
  if (!q || !body || q.length < 4) return false;
  if (body.includes(q)) return true;
  if (q.length > 200) {
    const head = q.slice(0, 120);
    if (body.includes(head)) return true;
  }
  return false;
}

/**
 * @param {unknown[]} materials
 * @param {Partial<typeof GROUNDING_DEFAULT_LIMITS>} limits
 * @returns {{ materialsOut: Array<{id:string,type:string,label:string,text:string}>, idToText: Record<string,string>, totalChars:number, promptLines: string[] }}
 */
export function sanitizeMaterialsForPrompt(materials, limits = {}) {
  const MAX_ITEMS = limits.MAX_ITEMS ?? GROUNDING_DEFAULT_LIMITS.MAX_ITEMS;
  const MAX_TEXT = limits.MAX_TEXT_PER_ITEM ?? GROUNDING_DEFAULT_LIMITS.MAX_TEXT_PER_ITEM;
  const MAX_TOTAL = limits.MAX_TOTAL_CHARS ?? GROUNDING_DEFAULT_LIMITS.MAX_TOTAL_CHARS;

  const materialsOut = [];
  const idToText = {};
  const promptLines = [];
  let totalChars = 0;

  const arr = Array.isArray(materials) ? materials : [];
  for (let i = 0; i < arr.length && materialsOut.length < MAX_ITEMS; i++) {
    const m = arr[i];
    const id = String(m?.id || '').trim();
    const type = String(m?.type || 'note').trim();
    const label = String(m?.label || '').trim();
    const rawText = String(m?.text || '').trim();
    if (!id || !rawText || idToText[id]) continue;
    const slice = rawText.slice(0, MAX_TEXT);
    totalChars += slice.length;
    if (totalChars > MAX_TOTAL) {
      const overflow = totalChars - MAX_TOTAL;
      const adj = slice.length - overflow;
      if (adj < 80) continue;
      const adjusted = slice.slice(0, adj);
      idToText[id] = adjusted;
      materialsOut.push({ id, type, label, text: adjusted });
      promptLines.push(
        `--- 자료 ID: ${id} | 유형: ${type} | 제목: ${label || '(제목 없음)'} ---\n${adjusted}`,
      );
      break;
    }
    idToText[id] = slice;
    materialsOut.push({ id, type, label, text: slice });
    promptLines.push(
      `--- 자료 ID: ${id} | 유형: ${type} | 제목: ${label || '(제목 없음)'} ---\n${slice}`,
    );
  }

  return { materialsOut, idToText, totalChars, promptLines };
}

/**
 * 채점 API용 인용 검증 → { materialId, label, quote }
 */
export function validateGradeCitations(citationsRaw, materialsOut, options = {}) {
  const maxQuote = options.maxQuoteLen ?? 500;
  const byId = new Map(materialsOut.map((m) => [m.id, m]));
  const out = [];

  const rows = Array.isArray(citationsRaw) ? citationsRaw : [];
  for (const c of rows) {
    const materialId = String(c?.materialId || '').trim();
    const quote = String(c?.quote || '').trim();
    const m = byId.get(materialId);
    if (!m || !quoteMatchesMaterial(quote, m.text)) continue;
    const labelFromModel = String(c?.label || '').trim();
    out.push({
      materialId,
      label: labelFromModel || m.label || materialId,
      quote: normalizeWhitespace(quote).slice(0, maxQuote),
    });
  }

  return out;
}

/** 해설 API용 인용 검증 + 부족 시 본문 폐기 */
export function finalizeExplainGrounding(raw, idToText, fallbackReason) {
  const allowedIds = new Set(Object.keys(idToText));
  const citationsIn = Array.isArray(raw?.citations) ? raw.citations : [];
  const citations = [];

  for (const c of citationsIn) {
    const materialId = String(c?.materialId || '').trim();
    const quote = String(c?.quote || '').trim();
    const relevance = String(c?.relevance || '').trim();
    if (!materialId || !allowedIds.has(materialId)) continue;
    if (!quoteMatchesMaterial(quote, idToText[materialId])) continue;
    citations.push({
      materialId,
      quote: quote.slice(0, 400),
      relevance: relevance.slice(0, 500),
    });
  }

  let insufficientData = !!raw?.insufficientData;
  let insufficientReason = String(raw?.insufficientReason || '').trim();
  let verdict = String(raw?.verdict || '').trim();
  let explanation = String(raw?.explanation || '').trim();

  if (citations.length === 0) {
    insufficientData = true;
    verdict = '';
    explanation = '';
    if (!insufficientReason) {
      insufficientReason =
        fallbackReason ||
        '제공된 학습 자료에서 인용 가능한 문장을 찾지 못했습니다. 플래시카드·개요·저장 문제에 관련 내용을 보강한 뒤 다시 시도해 주세요.';
    }
  }

  return {
    insufficientData,
    insufficientReason,
    verdict,
    explanation,
    citations,
  };
}

export function groundingStrengthFromCount(n) {
  if (n <= 0) return 'none';
  if (n === 1) return 'partial';
  return 'full';
}

/** 채점/해설 공통 — 모델이 인용을 시도했는지(빈 배열과 검증 실패 구분) */
export function groundingCitationLooksAttempted(citationsRaw) {
  const rows = Array.isArray(citationsRaw) ? citationsRaw : [];
  return rows.some(
    (c) => String(c?.materialId || '').trim() && String(c?.quote || '').trim(),
  );
}

export function countRawCitationRows(citationsRaw) {
  const rows = Array.isArray(citationsRaw) ? citationsRaw : [];
  return rows.length;
}

/**
 * @param {number} maxScore
 * @param {string} [groundingReason]
 * @param {'no_materials_provided'|'no_relevant_materials_selected'|'model_returned_no_citations'|'quote_validation_failed'} [groundingReasonType]
 */
export function buildInsufficientGradePayload(
  maxScore,
  groundingReason,
  groundingReasonType = 'quote_validation_failed',
) {
  return {
    score: null,
    maxScore: typeof maxScore === 'number' && Number.isFinite(maxScore) ? maxScore : 100,
    verdict: '',
    feedback: '',
    deductions: [],
    citations: [],
    insufficientGrounding: true,
    partialGrounding: false,
    groundingStrength: 'none',
    groundingReasonType,
    groundingReason:
      groundingReason ||
      '저장된 학습 자료에서 채점에 쓸 수 있는 유효 인용을 확인하지 못했습니다.',
    details: { issue: 0, law: 0, logic: 0, conclusion: 0, format: 0 },
    good: '',
    missing: '',
    advice: '',
    next3: [],
  };
}
