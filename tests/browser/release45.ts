import {checkExplanationSurface} from './explanationSurface';
import {checkTwoColumnTable} from './twoColumnTable';
import {checkDescriptiveTable} from './descriptiveTable';
import {checkAbbreviationTable} from './abbreviationTable';
import {checkRecommendationTables} from './recommendationTables';
import {checkSplitParagraphExpansion} from './splitParagraphExpansion';

const result=document.createElement('pre');result.id='result';document.body.append(result);
try {
 checkExplanationSurface();
 checkTwoColumnTable();
 checkDescriptiveTable();
 checkAbbreviationTable();
 checkRecommendationTables();
 checkSplitParagraphExpansion();
 result.textContent='PASS: explanation surfaces, paired tables, descriptive tables, abbreviation tables, recommendation tables and paragraph boundaries';
 result.dataset.pass='true';
} catch(error) { result.textContent=String(error); result.dataset.pass='false'; }
