import {checkRealTranslations} from './realTranslations';
const result=document.createElement('pre');result.id='result';document.body.append(result);
void checkRealTranslations().then(r=>{result.textContent=JSON.stringify(r);result.setAttribute('data-pass','true');},e=>{result.textContent=String(e);result.setAttribute('data-pass','false');});
