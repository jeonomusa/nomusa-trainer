/**
 * POST /api/grade-answer
 *
 * 자료 근거 채점 + materials 키 없을 때 레거시(무자료) 채점 호환.
 * 출력: groundingReasonType, 선택적 legacy_ungrounded
 *
 * 관측: 환경변수 GROUNDING_LOG=1 → stderr JSON 한 줄 (_grounding_log.js)
 */

import {
  sanitizeMaterialsForPrompt,
  validateGradeCitations,
  buildInsufficientGradePayload,
  groundingStrengthFromCount,
  groundingCitationLooksAttempted,
  countRawCitationRows,
  GROUNDING_DEFAULT_LIMITS,
} from "./_grounding.js";
import { logGroundingObservation } from "./_grounding_log.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

function safeInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeCoreScores(result) {
  const details = result && typeof result === "object" ? result.details || {} : {};
  const next3 = result && typeof result === "object" ? result.next3 : [];

  return {
    score: clamp(safeInt(result?.score, 0), 0, 100),
    maxScore: 100,
    details: {
      issue: clamp(safeInt(details.issue, 0), 0, 25),
      law: clamp(safeInt(details.law, 0), 0, 30),
      logic: clamp(safeInt(details.logic, 0), 0, 25),
      conclusion: clamp(safeInt(details.conclusion, 0), 0, 10),
      format: clamp(safeInt(details.format, 0), 0, 10),
    },
    feedback: typeof result?.feedback === "string" ? result.feedback : "",
    good: typeof result?.good === "string" ? result.good : "",
    missing: typeof result?.missing === "string" ? result.missing : "",
    advice: typeof result?.advice === "string" ? result.advice : "",
    next3: Array.isArray(next3)
      ? next3.filter((x) => typeof x === "string").slice(0, 3)
      : [],
  };
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
      const match = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!match) {
        const err = new Error("AI 응답 해석 실패 (JSON not found)");
        err.statusCode = 502;
        throw err;
      }
      return JSON.parse(match[0]);
    } catch (e) {
      lastErr = e;
      if (i === 2) break;
      if (String(e?.statusCode || "").includes("429")) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("Gemini call failed");
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: {
      score: { type: "INTEGER" },
      verdict: { type: "STRING" },
      deductions: { type: "ARRAY", items: { type: "STRING" } },
      details: {
        type: "OBJECT",
        properties: {
          issue: { type: "INTEGER" },
          law: { type: "INTEGER" },
          logic: { type: "INTEGER" },
          conclusion: { type: "INTEGER" },
          format: { type: "INTEGER" },
        },
        required: ["issue", "law", "logic", "conclusion", "format"],
      },
      feedback: { type: "STRING" },
      good: { type: "STRING" },
      missing: { type: "STRING" },
      advice: { type: "STRING" },
      next3: { type: "ARRAY", items: { type: "STRING" } },
      citations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            materialId: { type: "STRING" },
            label: { type: "STRING" },
            quote: { type: "STRING" },
          },
          required: ["materialId", "quote"],
        },
      },
    },
    required: [
      "score",
      "verdict",
      "deductions",
      "details",
      "feedback",
      "good",
      "missing",
      "advice",
      "next3",
      "citations",
    ],
  };
}

function buildSchemaUngrounded() {
  const full = buildSchema();
  full.required = (full.required || []).filter((k) => k !== "citations");
  full.properties.citations = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        materialId: { type: "STRING" },
        label: { type: "STRING" },
        quote: { type: "STRING" },
      },
      required: ["materialId", "quote"],
    },
  };
  return full;
}

function buildPrompt({
  subject,
  question,
  rubric,
  fullAnswer,
  materialsBlock,
}) {
  return `
역할: 노무사 2차 시험 형식의 서술형 답안을 채점한다.

핵심 제약 — 반드시 지킬 것:
1) 아래 [참고 자료 — 학습 근거] 블록 밖의 지식(일반 교과서·추측 상식 등)으로 판단·서술하지 마라.
2) 채점 기준 해석에는 [채점 자료 및 모범답안 참고] 블록(rubric)을 사용한다.
3) 감점·가점 근거나 "왜 부족한지" 설명에는 반드시 [참고 자료]에서 인용 가능한 근거를 찾아 citations에 적는다.
4) 각 citations 항목의 quote는 [참고 자료]에 실제 존재하는 문장을 문자 그대로 짧게 복사해야 한다. 의역·요약 금지.
5) 자료에 없는 근거로 학생에게 감점을 부과했다고 쓰지 마라. 자료에 없으면 그 항목은 deductions에 넣지 말거나, 학습 자료에 근거가 없어 단정 불가임을 피드백에 명시하라.

인용 규칙: materialId는 자료 헤더에 표기된 ID와 정확히 일치해야 한다.

점수:
- 만점 100. 쟁점 25, 법적근거 30, 논리 25, 결론 10, 형식 10 로 details를 채운다.

[과목]
${subject}

[문제]
${question}

[채점 자료 및 모범답안 참고 — 기준 텍스트]
${rubric || "[자료 없음]"}

[학생 답안]
${fullAnswer || "미작성"}

[참고 자료 — 학습 근거 (이 블록 밖 근거로 채점 서술 금지)]
${materialsBlock}

반드시 JSON 객체만 반환하세요.
설명, 마크다운, 코드블록, 인사말은 절대 포함하지 마세요.
`.trim();
}

function buildPromptUngrounded({ subject, question, rubric, fullAnswer }) {
  return `
역할: 노무사 2차 시험 형식의 서술형 답안을 채점한다.

[과목]
${subject}

[문제]
${question}

[채점 자료 및 모범답안 참고 — 기준 텍스트]
${rubric || "[자료 없음]"}

[학생 답안]
${fullAnswer || "미작성"}

점수:
- 만점 100. 쟁점 25, 법적근거 30, 논리 25, 결론 10, 형식 10 로 details를 채운다.

반드시 JSON 객체만 반환하세요.
설명, 마크다운, 코드블록, 인사말은 절대 포함하지 마세요.
`.trim();
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
    const rubric = typeof body?.rubric === "string" ? body.rubric : "";
    const fullAnswer = typeof body?.fullAnswer === "string" ? body.fullAnswer : "";

    if (!subject || !question) {
      return sendJson(res, 400, {
        message: "Missing required fields: subject, question",
      });
    }

    const useMaterialGrounding = Object.prototype.hasOwnProperty.call(
      body || {},
      "materials",
    );

    const logBasis = {
      route: "grade-answer",
      legacyUngrounded: !useMaterialGrounding,
      subject: subject.slice(0, 120),
    };

    if (!useMaterialGrounding) {
      const schema = buildSchemaUngrounded();
      const prompt = buildPromptUngrounded({
        subject,
        question,
        rubric,
        fullAnswer,
      });
      const raw = await callGeminiServer({ prompt, schema });
      const core = normalizeCoreScores(raw);
      const deductions = Array.isArray(raw?.deductions)
        ? raw.deductions.filter((x) => typeof x === "string").slice(0, 10)
        : [];
      logGroundingObservation({
        ...logBasis,
        groundingReasonType: "legacy_ungrounded",
        groundingStrength: "none",
        materialsProvidedCount: null,
        materialsUsableCount: 0,
        rawCitationCount: countRawCitationRows(raw?.citations),
        validCitationCount: 0,
        scoreNull: false,
      });
      return sendJson(res, 200, {
        ...core,
        verdict: String(raw?.verdict || "").trim().slice(0, 800),
        deductions,
        citations: [],
        insufficientGrounding: false,
        partialGrounding: false,
        groundingStrength: "none",
        groundingReason: "",
        groundingReasonType: "legacy_ungrounded",
      });
    }

    const materialsIn = Array.isArray(body?.materials) ? body.materials : [];

    const { materialsOut, promptLines } = sanitizeMaterialsForPrompt(
      materialsIn,
      GROUNDING_DEFAULT_LIMITS,
    );

    if (materialsOut.length === 0) {
      const reasonType =
        materialsIn.length === 0
          ? "no_materials_provided"
          : "no_relevant_materials_selected";
      const msg =
        reasonType === "no_materials_provided"
          ? "제출된 학습 자료 묶음이 비어 있습니다. 플래시카드·개요·저장 문제를 과목별로 준비한 뒤 다시 제출해 주세요."
          : "요청에 포함된 학습 자료 중 채점에 넣을 수 있는 본문이 없습니다. 텍스트가 있는 카드·노트를 선택했는지 확인해 주세요.";
      logGroundingObservation({
        ...logBasis,
        legacyUngrounded: false,
        groundingReasonType: reasonType,
        groundingStrength: "none",
        materialsProvidedCount: materialsIn.length,
        materialsUsableCount: 0,
        rawCitationCount: 0,
        validCitationCount: 0,
        scoreNull: true,
      });
      return sendJson(res, 200, buildInsufficientGradePayload(100, msg, reasonType));
    }

    const materialsBlock = promptLines.join("\n\n");

    const schema = buildSchema();
    const prompt = buildPrompt({
      subject,
      question,
      rubric,
      fullAnswer,
      materialsBlock,
    });

    const raw = await callGeminiServer({ prompt, schema });
    const rawCitCount = countRawCitationRows(raw?.citations);

    const validCitations = validateGradeCitations(
      raw?.citations,
      materialsOut,
      { maxQuoteLen: 500 },
    );

    if (validCitations.length === 0) {
      const reasonType = groundingCitationLooksAttempted(raw?.citations)
        ? "quote_validation_failed"
        : "model_returned_no_citations";
      const msg =
        reasonType === "quote_validation_failed"
          ? '모델이 제안한 채점 인용이 제공 자료 본문과 일치하지 않아 "자료 기반 채점"으로 채택하지 않았습니다. 자료 내용을 보강하거나 다시 제출해 주세요.'
          : "모델이 유효한 학습 자료 인용을 반환하지 않아 점수를 확정하지 않았습니다. 다시 시도하거나 학습 자료를 보강해 주세요.";
      logGroundingObservation({
        ...logBasis,
        legacyUngrounded: false,
        groundingReasonType: reasonType,
        groundingStrength: "none",
        materialsProvidedCount: materialsIn.length,
        materialsUsableCount: materialsOut.length,
        rawCitationCount: rawCitCount,
        validCitationCount: 0,
        scoreNull: true,
      });
      return sendJson(res, 200, buildInsufficientGradePayload(100, msg, reasonType));
    }

    const core = normalizeCoreScores(raw);
    const deductions = Array.isArray(raw?.deductions)
      ? raw.deductions.filter((x) => typeof x === "string").slice(0, 10)
      : [];
    const strength = groundingStrengthFromCount(validCitations.length);
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
      validCitationCount: validCitations.length,
      scoreNull: false,
    });

    const payload = {
      ...core,
      verdict: String(raw?.verdict || "").trim().slice(0, 800),
      deductions,
      citations: validCitations,
      insufficientGrounding: false,
      partialGrounding: strength === "partial",
      groundingStrength: strength,
      groundingReason: "",
      groundingReasonType,
    };

    return sendJson(res, 200, payload);
  } catch (e) {
    const status =
      typeof e?.statusCode === "number"
        ? e.statusCode
        : String(e?.message || "").includes("429")
          ? 429
          : 500;
    const message =
      status === 429
        ? "무료 API 호출 한도를 초과했습니다. 잠시 후 시도해주세요."
        : e?.message || "Server error";
    return sendJson(res, status, { message });
  }
}
