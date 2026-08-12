'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
const JOB_DIR = process.env.JOB_DIR || path.join(DATA_DIR,'jobs');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR,'viraclip-v7.sqlite');
fs.mkdirSync(JOB_DIR,{recursive:true});
const db = new DatabaseSync(DB_PATH);

const now=()=>new Date().toISOString();
function sendJson(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body)}
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}))}
function readJson(req,limit=128*1024){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(Buffer.byteLength(s)>limit)reject(new Error('Payload grande demais'))});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error('JSON inválido'))}});req.on('error',reject)})}
function auth(req){const sid=parseCookies(req).viraclip_session;if(!sid)return null;const session=db.prepare('SELECT user_id FROM sessions WHERE id=? AND expires_at>?').get(sid,now());if(!session)return null;let workspaceId=String(req.headers['x-workspace-id']||'');let ok=workspaceId&&db.prepare('SELECT 1 x FROM memberships WHERE user_id=? AND workspace_id=?').get(session.user_id,workspaceId);if(!ok){const row=db.prepare('SELECT workspace_id FROM memberships WHERE user_id=? LIMIT 1').get(session.user_id);workspaceId=row?.workspace_id||''}return workspaceId?{userId:session.user_id,workspaceId}:null}
function jobFile(id){return path.join(JOB_DIR,`${id}.json`)}
function inputFile(id){return path.join(JOB_DIR,`${id}.input.json`)}
function markWorkerExit(id,code,signal){
  const file=jobFile(id);if(!fs.existsSync(file))return;
  try{
    const j=JSON.parse(fs.readFileSync(file,'utf8'));
    if(j.status==='done'||j.status==='failed')return;
    const next={...j,status:'failed',stage:'failed',percent:Number(j.percent||0),message:`Worker de vídeo encerrou inesperadamente${signal?` (${signal})`:''}.`,error:`O processo de renderização terminou antes de concluir${code!==null?` (código ${code})`:''}${signal?` — sinal ${signal}`:''}.`,finishedAt:now(),updatedAt:now()};
    const tmp=`${file}.tmp`;fs.writeFileSync(tmp,JSON.stringify(next),'utf8');fs.renameSync(tmp,file);
  }catch(e){console.warn('Worker exit state:',e.message)}
}
function startWorker(id){
  const env={...process.env,NODE_OPTIONS:''};
  const child=spawn(process.execPath,[path.join(__dirname,'clip-worker-v2.js'),id],{cwd:__dirname,env,detached:false,stdio:['ignore','inherit','inherit']});
  child.on('error',()=>markWorkerExit(id,null,'spawn-error'));
  child.on('exit',(code,signal)=>{if(code!==0||signal)markWorkerExit(id,code,signal)});
}

async function handle(req,res){
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/clip-job'&&req.method==='POST'){
    const who=auth(req);if(!who){sendJson(res,401,{error:'Faça login novamente'});return true}
    try{
      const b=await readJson(req),jobId=`job_${crypto.randomBytes(10).toString('hex')}`;
      if(!b.sourceId){sendJson(res,400,{error:'Vídeo não encontrado'});return true}
      const input={...b,workspaceId:who.workspaceId,count:Math.max(1,Math.min(5,Number(b.count||3))),createdAt:now()};
      fs.writeFileSync(inputFile(jobId),JSON.stringify(input),'utf8');
      fs.writeFileSync(jobFile(jobId),JSON.stringify({jobId,status:'queued',stage:'queued',percent:25,message:'Processamento na fila',createdAt:now(),updatedAt:now()}),'utf8');
      startWorker(jobId);
      sendJson(res,202,{jobId,status:'queued'});return true;
    }catch(e){sendJson(res,500,{error:e.message||'Falha ao iniciar processamento'});return true}
  }
  if(pathname.startsWith('/api/clip-job/')&&req.method==='GET'){
    const who=auth(req);if(!who){sendJson(res,401,{error:'Faça login novamente'});return true}
    const id=path.basename(pathname),file=jobFile(id);
    if(!fs.existsSync(file)){sendJson(res,404,{error:'Processamento não encontrado'});return true}
    try{const j=JSON.parse(fs.readFileSync(file,'utf8'));sendJson(res,200,j)}catch{sendJson(res,500,{error:'Estado do processamento inválido'})}
    return true;
  }
  return false;
}

const previousCreateServer=http.createServer;
http.createServer=function viraClipJobServer(listener){const wrapped=async(req,res)=>{if(await handle(req,res))return;return listener(req,res)};return previousCreateServer.call(this,wrapped)};

try{
  const appPath=path.join(__dirname,'app.js'),marker='/* ViraClip async clip jobs v6 */';let app=fs.readFileSync(appPath,'utf8');
  if(!app.includes(marker)){
    app+=`\n\n${marker}\n
async function __vcWaitJob(jobId){const started=Date.now();for(;;){await new Promise(r=>setTimeout(r,2000));const j=await api('/api/clip-job/'+encodeURIComponent(jobId));const elapsed=Math.floor((Date.now()-started)/1000),min=Math.floor(elapsed/60),sec=String(elapsed%60).padStart(2,'0');const pct=Number(j.percent||25);progress(pct,j.stage==='transcribing'?'Transcrevendo o vídeo…':j.stage==='selecting'?'Selecionando os melhores momentos…':j.stage==='rendering'?'Renderizando os clipes…':j.stage==='done'?'Clipes prontos!':'Processando…',(j.message||'Processando')+' • '+min+'m '+sec+'s',j.stage==='transcribing'?1:j.stage==='selecting'?2:j.stage==='rendering'?3:j.stage==='done'?4:1);if(j.status==='done')return j;if(j.status==='failed')throw new Error(j.error||j.message||'Falha no processamento');if(elapsed>45*60)throw new Error('O processamento demorou mais que o esperado.')}}
processVideo=async function(){const btn=$('#processBtn');setBusy(btn,true,'Processando…','✦ Criar clipes automaticamente');try{let src;if(state.sourceMode==='upload'){const f=$('#videoFile').files?.[0];if(!f)throw new Error('Escolha um vídeo primeiro');src=await uploadSource(f);src.sourceTitle=f.name}else src=await importYoutube();state.source=src;progress(25,'Processamento iniciado','Preparando transcrição e seleção dos cortes.',1);const start=await api('/api/clip-job',{method:'POST',body:JSON.stringify({sourceId:src.sourceId,sourceTitle:src.sourceTitle||'',sourceUrl:src.sourceUrl||'',count:Number($('#clipCount').value),minDuration:Number($('#minDuration').value),maxDuration:Number($('#maxDuration').value),goal:$('#clipGoal').value})});const d=await __vcWaitJob(start.jobId);progress(100,'Clipes prontos!','Selecione um corte para baixar, publicar ou agendar.',4);renderClipResults(d.items||[]);await loadProjects();toast((d.items?.length||0)+' clipes criados ✓');}catch(e){toast(e.message);progress(0,'Não foi possível processar',e.message,0)}finally{setBusy(btn,false,'Processando…','✦ Criar clipes automaticamente')}};
const __vcProcessBtn=$('#processBtn');if(__vcProcessBtn){__vcProcessBtn.onclick=processVideo;__vcProcessBtn.dataset.pipeline='async-v6';}
window.__VIRACLIP_PIPELINE='async-v6';\n`;
    fs.writeFileSync(appPath,app,'utf8');
  }
}catch(e){console.warn('ViraClip async job client patch was not applied:',e.message)}