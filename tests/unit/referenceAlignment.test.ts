import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/lee2020-reference-mismatch.json';
import {referenceAlignmentIssue} from '../../src/translation/referenceAlignment';
import {looksTranslated,translationRejectReason} from '../../src/translation/translationManager';
test('Lee p7 detects three source/translation reference substitutions from actual responses',()=>{
 for(const f of fixture.filter(f=>!f.id.endsWith('-22'))) {
  assert.ok(referenceAlignmentIssue(f.source,f.translation),f.id);
  for(const lang of ['zh-CN','en','ko']) assert.equal(looksTranslated(f.source,f.translation,lang),false);
  assert.match(translationRejectReason(f.source,f.translation,'zh-CN')!,/^reference-/);
 }
});
test('reference numbering and retained Latin author must match without blocking localized authors or numbered prose',()=>{
 assert.equal(referenceAlignmentIssue('8. Katsuragawa M, et al. Histologic studies','8. Katsuragawa M, 等。组织学研究'),null);
 assert.equal(referenceAlignmentIssue('8. Katsuragawa M, et al. Histologic studies','8. Opolski MP, 等。研究'),'reference-author-mismatch');
 assert.equal(referenceAlignmentIssue('8. Katsuragawa M, et al. Histologic studies','8. 葛川等。组织学研究'),null);
 assert.equal(referenceAlignmentIssue('1. Patients should return after treatment.','1. 患者应在治疗后复诊。'),null);
 assert.equal(referenceAlignmentIssue('0.5 mL per minute','0.5 mL每分钟'),null);
});
