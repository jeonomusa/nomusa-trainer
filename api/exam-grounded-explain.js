/**
 * POST /api/exam-grounded-explain
 *
 * 채점 API와 동일한 groundingReasonType / groundingStrength 체계.
 * body에 materials 키 없음 → legacy_ungrounded (모델 미호출, 자료 근거 해설 생략).
 *
 * 관측: GROUNDING_LOG=1
 */

import {
  sanitizeMaterialsForPrompt,
  finalizeExplainGrounding,
  groundingStrengthFromCount,
  groundingCitationLooksAttempted,
  countRawCitationRows,
  GROUNDING_DEFAULT_LIMITS,
} from "./_grounding.js";
import { logGroundingObservation } from "./_grounding_log.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_QUESTION = 12000;
const MAX_USER_ANSWER = 24000;
const MAX_RUBRIC_EXCERPT = 16000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: {
      insufficientData: { type: "BOOLEAN" },
      insufficientReason: { type: "STRING" },
      verdict: { type: "STRING" },
      explanation: { type: "STRING" },
      citations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            materialId: { type: "STRING" },
            quote: { type: "STRING" },
            relevance: { type: "STRING" },
          },
          required: ["materialId", "quote", "relevance"],
        },
      },
    },
    required: [
      "insufficientData",
      "insufficientReason",
      "verdict",
      "explanation",
      "citations",
    ],
  };
}

function buildPrompt({
  subject,
  question,
  userAnswer,
  rubricExcerpt,
  materialsBlock,
}) {
  return `
역할: 너는 "내 자료 기반 학습 코치"이다. 제공된 학습 자료와 시험에 첨부된 텍스트(문제·답안·아래 채점 발췌)만 사용한다.
인터넷 검색·일반 상식 보강·자료에 없는 법률 내용 추가는 절대 하지 마라.

시험 유형: 서술형(노무사 2차 스타일). 객관식이 아닐 수 있다. "정답 선택지"가 없을 수 있다.
이 경우 판정(verdict)은 "자료와의 정합성/누락" 중심으로 짧게 쓴다. (예: 자료에 있는 쟁점·조문을 답안이 얼마나 반영했는지)

규칙:
1) 아래 [참고 자료]에 없는 사실·조문·판례·출처는 쓰지 마라.
2) 설명은 반드시 인용(citations)으로 뒷받침할 수 있어야 한다. 인용문(quote)은 해당 자료 본문에 실제로 존재하는 연속된 문구를 짧게 복사한다(의역 금지).
3) 자료만으로 답안의 정오를 확정하거나 채점 점수를 단정할 수 없으면 insufficientData=true 로 두고, verdict·explanation은 완화된 문장으로만 쓰거나 비운다.
4) 자료가 빈약하거나 인용할 문장이 없으면 insufficientData=true, insufficientReason에 이유를 한국어로 명시한다.
5) JSON만 반환한다. 마크다운·코드펜스·인사말 금지.

출력 필드:
- insufficientData: 인용 가능한 근거가 부족하면 true
- insufficientReason: 부족 시 이유 (한국어)
- verdict: 1~3문장, 자료 기준 판단 요약
- explanation: 3~8문장, 자료에 근거한 해설(인용과 모순 없게)
- citations: { materialId, quote, relevance } 배열. materialId는 아래 자료 블록의 ID와 정확히 일치.

[과목]
${subject}

[문제]
${question}

[학생 답안]
${userAnswer}

[채점 자료 발췌(있을 때만; 없으면 “없음”)]
${rubricExcerpt || "없음"}

[참고 자료 — 이 블록 밖 지식 사용 금지]
${materialsBlock}
`.trim();
}

async function callGeminiServer({ prompt, schema }) {
  if (!GEMINI_API_KEY) {
    const err = new Error("Server misconfigured: GEMINI_API_KEY is missing.");
    err.statusCode = 500;
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    DEFAULT_MODEL,
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  let lastErr;
  for (let i = 0; i <= 2; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        const err = new Error(text || `Gemini HTTP ${r.status}`);
        err.statusCode = r.status === 429 ? 429 : 502;
        throw err;
      }

      const data = await r.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const clean = String(rawText)
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) {
        const err = new Error("AI 응답 해석 실패 (JSON not found)");
        err.statusCode = 502;
        throw err;
      }
      return JSON.parse(match[0]);
    } catch (e) {
      lastErr = e;
      if (i === 2) break;
      if (Number(e?.statusCode) === 429) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("Gemini call failed");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { message: "Method Not Allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const subject = String(body?.subject || "").trim();
    const question = String(body?.question || "").trim();
    const userAnswer = String(body?.userAnswer || "").trim();
    const rubricExcerpt = String(body?.rubricExcerpt || "").trim();
    if (!subject || !question) {
      return sendJson(res, 400, {
        message: "Missing required fields: subject, question",
      });
    }

    if (question.length > MAX_QUESTION || userAnswer.length > MAX_USER_ANSWER) {
      return sendJson(res, 400, { message: "Input too long" });
    }
    if (rubricExcerpt.length > MAX_RUBRIC_EXCERPT) {
      return sendJson(res, 400, { message: "Rubric excerpt too long" });
    }

    const logBasis = {
      route: "exam-grounded-explain",
      subject: subject.slice(0, 120),
    };

    const useMaterialGrounding = Object.prototype.hasOwnProperty.call(
      body || {},
      "materials",
    );

    if (!useMaterialGrounding) {
      logGroundingObservation({
        ...logBasis,
        legacyUngrounded: true,
        groundingReasonType: "legacy_ungrounded",
        groundingStrength: "none",
        materialsProvidedCount: null,
        materialsUsableCount: 0,
        rawCitationCount: 0,
        validCitationCount: 0,
        scoreNull: null,
      });
      return sendJson(res, 200, {
        insufficientData: true,
        insufficientReason:
          "학습 자료(materials)가 함께 전달되지 않아 자료 기반 해설을 제공하지 않습니다. 플래시카드 등을 보내면 자료 근거 해설을 쓸 수 있습니다.",
        verdict: "",
        explanation: "",
        citations: [],
        groundingStrength: "none",
        groundingReasonType: "legacy_ungrounded",
      });
    }

    const materialsIn = Array.isArray(body?.materials) ? body.materials : [];

    const { materialsOut, idToText, promptLines } =
      sanitizeMaterialsForPrompt(materialsIn, GROUNDING_DEFAULT_LIMITS);

    if (materialsOut.length === 0) {
      const reasonType =
        materialsIn.length === 0
          ? "no_materials_provided"
          : "no_relevant_materials_selected";
      const insufficientReason =
        reasonType === "no_materials_provided"
          ? "선택된 학습 자료가 없습니다. 플래시카드·개요를 쌓은 뒤 다시 시도해 주세요."
          : "보낸 자료 중 본문이 있는 학습 카드가 없습니다. 저장된 카드를 확인해 주세요.";
      logGroundingObservation({
        ...logBasis,
        legacyUngrounded: false,
        groundingReasonType: reasonType,
        groundingStrength: "none",
        materialsProvidedCount: materialsIn.length,
        materialsUsableCount: 0,
        rawCitationCount: 0,
        validCitationCount: 0,
        scoreNull: null,
      });
      return sendJson(res, 200, {
        insufficientData: true,
        insufficientReason,
        verdict: "",
        explanation: "",
        citations: [],
        groundingStrength: "none",
        groundingReasonType: reasonType,
      });
    }

    const materialsBlock = promptLines.join("\n\n");
    const schema = buildSchema();
    const prompt = buildPrompt({
      subject,
      question,
      userAnswer: userAnswer || "(미작성)",
      rubricExcerpt: rubricExcerpt || "",
      materialsBlock,
    });

    const raw = await callGeminiServer({ prompt, schema });
    const rawCitCount = countRawCitationRows(raw?.citations);

    const normalized = finalizeExplainGrounding(raw, idToText, null);
    const validCount = normalized.citations.length;

    if (validCount === 0) {
      const reasonType = groundingCitationLooksAttempted(raw?.citations)
        ? "quote_validation_failed"
        : "model_returned_no_citations";
      const insufficientReason =
        reasonType === "quote_validation_failed"
          ? "모델이 제안한 인용문이 자료 본문과 일치하지 않습니다. 카드 내용을 정리하고 다시 시도해 주세요."
          : "모델이 유효한 인용을 반환하지 않았습니다. 잠시 후 다시 시도하거나 학습 자료를 보강해 주세요.";

      logGroundingObservation({
        ...logBasis,
        legacyUngrounded: false,
        groundingReasonType: reasonType,
        groundingStrength: "none",
        materialsProvidedCount: materialsIn.length,
        materialsUsableCount: materialsOut.length,
        rawCitationCount: rawCitCount,
        validCitationCount: 0,
        scoreNull: null,
      });

      return sendJson(res, 200, {
        insufficientData: true,
        insufficientReason,
        verdict: "",
        explanation: "",
        citations: [],
        groundingStrength: "none",
        groundingReasonType: reasonType,
      });
    }

    const strength = groundingStrengthFromCount(validCount);
    const groundingReasonType =
      strength === "full"
        ? "sufficient_valid_citations"
        : materialsOut.length <= 2
          ? "limited_material_coverage"
          : "only_one_valid_citation";

    logGroundingObservation({
      ...logBasis,
      legacyUngrounded: false,
      groundingReasonType,
      groundingStrength: strength,
      materialsProvidedCount: materialsIn.length,
      materialsUsableCount: materialsOut.length,
      rawCitationCount: rawCitCount,
      validCitationCount: validCount,
      scoreNull: null,
    });

    return sendJson(res, 200, {
      ...normalized,
      insufficientData: false,
      groundingStrength: strength,
      groundingReasonType,
    });
  } catch (e) {
    const status =
      typeof e?.statusCode === "number"
        ? e?.statusCode
        : String(e?.message || "").includes("429")
          ? 429
          : 500;
    const message =
      status === 429
        ? "무료 API 호출 한도를 초과했습니다. 잠시 후 시도해주세요."
        : status >= 500
          ? "서버 처리 중 오류가 발생했습니다."
          : e?.message || "요청 처리 실패";
    return sendJson(res, status, { message });
  }
}
