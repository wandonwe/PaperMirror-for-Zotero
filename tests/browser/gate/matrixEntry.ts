import {runMatrix} from './matrix';
const result=document.createElement('pre');result.id='result';result.style.display='none';document.body.append(result);
void runMatrix().then(r=>{result.textContent=JSON.stringify(r);result.setAttribute('data-pass','true');},e=>{result.textContent=String(e);result.setAttribute('data-pass','false');});
