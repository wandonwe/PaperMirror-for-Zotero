import test from 'node:test';
import assert from 'node:assert/strict';
import {ReaderSession} from '../../src/reader/readerSession';
test('explicit source language controls both request and toolbar even when document detection differs',()=>{
 const old=(globalThis as any).Zotero;
 const prefs:Record<string,string>={'bilingualReader.sourceLanguage':'de','bilingualReader.targetLanguage':'ko'};
 (globalThis as any).Zotero={Prefs:{get:(key:string)=>prefs[key]}};
 try {
  const session=Object.create(ReaderSession.prototype) as any;
  const pairs:string[][]=[];session.detectedSource=null;session.pane={setLanguagePair:(...pair:string[])=>pairs.push(pair)};
  const sample='The patients were enrolled in the study and the results of the treatment were compared with the control group.';
  assert.deepEqual(session.resolveLanguages(sample),{source:'de',target:'ko'});
  assert.deepEqual(pairs.at(-1),['Deutsch','한국어']);
  prefs['bilingualReader.sourceLanguage']='auto';
  assert.equal(session.resolveLanguages(sample).source,'en');
  assert.deepEqual(pairs.at(-1),['English','한국어']);
  prefs['bilingualReader.sourceLanguage']='ja';
  assert.equal(session.resolveLanguages(sample).source,'ja');
  assert.deepEqual(pairs.at(-1),['日本語','한국어']);
  prefs['bilingualReader.sourceLanguage']='zh-CN';prefs['bilingualReader.targetLanguage']='auto';
  assert.deepEqual(session.resolveLanguages(sample),{source:'zh-CN',target:'en'});
  assert.deepEqual(pairs.at(-1),['简体中文','English']);
 } finally {(globalThis as any).Zotero=old;}
});
