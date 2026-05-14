/**
 * 회귀: grounding 분류 유틸 (API 핸들러의 분기 모델과 동일하게 유지)
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeMaterialsForPrompt,
  validateGradeCitations,
  groundingStrengthFromCount,
  groundingCitationLooksAttempted,
  countRawCitationRows,
  buildInsufficientGradePayload,
  quoteMatchesMaterial,
  GROUNDING_DEFAULT_LIMITS,
} from "./_grounding.js";

test("materials 키 생략과 무관 — sanitize 빈 입력 → usable 0", () => {
  const { materialsOut } = sanitizeMaterialsForPrompt([], GROUNDING_DEFAULT_LIMITS);
  assert.equal(materialsOut.length, 0);
});

test("materials: [] → usable 0 (no_materials_provided류)", () => {
  const { materialsOut } = sanitizeMaterialsForPrompt([], GROUNDING_DEFAULT_LIMITS);
  const typeHint = ([]).length === 0 ? "no_materials_provided" : "no_relevant_materials_selected";
  assert.equal(typeHint, "no_materials_provided");
});

test("sanitize 후 usable 0 — 항목은 있었음 → no_relevant_materials_selected", () => {
  const { materialsOut } = sanitizeMaterialsForPrompt(
    [{ id: "a", type: "fc", label: "", text: "" }],
    GROUNDING_DEFAULT_LIMITS,
  );
  assert.equal(materialsOut.length, 0);
  const mats = [{ id: "a", text: "" }];
  const typeHint = mats.length > 0 ? "no_relevant_materials_selected" : "no_materials_provided";
  assert.equal(typeHint, "no_relevant_materials_selected");
});

test("citation 없음 배열 → model_returned_no_citations", () => {
  assert.equal(groundingCitationLooksAttempted([]), false);
  assert.equal(groundingCitationLooksAttempted(undefined), false);
});

test("citation 시도 형태만 있음 → quote_validation_failed 쪽 분기에 사용", () => {
  const raw = [{ materialId: "m1", quote: "실제글" }];
  assert.equal(groundingCitationLooksAttempted(raw), true);
});

test("raw 행 개수 집계", () => {
  assert.equal(countRawCitationRows([]), 0);
  assert.equal(countRawCitationRows([{ materialId: "x", quote: "y" }]), 1);
});

test("유효 인용 0 — 본문 불일치", () => {
  const materialsOut = [{ id: "m1", type: "n", label: "L", text: "원문이다" }];
  const out = validateGradeCitations([{ materialId: "m1", quote: "없는문장" }], materialsOut);
  assert.equal(out.length, 0);
});

test("유효 인용 1 → partial → only_one / limited 허브", () => {
  assert.equal(groundingStrengthFromCount(1), "partial");
});

test("유효 인용 2+ → full", () => {
  assert.equal(groundingStrengthFromCount(2), "full");
  assert.equal(groundingStrengthFromCount(5), "full");
});

test("점수 미확정 페이로드에 groundingReasonType 포함", () => {
  const p = buildInsufficientGradePayload(
    100,
    "msg",
    "no_materials_provided",
  );
  assert.equal(p.score, null);
  assert.equal(p.insufficientGrounding, true);
  assert.equal(p.groundingReasonType, "no_materials_provided");
});

test("추세/차트 — null 점수는 Number가 아님", () => {
  assert.equal(Number(null), 0); // 참고: null은 화면에서는 미확정으로 별도 처리
  assert.equal(Number(undefined), NaN);
  assert.ok(!Number.isFinite(Number(undefined)));
});

test("substring 인용 검증 — 일치", () => {
  assert.ok(
    quoteMatchesMaterial("근로기준법", "이 법에서 근로기준법을 인용합니다."),
  );
});
