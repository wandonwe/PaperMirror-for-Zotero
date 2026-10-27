import {checkExplanationSurface} from './explanationSurface';
import {checkTwoColumnTable} from './twoColumnTable';
import {checkDescriptiveTable} from './descriptiveTable';
import {checkAbbreviationTable} from './abbreviationTable';
import {checkRecommendationTables} from './recommendationTables';
import {checkSplitParagraphExpansion} from './splitParagraphExpansion';
import {checkToolbar} from './toolbar';
import {checkControlAlignment} from './controlAlignment';
import {checkOverlayRotation} from './overlayRotation';

const result=document.createElement('pre');result.id='result';document.body.append(result);
void (async () => {
try {
 checkExplanationSurface();
 checkTwoColumnTable();
 checkDescriptiveTable();
 checkAbbreviationTable();
 checkRecommendationTables();
 checkSplitParagraphExpansion();
 checkToolbar();
 checkControlAlignment();
 await checkOverlayRotation();
 result.textContent='PASS: explanation surfaces, paired tables, descriptive tables, abbreviation tables, recommendation tables, paragraph boundaries, control alignment and overlay rotation';
 result.dataset.pass='true';
} catch(error) { result.textContent=String(error); result.dataset.pass='false'; }
})();
