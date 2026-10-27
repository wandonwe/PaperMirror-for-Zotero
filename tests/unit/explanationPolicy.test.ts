import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderSession} from '../../src/reader/readerSession';
import {getProvider} from '../../src/translation/providers/registry';

function environment() {
 const values = new Map<string, unknown>([
  ['bilingualReader.privacyNoticeAccepted', true], ['bilingualReader.localOnlyMode', true],
  ['bilingualReader.autoExplainSelection', true]
 ]);
 const observers = new Map<string, (value: unknown) => void>();
 const previous = (globalThis as any).Zotero;
 (globalThis as any).Zotero = {Prefs: {
  get: (key: string) => values.get(key),
  registerObserver: (key: string, fn: (value: unknown) => void) => {observers.set(key, fn);return key;},
  unregisterObserver: (key: string) => observers.delete(key)
 }};
 const setLocal = (on: boolean) => {values.set('bilingualReader.localOnlyMode', on);observers.get('bilingualReader.localOnlyMode')?.(on);};
 return {setLocal, restore() {if(previous === undefined) delete (globalThis as any).Zotero;else (globalThis as any).Zotero=previous;}};
}

function session(base: string) {
 const doc = new EventTarget();
 const native = {nodeType: 1, closest: () => ({})};
 Object.assign(doc, {defaultView: {getSelection: () => ({isCollapsed: false, anchorNode: native, focusNode: native, toString: () => 'Private source passage.'})}});
 const shown: {loading?: boolean;error?: string;sections?: unknown[]}[] = [];
 let hidden = 0;
 const reader = {_internalReader: {_state: {primaryViewState: {pageIndex: 0}},_primaryView: {_iframeWindow: {document: doc}}}};
 const instance = Object.assign(Object.create(ReaderSession.prototype), {
  reader,destroyed:false,viewMode:'overlay',explainCache:new Map(),
  pane:{getSelectedBlockId:()=>null,showExplanation:(value: any)=>shown.push(value),hideExplanation:()=>{hidden++;},setExplanationDismissDocument(){}},
  providerSettings:async()=>({providerId:'openai-compatible',apiBaseURL:base,apiKey:'local-test-key',model:'test',timeoutMs:1000}),
  resolveLanguages:()=>({target:'zh'}),isWindowHidden:()=>false
 });
 return {instance,shown,hidden:()=>hidden,cleanup() {
  instance.explanationRequest?.abort();instance.disposeAutoExplain?.();instance.disposeOriginalDoubleClick?.();
  if(instance.localOnlyPrefObserver)(globalThis as any).Zotero.Prefs.unregisterObserver(instance.localOnlyPrefObserver);
  if(instance.autoExplainPrefObserver)(globalThis as any).Zotero.Prefs.unregisterObserver(instance.autoExplainPrefObserver);
 }};
}

test('local-only policy prevents cloud requests from both manual and automatic explanations', async () => {
 const env=environment(), provider=getProvider('openai-compatible'), original=provider.complete;
 let dispatched=0;
 provider.complete=async()=>{dispatched++;return '整体翻译 — 不应发送';};
 try {
  for(const automatic of [false,true]) {
   const f=session('https://api.example.com/v1');
   await f.instance.explainSelection('Private source passage.',automatic);
   assert.equal(dispatched,0);
   if(automatic)assert.deepEqual(f.shown,[],'blocked automatic selection stays quiet');
   else assert.match(f.shown[0]!.error!,/Local-only mode/);
   f.cleanup();
  }
 } finally {provider.complete=original;env.restore();}
});

test('local-only explanations allow explicitly configured localhost endpoints', async () => {
 const env=environment(), provider=getProvider('openai-compatible'), original=provider.complete;
 let dispatched=0;
 provider.complete=async()=>{dispatched++;return '整体翻译 — 本地解析';};
 try {
  for(const base of ['http://localhost:11434/v1','http://127.0.0.1:11434/v1','http://[::1]:11434/v1']) {
   const f=session(base);await f.instance.explainSelection('Private source passage.');
   assert.equal(f.shown.at(-1)!.sections?.length,1);f.cleanup();
  }
  assert.equal(dispatched,3);
  // A localhost-looking external hostname must not pass the same boundary.
  const bad=session('https://localhost.example.com/v1');await bad.instance.explainSelection('Private source passage.');
  assert.equal(dispatched,3);bad.cleanup();
 } finally {provider.complete=original;env.restore();}
});

test('enabling local-only mode cancels an in-flight cloud explanation and rejects its late result', async () => {
 const env=environment(),provider=getProvider('openai-compatible'),original=provider.complete;
 env.setLocal(false);
 let done!:(text:string)=>void,started!:()=>void,signal:AbortSignal|undefined;
 const beginning=new Promise<void>(resolve=>{started=resolve;});
 const result=new Promise<string>(resolve=>{done=resolve;});
 provider.complete=async(_prompt,_settings,options)=>{signal=options?.signal;started();return result;};
 const f=session('https://api.example.com/v1');
 try {
  f.instance.watchAutomaticExplanation();
  const pending=f.instance.explainSelection('Private source passage.');await beginning;
  assert.equal(f.shown.length,1);
  env.setLocal(true);assert.equal(signal?.aborted,true);assert.equal(f.hidden(),1);
  done('整体翻译 — 过期云端结果');await pending;
  assert.equal(f.shown.length,1,'policy change cannot redraw the card');
 } finally {f.cleanup();provider.complete=original;env.restore();}
});

test('policy is rechecked after asynchronous settings resolve, before any cloud dispatch', async () => {
 const env=environment(),provider=getProvider('openai-compatible'),original=provider.complete;
 env.setLocal(false);
 let dispatched=0,resolveSettings!:(value:unknown)=>void;
 provider.complete=async()=>{dispatched++;return '整体翻译 — 不应发送';};
 const f=session('https://api.example.com/v1');
 f.instance.providerSettings=()=>new Promise(resolve=>{resolveSettings=resolve;});
 try {
  const pending=f.instance.explainSelection('Private source passage.');
  env.setLocal(true);
  resolveSettings({providerId:'openai-compatible',apiBaseURL:'https://api.example.com/v1',apiKey:'test',model:'test',timeoutMs:1000});
  await pending;assert.equal(dispatched,0);
  assert.match(f.shown[0]!.error!,/Local-only mode/);
 } finally {f.cleanup();provider.complete=original;env.restore();}
});
