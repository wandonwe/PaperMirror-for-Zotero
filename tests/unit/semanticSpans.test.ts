import {test} from 'node:test';
import assert from 'node:assert/strict';
import gori from '../fixtures/regression/gori-acquisition-p4.spans.json';
import {joinSemanticSpans, type SemanticSpan} from '../../src/reader/semanticSpans';
const span=(text:string,x:number,y:number,width:number,fontSize=10):SemanticSpan=>({text,rect:[x,y,x+width,y+fontSize],fontSize});
const affine=(items:readonly SemanticSpan[],scale:number,dx=0,dy=0)=>items.map(item=>({...item,
 rect:item.rect.map((value,index)=>value*scale+(index%2===0?dx:dy)) as [number,number,number,number],
 fontSize:(item.fontSize ?? item.rect[3]-item.rect[1])*scale}));
const n=()=>span('2',30,104,4,6);

test('real acquisition matrix runs retain their raised square in source text',()=>{
 const xs:SemanticSpan[]=gori.items.map(({rect,...item})=>{
  assert.equal(rect.length,4,'fixture rectangles have four PDF coordinates');
  return {...item,rect:[rect[0]!,rect[1]!,rect[2]!,rect[3]!]};
 });
 const starts=xs.map((item,index)=>item.text.includes('1024') || item.text.includes('768') ? index : -1).filter(index=>index>=0);
 assert.equal(starts.length,2);
 for(const index of starts) {
  const line=xs.slice(index,index+3);
  const text=joinSemanticSpans(line);
  assert.match(text,/(?:1024|768)² matrix/);
  assert.ok(!/(?:10242|7682)\s*matrix/.test(text),text);
  assert.equal(line[1]!.text,'2','materialising source never mutates span identities or glyph text');
  const inventory=(value:string)=>[...value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');
  assert.equal(inventory(text),inventory(line.map(item=>item.text).join('')),'semantic equivalent digits remain in the unchanged inventory boundary');
 }
});

test('raised source digits generalise across numeric values, content, translation, page geometry and font scale',()=>{
 for(const [base,power,word] of [['2048','3','grid'],['512','4','array'],['3072','2','矩阵']]) {
  const xs=[span(base!,0,100,30),{...n(),text:power!},span(word!,37,100,30)];
  const powers:Record<string,string>={'2':'²','3':'³','4':'⁴'};
  const expected=`${base}${powers[power!]} ${word}`;
  for(const scale of [.6,1,1.8]) for(const [dx,dy] of [[0,0],[57,-71]])
   assert.equal(joinSemanticSpans(affine(xs,scale,dx,dy)),expected);
 }
});

test('unit powers, signed multi-run exponents and isotope prefixes preserve the visible script position',()=>{
 assert.equal(joinSemanticSpans([span('cm',0,100,20),span('2',20,104,4,6)]),'cm²');
 assert.equal(joinSemanticSpans([span('mm',0,100,20),span('−',20,104,3,6),span('2',23,104,4,6)]),'mm⁻²');
 assert.equal(joinSemanticSpans([span('10',0,100,20),span('1',20,104,4,6),span('2',24,104,4,6),span('3',28,104,4,6)]),'10¹²³');
 assert.equal(joinSemanticSpans([span('18',0,104,8,6),span('F',9,100,6)]),'¹⁸F');
});

test('ordinary digits and subscripts are not guessed into powers from their value or small font alone',()=>{
 assert.equal(joinSemanticSpans([span('1024',0,100,30),span('2',30,100,4,6)]),'10242');
 assert.equal(joinSemanticSpans([span('value',0,100,30),span('2',30,100,4,10)]),'value2');
 assert.equal(joinSemanticSpans([span('CO',0,100,20),span('2',20,97,4,6)]),'CO2');
 assert.equal(joinSemanticSpans([span('1024',0,100,30),span('2',30,119,4,6)]),'10242','a different line is not a superscript');
 assert.equal(joinSemanticSpans([span('unrelated',0,100,30),span('2',60,104,4,6)]),'unrelated 2','distant text cannot anchor a superscript');
});

test('citation and footnote markers remain references rather than being interpreted as numerical powers',()=>{
 assert.equal(joinSemanticSpans([span('methods',0,100,40),span('12',40,104,8,6)]),'methods¹²','geometric citation digits stay raised');
 assert.equal(joinSemanticSpans([span('methods [12]',0,100,60)]),'methods [12]');
 assert.equal(joinSemanticSpans([span('participants',0,100,60),span('2',60,100,4,6)]),'participants2','unraised small text is not assumed to be a citation or exponent');
 assert.equal(joinSemanticSpans([span('1024² matrix',0,100,70)]),'1024² matrix','existing Unicode superscripts survive unchanged');
});


test('caller spacing options preserve the established prose and table materialisation rules',()=>{
 const touching=[span('A ',0,100,10),span('B',10,100,10)];
 assert.equal(joinSemanticSpans(touching,{fontSize:10,spaceThreshold:.18}),'A B');
 const table={spaceThreshold:.13,trimRuns:true,gapFontSize:'run',joinCJK:false} as const;
 assert.equal(joinSemanticSpans(touching,table),'AB');
 const gap=[span('A',0,100,10,16),span('B',11.5,100,10,8)];
 assert.equal(joinSemanticSpans(gap,{fontSize:16,spaceThreshold:.18}),'AB');
 assert.equal(joinSemanticSpans(gap,table),'A B');
 const cjk=[span('中',0,100,10),span('文',13,100,10)];
 assert.equal(joinSemanticSpans(cjk,{fontSize:10,spaceThreshold:.18}),'中文');
 assert.equal(joinSemanticSpans(cjk,table),'中 文');
});
