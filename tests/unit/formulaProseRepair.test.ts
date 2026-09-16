import test from 'node:test';
import assert from 'node:assert/strict';
import { protectFormulas, stripProtectable, restoreFormulas } from '../../src/reader/formulaGuard';
import { looksTranslated } from '../../src/translation/translationManager';

test('stroke guideline p29 threshold prose cannot be hidden as a formula or accepted as echo',()=>{
 const source='PWI/DWI mismatch: PWI/DWI volume ratio of ≥1.2 and PWI ≥20 mL';
 const masked=protectFormulas(source);
 for(const word of ['mismatch','volume','ratio','and']) assert.ok(masked.text.includes(word));
 assert.ok(stripProtectable(source).includes('mismatch'));
 assert.equal(looksTranslated(source,source,'zh-CN'),false);
 assert.equal(looksTranslated(source,'PWI/DWI不匹配：PWI/DWI体积比≥1.2且PWI≥20 mL','zh-CN'),true);
 assert.equal(restoreFormulas(masked.text,masked.placeholders),source);
});
test('threshold prose remains visible while explicit and symbolic math stays protected',()=>{
 for(const source of ['Patients with stenosis ≥50% require assessment','病变狭窄≥50%需要评估']) assert.equal(protectFormulas(source).text,source);
 for(const source of ['y = βx + ε','$volume ratio ≥ 1$','x ≥ log(y)']) assert.ok(protectFormulas(source).placeholders.length>0,source);
});
