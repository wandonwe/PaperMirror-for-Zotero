import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber } from 'pdf-lib';
/** Glyph-name evidence is required: the same byte means different mathematical symbols. */
const glyphs: Record<string, Record<string,string>> = {
 'MathematicalPi-One': {H11350:'≥', H9262:'µ', H11349:'≤'},
 'Universal-GreekwithMathPi': {H11006:'±', H11021:'<', H11005:'=', H11002:'−', H11022:'>', H11001:'+'},
 'MathematicalPi-Four': {H11549:'='},
 'MathematicalPi-Three': {H20648:'‖'}
};
export function decodeLegacyText(text:string,name:string,differences:Record<number,string>):string {
 const known=glyphs[name.replace(/^[A-Z]{6}\+/, '')];
 if(!known) return text;
 return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,c=>known[differences[c.charCodeAt(0)] ?? ''] ?? c);
}
const documents=new WeakMap<object,Promise<PDFDocument>>();
/** Keep parsing and its result in the privileged realm. A content Promise's
 * .then() result must not transport a privileged PDFDocument across Xray. */
function parsedDocument(doc:object & {getData?:()=>Promise<Uint8Array>}):Promise<PDFDocument> {
 let pending=documents.get(doc);
 if(!pending) {
  const bytes=new Promise<Uint8Array>((resolve,reject)=>{
   try {doc.getData!().then(data=>{try{resolve(new Uint8Array(data));}catch(e){reject(e);}},reject);}
   catch(e){reject(e);}
  });
  pending=bytes.then(data=>PDFDocument.load(data,{ignoreEncryption:true}));
  documents.set(doc,pending);
 }
 return pending;
}
export async function legacyFontEncodings(doc:object & {getData?:()=>Promise<Uint8Array>},pageIndex:number):Promise<Map<string,Record<number,string>>> {
 const result=new Map<string,Record<number,string>>();
 if(!doc.getData) return result;
 const pending=parsedDocument(doc);
 const pdf=await pending, page=pdf.getPage(pageIndex), fonts=page.node.Resources()?.lookup(PDFName.of('Font'));
 if(!(fonts instanceof PDFDict)) return result;
 for(const [,ref] of fonts.entries()) {
  const font=pdf.context.lookup(ref);if(!(font instanceof PDFDict))continue;
  const name=font.lookup(PDFName.of('BaseFont')), encoding=font.lookup(PDFName.of('Encoding'));
  if(!(name instanceof PDFName)||!(encoding instanceof PDFDict))continue;
  const list=encoding.lookup(PDFName.of('Differences'));if(!(list instanceof PDFArray))continue;
  const map:Record<number,string>={};let code=-1;
  for(let n=0;n<list.size();n++){const value=list.lookup(n);if(value instanceof PDFNumber)code=value.asNumber();else if(value instanceof PDFName&&code>=0)map[code++]=value.decodeText();}
  result.set(name.decodeText(),map);
 }
 return result;
}

/** Operator lists can finish before the browser's FontFace binding resolves.
 * PDFObjects.get(id) throws at that point; its callback API is the readiness
 * signal. Only control-bearing fonts need this bounded wait. */
export async function resolvedPdfFont(objects:{get:(id:string,callback?:(font:unknown)=>void)=>unknown}|undefined,id:string):Promise<unknown> {
 if(!objects)return undefined;
 try {const ready=objects.get(id);if(ready)return ready;} catch { /* still binding */ }
 return new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(undefined),2000);
  try {objects.get(id,font=>{clearTimeout(timer);resolve(font);});}
  catch {clearTimeout(timer);resolve(undefined);}
 });
}

const repeatedImages=new WeakMap<object,Promise<Set<string>>>();
/** Reused image resources are evidence of page decoration, not proof by themselves. */
export function repeatedImageRefs(doc:object & {getData?:()=>Promise<Uint8Array>}):Promise<Set<string>> {
 let result=repeatedImages.get(doc);
 if(!result){result=scanRepeatedImageRefs(doc);repeatedImages.set(doc,result);}
 return result;
}
async function scanRepeatedImageRefs(doc:object & {getData?:()=>Promise<Uint8Array>}):Promise<Set<string>> {
 if(!doc.getData)return new Set();
 const pending=parsedDocument(doc);
 const pdf=await pending,counts=new Map<string,number>();
 for(const page of pdf.getPages()) {
  const objects=page.node.Resources()?.lookup(PDFName.of('XObject'));if(!(objects instanceof PDFDict))continue;
  const seen=new Set<string>();
  for(const [,ref]of objects.entries()) {
   const value=pdf.context.lookup(ref) as {dict?:PDFDict}|undefined;
   if(value?.dict?.lookup(PDFName.of('Subtype'))?.toString()!=='/Image')continue;
   seen.add(ref.toString().replace(/ (\d+) R$/,(_,g)=>g==='0'?'R':`R${g}`).replace(/ /g,''));
  }
  for(const ref of seen)counts.set(ref,(counts.get(ref)??0)+1);
 }
 return new Set([...counts].filter(([,n])=>n>=3).map(([id])=>id));
}
