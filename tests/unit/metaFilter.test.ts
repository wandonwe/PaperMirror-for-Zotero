import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMetadataBlock, isVerticalSliver, type Rect } from '../../src/reader/metaFilter';

// ---- the exact failure cases from the ESC review paper ----------------------

test('the author list that garbled the abstract is filtered', () => {
	assert.equal(isMetadataBlock(
		'Alexios S. Antonopoulos 1,2*, Andreas Angelopoulos1, Konstantinos Tsioufis1, Charalambos Antoniades 2, and Dimitris Tousoulis 1'
	), true);
});

test('affiliation lines are filtered', () => {
	assert.equal(isMetadataBlock(
		'1st Department of Cardiology, Hippokration Hospital, National and Kapodistrian University of Athens, 114 Vas. Sofias Avenue, 11527, Athens, Greece'
	), true);
	assert.equal(isMetadataBlock(
		'2RDM Division of Cardiovascular Medicine, Oxford Academic CT Programme, University of Oxford, John Radcliffe Hospital, Headley Way, OX3 9DU Oxford, UK'
	), true);
});

test('received/accepted dates are filtered', () => {
	assert.equal(isMetadataBlock(
		'Received 19 January 2021; revised 25 March 2021; accepted 7 April 2021; online publish-ahead-of-print 30 April 2021'
	), true);
});

test('correspondence and email lines are filtered', () => {
	assert.equal(isMetadataBlock(
		'* Corresponding author. Tel: +30 6947607442, Email: alexios.antonopoulos@cardiov.ox.ac.uk; antonopoulosal@yahoo.gr'
	), true);
});

test('copyright and licence boilerplate is filtered', () => {
	assert.equal(isMetadataBlock(
		'© The Author(s) 2021. Published by Oxford University Press on behalf of the European Society of Cardiology.'
	), true);
	assert.equal(isMetadataBlock(
		'This is an Open Access article distributed under the terms of the Creative Commons Attribution License (https://creativecommons.org/licenses/by/4.0/), which permits unrestricted reuse, distribution, and reproduction in any medium, provided the original work is properly cited.'
	), true);
});

test('the download watermark is filtered by text and by shape', () => {
	assert.equal(isMetadataBlock(
		'Downloaded from https://academic.oup.com/eurjpc/article/29/4/608/6261148 by guest on 26 March 2026'
	), true);
	// Rotated 90° along the page edge: tall, extremely narrow.
	const sliver: Rect = [598, 300, 610, 640];
	assert.equal(isVerticalSliver(sliver), true);
	assert.equal(isMetadataBlock('any text at all', sliver), true);
});

test('a DOI line is filtered, a paragraph citing a URL is not', () => {
	assert.equal(isMetadataBlock('European Journal of Preventive Cardiology (2022) 29, 608–624 doi:10.1093/eurjpc/zwab067'), true);
	const bodyWithURL = 'The CONFIRM registry data are publicly documented at https://example.org/confirm and have been analysed in several follow-up studies. '
		+ 'In these analyses, the five-year prognostic value of the CT-adapted Leiman score remained significant in patients without obstructive stenosis, and the Leiden group subsequently modified the score by adding the subcategory of mixed plaque.';
	assert.equal(isMetadataBlock(bodyWithURL), false);
});

// ---- content that must NEVER be filtered ------------------------------------

test('body prose survives, even with names, commas and digits', () => {
	assert.equal(isMetadataBlock(
		'In recent large randomized clinical trials, such as the PROMISE (Prospective Multicenter Imaging Study for Evaluation of Chest Pain) and SCOT-HEART (Scottish Computed Tomography of the Heart), the use of CCTA was associated with smaller risks for myocardial infarction compared to conventional management.'
	), false);
});

test('the abstract survives', () => {
	assert.equal(isMetadataBlock(
		'Current cardiovascular risk stratification by use of clinical risk score systems or plasma biomarkers is good but less than satisfactory in identifying patients at residual risk for coronary events.'
	), false);
});

test('headings, keywords and short body fragments survive', () => {
	assert.equal(isMetadataBlock('Introduction'), false);
	assert.equal(isMetadataBlock('Coronary calcification'), false);
	assert.equal(isMetadataBlock('Keywords: Coronary computed tomography angiography, Atherosclerosis, Coronary artery disease'), false);
});

test('a normal paragraph rect is not a vertical sliver', () => {
	assert.equal(isVerticalSliver([54, 500, 292, 560]), false);
});

test('semicolon-style rosters with inline superscripts and degrees are filtered', () => {
	assert.equal(isMetadataBlock(
		'Patrick W. Serruys1*, MD, PhD; Nozomi Kotoku1, MD; Bjarne L. Nørgaard2, MD, PhD; Scot Garg3, MD, PhD; Koen Nieman4, MD, PhD; Marc R. Dweck5, MD, PhD'
	), true);
});

test('orphan affiliation numbers and author notes are filtered', () => {
	assert.equal(isMetadataBlock('18'), true);
	assert.equal(isMetadataBlock('20, 21'), true);
	assert.equal(isMetadataBlock('P.W. Serruys and N. Kotoku contributed equally to this work.'), true);
	assert.equal(isMetadataBlock("The authors' affiliations can be found in the Appendix paragraph."), true);
});

test('a year inside body prose does not make it metadata', () => {
	assert.equal(isMetadataBlock(
		'In 2015 the CONFIRM registry reported that the five-year prognostic value of the score was significant in patients without obstructive stenosis, which changed clinical practice.'
	), false);
});
