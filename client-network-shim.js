'use strict';

const fs = require('fs');
const path = require('path');

try {
  const appPath = path.join(__dirname, 'app.js');
  const marker = '/* ViraClip resilient job polling v7 */';
  let app = fs.readFileSync(appPath, 'utf8');
  if (!app.includes(marker)) {
    app += `\n\n${marker}\n
async function __vcJobPoll(jobId){
  let last;
  for(let attempt=1;attempt<=6;attempt++){
    try{return await api('/api/clip-job/'+encodeURIComponent(jobId))}
    catch(e){
      last=e;
      const msg=String(e?.message||e||'');
      if(!/fetch|network|conex|failed|timeout|503|502|504/i.test(msg))throw e;
      const wait=Math.min(12000,1200*Math.pow(1.7,attempt-1));
      progress(Math.max(25,Number(document.querySelector('#progressPct')?.textContent?.replace('%','')||25)),'Reconectando…','A conexão oscilou. Tentativa '+attempt+' de 6 para recuperar o processamento.',3);
      await new Promise(r=>setTimeout(r,wait));
    }
  }
  throw last||new Error('Não foi possível reconectar ao processamento');
}
__vcWaitJob=async function(jobId){
  const started=Date.now();
  for(;;){
    await new Promise(r=>setTimeout(r,2000));
    const j=await __vcJobPoll(jobId);
    const elapsed=Math.floor((Date.now()-started)/1000),min=Math.floor(elapsed/60),sec=String(elapsed%60).padStart(2,'0');
    const pct=Number(j.percent||25);
    progress(pct,j.stage==='transcribing'?'Transcrevendo o vídeo…':j.stage==='selecting'?'Selecionando os melhores momentos…':j.stage==='rendering'?'Renderizando os clipes…':j.stage==='done'?'Clipes prontos!':'Processando…',(j.message||'Processando')+' • '+min+'m '+sec+'s',j.stage==='transcribing'?1:j.stage==='selecting'?2:j.stage==='rendering'?3:j.stage==='done'?4:1);
    if(j.status==='done')return j;
    if(j.status==='failed')throw new Error(j.error||j.message||'Falha no processamento');
    if(elapsed>45*60)throw new Error('O processamento demorou mais que o esperado.');
  }
};
window.__VIRACLIP_NETWORK_RESILIENCE='v7';\n`;
    fs.writeFileSync(appPath, app, 'utf8');
  }
} catch (e) {
  console.warn('ViraClip client network patch was not applied:', e.message);
}
