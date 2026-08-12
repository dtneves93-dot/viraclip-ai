'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media');
const JOB_DIR = process.env.JOB_DIR || path.join(DATA_DIR, 'jobs');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'viraclip-v7.sqlite');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-20b';
const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo';
const MAX_SELECTION_CHARS = Number(process.env.GROQ_SELECTION_INPUT_CHARS || 14000);
const CLIP_TIMEOUT_MS = Number(process.env.VIRACLIP_CLIP_TIMEOUT_MS || 8 * 60 * 1000);

for (const dir of [DATA_DIR, UPLOAD_DIR, MEDIA_DIR, JOB_DIR]) fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(DB_PATH);
const jobId = process.argv[2];
if (!jobId) throw new Error('jobId ausente');
const jobPath = path.join(JOB_DIR, `${jobId}.json`);
const inputPath = path.join(JOB_DIR, `${jobId}.input.json`);
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const now = () => new Date().toISOString();
const uid = p => `${p}_${crypto.randomBytes(10).toString('hex')}`;
const clean = (v, n=4000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clamp = (n,a,b) => Math.max(a, Math.min(b, Number(n)||0));

function readJob(){ try{return JSON.parse(fs.readFileSync(jobPath,'utf8'));}catch{return {jobId};} }
function writeJob(patch){
  const next={...readJob(),...patch,updatedAt:now()};
  const tmp=`${jobPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(next),'utf8');
  fs.renameSync(tmp,jobPath);
}
function syncRun(bin,args,maxBuffer=32*1024*1024){
  const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer});
  if(r.status!==0)throw new Error((r.stderr||r.stdout||`Falha em ${bin}`).trim());
  return r.stdout||'';
}
function probe(file){
  const raw=syncRun(FFPROBE,['-v','error','-print_format','json','-show_format','-show_streams',file]);
  const j=JSON.parse(raw),v=(j.streams||[]).find(x=>x.codec_type==='video')||{};
  return {duration:Number(j.format?.duration||v.duration||0),width:Number(v.width||0),height:Number(v.height||0)};
}
function probeAudio(file){
  const x=Number(syncRun(FFPROBE,['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file]).trim());
  return Number.isFinite(x)?x:600;
}
function findSource(sourceId){
  const f=fs.readdirSync(UPLOAD_DIR).find(x=>x.startsWith(`${sourceId}.`)||x.startsWith(`${sourceId}_`));
  return f?path.join(UPLOAD_DIR,f):null;
}
function srtTime(sec){
  const ms=Math.max(0,Math.round(Number(sec||0)*1000));
  const h=String(Math.floor(ms/3600000)).padStart(2,'0'),m=String(Math.floor(ms%3600000/60000)).padStart(2,'0'),s=String(Math.floor(ms%60000/1000)).padStart(2,'0'),x=String(ms%1000).padStart(3,'0');
  return `${h}:${m}:${s},${x}`;
}
function writeSrt(file,segments,start,end,fallback){
  const rows=[];
  for(const seg of segments||[]){
    const a=Math.max(start,Number(seg.start||0)),b=Math.min(end,Number(seg.end||0));
    if(b-a<.08)continue;
    const text=String(seg.text||'').trim(); if(!text)continue;
    rows.push(`${rows.length+1}\n${srtTime(a-start)} --> ${srtTime(b-start)}\n${text}\n`);
  }
  if(!rows.length&&fallback)rows.push(`1\n00:00:00,000 --> ${srtTime(Math.max(.5,end-start))}\n${fallback}\n`);
  fs.writeFileSync(file,rows.join('\n'),'utf8');
}
function escapeSubtitlePath(srt){return srt.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");}
function subtitleFilter(srt,mode){
  const safe=mode==='safe',w=safe?360:540,h=safe?640:960,font=safe?14:17,margin=safe?48:70,fps=safe?20:24;
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${w}:${h},fps=${fps},setsar=1,subtitles='${escapeSubtitlePath(srt)}':force_style='FontName=Arial,FontSize=${font},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${margin}'`;
}
function parseClock(v){const m=String(v||'').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):0;}

async function transcribe(source){
  if(!GROQ_API_KEY)throw new Error('GROQ_API_KEY não configurada');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viraclip-audio-'));
  try{
    const pattern=path.join(dir,'chunk-%03d.mp3');
    syncRun(FFMPEG,['-y','-loglevel','error','-i',source,'-vn','-ac','1','-ar','16000','-b:a','48k','-f','segment','-segment_time','600','-reset_timestamps','1',pattern]);
    const files=fs.readdirSync(dir).filter(x=>x.endsWith('.mp3')).sort(),segments=[];
    let offset=0;
    for(let i=0;i<files.length;i++){
      writeJob({stage:'transcribing',percent:30+Math.round((i/Math.max(1,files.length))*20),message:`Transcrevendo áudio ${i+1}/${files.length}`});
      const name=files[i],fp=path.join(dir,name),duration=probeAudio(fp);
      const form=new FormData();
      form.append('file',new Blob([fs.readFileSync(fp)],{type:'audio/mpeg'}),name);
      form.append('model',TRANSCRIBE_MODEL);form.append('language','pt');form.append('response_format','verbose_json');form.append('timestamp_granularities[]','segment');
      const r=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${GROQ_API_KEY}`},body:form});
      const j=await r.json(); if(!r.ok)throw new Error(j?.error?.message||`Falha na transcrição (${r.status})`);
      for(const s of j.segments||[])segments.push({start:offset+Number(s.start||0),end:offset+Number(s.end||0),text:String(s.text||'').trim()});
      offset+=duration;
    }
    return {text:segments.map(s=>s.text).join(' '),segments};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function lineScore(text){
  const t=String(text||'').toLowerCase();let s=Math.min(3,t.length/180);if(/[?!]/.test(t))s+=2;if(/\b\d+[\d.,%]*\b/.test(t))s+=1;
  if(/\b(você|como|porque|segredo|erro|nunca|sempre|melhor|pior|verdade|descobri|aprendi|atenção|importante|problema|resultado|dinheiro|incrível|absurdo|olha|imagina|mas|então)\b/i.test(t))s+=2;
  return s;
}
function compactTranscript(segments,maxChars=MAX_SELECTION_CHARS){
  if(!segments.length)return '';
  const blocks=[];let cur={start:segments[0].start,end:segments[0].end,text:[],score:0};
  for(const seg of segments){cur.end=seg.end;cur.text.push(seg.text);cur.score+=lineScore(seg.text);if(cur.end-cur.start>=45||cur.text.join(' ').length>=850){blocks.push({...cur,text:cur.text.join(' ')});cur={start:seg.end,end:seg.end,text:[],score:0};}}
  if(cur.text.length)blocks.push({...cur,text:cur.text.join(' ')});
  const selected=new Map();[...blocks].sort((a,b)=>b.score-a.score).slice(0,9).forEach(b=>selected.set(`${b.start}-${b.end}`,b));
  const spread=Math.min(7,blocks.length);for(let i=0;i<spread;i++){const ix=Math.min(blocks.length-1,Math.round(i*(blocks.length-1)/Math.max(1,spread-1))),b=blocks[ix];selected.set(`${b.start}-${b.end}`,b)}
  let out='';for(const b of [...selected.values()].sort((a,b)=>a.start-b.start)){const row=`[${b.start.toFixed(1)}-${b.end.toFixed(1)}] ${b.text}\n`;if((out+row).length>maxChars)break;out+=row}return out;
}
function fallbackCuts(duration,count,minD,maxD,segments){
  const d=clamp(Math.min(maxD,Math.max(minD,35)),5,Math.max(5,duration)),candidates=[];
  for(const s of segments){const score=lineScore(s.text);if(score>2)candidates.push({start:s.start,score,text:s.text})}candidates.sort((a,b)=>b.score-a.score);
  const chosen=[];for(const c of candidates){if(chosen.length>=count)break;const start=clamp(c.start-2,0,Math.max(0,duration-d));if(chosen.some(x=>Math.abs(x.start-start)<d*.65))continue;chosen.push({start,end:Math.min(duration,start+d),text:c.text})}
  while(chosen.length<count){const usable=Math.max(0,duration-d),i=chosen.length,start=count>1?usable*i/(count-1):0;chosen.push({start,end:Math.min(duration,start+d),text:''})}
  return chosen.slice(0,count).map((c,i)=>({start:c.start,end:c.end,title:`Clipe ${i+1}`,hook:c.text||'Momento forte do vídeo',reason:'Seleção automática de segurança.',caption:c.text||'Trecho selecionado do vídeo original.',hashtags:'#reels #cortes #viraclip',score:70-i*3}));
}
async function chooseCuts(transcript,duration,opt){
  const count=clamp(opt.count||3,1,5),minD=clamp(opt.minDuration||20,5,60),maxD=Math.max(minD,clamp(opt.maxDuration||60,minD,60)),compact=compactTranscript(transcript.segments);
  if(!GROQ_API_KEY||!compact)return fallbackCuts(duration,count,minD,maxD,transcript.segments);
  const prompt=`Você é editor de Reels. Escolha exatamente ${count} cortes independentes com maior potencial de retenção. Objetivo: ${clean(opt.goal||'Maior retenção',80)}. Cada corte deve durar entre ${minD} e ${maxD} segundos, começar e terminar em pontos naturais da fala e usar somente tempos existentes no vídeo de 0 a ${duration.toFixed(1)}s. Responda SOMENTE JSON válido no formato {"clips":[{"start":0,"end":30,"title":"","hook":"","reason":"","caption":"","hashtags":"#reels","score":80}]}.\nTRANSCRIÇÃO:\n${compact}`;
  try{
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:TEXT_MODEL,messages:[{role:'user',content:prompt}],temperature:0.2,response_format:{type:'json_object'}})});
    const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||`Groq ${r.status}`);let clips=JSON.parse(j?.choices?.[0]?.message?.content||'{}').clips||[];if(clips.length<count)throw new Error('IA retornou poucos cortes');
    return clips.slice(0,count).map((c,i)=>{let start=clamp(c.start,0,Math.max(0,duration-1)),end=clamp(c.end,start+1,duration);if(end-start<minD)end=Math.min(duration,start+minD);if(end-start>maxD)end=Math.min(duration,start+maxD);return{...c,start,end,title:clean(c.title||`Clipe ${i+1}`,100),hook:clean(c.hook||c.title,240),reason:clean(c.reason,500),caption:String(c.caption||'').slice(0,2200),hashtags:clean(c.hashtags||'#reels #viraclip',500),score:clamp(c.score||70,0,100)}});
  }catch(e){console.warn('ViraClip selection fallback:',e.message);return fallbackCuts(duration,count,minD,maxD,transcript.segments);}
}

function renderAttempt({source,start,end,id,srt,index,total,mode}){
  return new Promise((resolve,reject)=>{
    const duration=Math.max(1,end-start),out=path.join(MEDIA_DIR,`${id}.mp4`),span=30/Math.max(1,total),base=68+index*span,started=Date.now();
    const safe=mode==='safe';
    const args=['-y','-hide_banner','-nostats','-loglevel','error','-stats_period','1','-ss',String(start),'-t',String(duration),'-i',source,'-vf',subtitleFilter(srt,mode),'-filter_threads','1','-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-crf',safe?'33':'30','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a',safe?'64k':'80k','-movflags','+faststart','-max_muxing_queue_size','1024','-progress','pipe:2',out];
    const child=spawn(FFMPEG,args,{stdio:['ignore','ignore','pipe']});
    let buffer='',err='',lastProgress=Date.now(),lastWrite=0,finished=false;
    const timer=setInterval(()=>{
      if(finished)return;
      const elapsed=Math.floor((Date.now()-started)/1000),m=Math.floor(elapsed/60),s=String(elapsed%60).padStart(2,'0');
      if(Date.now()-lastProgress>120000){child.kill('SIGKILL');return;}
      if(Date.now()-lastWrite>5000){lastWrite=Date.now();writeJob({stage:'rendering',percent:Math.min(97,Math.round(base+span*.08)),message:`Renderizando clipe ${index+1}/${total} • ${safe?'modo econômico':'modo leve'} • ${m}m ${s}s`});}
    },5000);
    const hard=setTimeout(()=>{if(!finished)child.kill('SIGKILL');},CLIP_TIMEOUT_MS);
    child.stderr.on('data',chunk=>{
      const text=chunk.toString();err=(err+text).slice(-200000);buffer+=text;let nl;
      while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl).trim();buffer=buffer.slice(nl+1);if(line.startsWith('out_time=')){const sec=parseClock(line.slice(9));if(sec>0){lastProgress=Date.now();const frac=clamp(sec/duration,0,1),pct=Math.min(97,Math.round(base+span*(.05+.9*frac))),elapsed=Math.floor((Date.now()-started)/1000),m=Math.floor(elapsed/60),ss=String(elapsed%60).padStart(2,'0');if(Date.now()-lastWrite>1500){lastWrite=Date.now();writeJob({stage:'rendering',percent:pct,message:`Renderizando clipe ${index+1}/${total} • ${Math.round(frac*100)}% do clipe • ${safe?'modo econômico':'modo leve'} • ${m}m ${ss}s`});}}}}
    });
    child.on('error',e=>{finished=true;clearInterval(timer);clearTimeout(hard);reject(e)});
    child.on('close',code=>{finished=true;clearInterval(timer);clearTimeout(hard);if(code===0&&fs.existsSync(out)&&fs.statSync(out).size>10000)return resolve(`/media/${path.basename(out)}`);try{fs.rmSync(out,{force:true})}catch{};reject(new Error(code===null?'FFmpeg foi interrompido por limite de recursos':(err.trim()||`FFmpeg encerrou com código ${code}`)))});
  });
}
async function renderClip(source,start,end,id,segments,hook,index,total){
  const srt=path.join(os.tmpdir(),`${id}.srt`);writeSrt(srt,segments,start,end,hook);
  try{
    try{return await renderAttempt({source,start,end,id,srt,index,total,mode:'light'});}
    catch(first){console.warn(`Render leve falhou no clipe ${index+1}:`,first.message);writeJob({stage:'rendering',message:`Clipe ${index+1}/${total}: reduzindo qualidade para concluir`});return await renderAttempt({source,start,end,id,srt,index,total,mode:'safe'});}
  }finally{fs.rmSync(srt,{force:true});}
}
function saveProject(workspaceId,p){
  const created=now(),meta=JSON.stringify({viralScore:p.viralScore||0,reason:p.reason||'',clipStart:p.clipStart||0,clipEnd:p.clipEnd||0,sourceId:p.sourceId||''});
  db.prepare(`INSERT INTO projects(id,workspace_id,idea,hook,script,caption,hashtags,duration,status,video_url,planned_at,published_media_id,meta_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,workspaceId,p.idea||'',p.hook||'',p.script||'',p.caption||'',p.hashtags||'',Number(p.duration||0),'rendered',p.videoUrl,null,null,meta,created,created);
  return {...p,workspaceId,status:'rendered',createdAt:created,updatedAt:created,plannedAt:null,publishedMediaId:null,scenes:[{source:JSON.parse(meta)}]};
}

(async()=>{
  try{
    writeJob({status:'running',stage:'starting',percent:26,message:'Preparando processamento'});
    const source=findSource(input.sourceId);if(!source)throw new Error('Vídeo fonte não encontrado. Faça o upload novamente.');
    const info=probe(source);if(!info.duration)throw new Error('Não foi possível ler a duração do vídeo.');
    writeJob({stage:'transcribing',percent:28,message:'Transcrevendo o vídeo'});const transcript=await transcribe(source);
    writeJob({stage:'selecting',percent:56,message:'IA escolhendo os melhores momentos'});const cuts=await chooseCuts(transcript,info.duration,input);
    const items=[],warnings=[];
    for(let i=0;i<cuts.length;i++){
      const c=cuts[i],id=uid('clip');writeJob({stage:'rendering',percent:68+Math.round(i*(30/Math.max(1,cuts.length))),message:`Iniciando clipe ${i+1}/${cuts.length}`});
      try{
        const videoUrl=await renderClip(source,c.start,c.end,id,transcript.segments,c.hook||c.title,i,cuts.length);
        const script=transcript.segments.filter(s=>s.end>=c.start&&s.start<=c.end).map(s=>s.text).join(' ')||c.hook||c.title;
        items.push(saveProject(input.workspaceId,{id,idea:c.title||`Clipe ${i+1}`,hook:c.hook||c.title,script,caption:c.caption||'',hashtags:c.hashtags||'',duration:c.end-c.start,videoUrl,viralScore:c.score,reason:c.reason,clipStart:c.start,clipEnd:c.end,sourceId:input.sourceId}));
        writeJob({stage:'rendering',percent:68+Math.round((i+1)*(30/Math.max(1,cuts.length))),message:`Clipe ${i+1}/${cuts.length} concluído`});
      }catch(e){warnings.push(`Clipe ${i+1}: ${e.message}`);console.error(`Clipe ${i+1} falhou:`,e);writeJob({stage:'rendering',message:`Clipe ${i+1}/${cuts.length} não concluiu; seguindo para o próximo`,warnings});}
    }
    if(!items.length)throw new Error(`A renderização não conseguiu concluir nenhum clipe. ${warnings[0]||''}`.trim());
    writeJob({status:'done',stage:'done',percent:100,message:`${items.length} clipe(s) pronto(s)`,items,warnings,transcriptSegments:transcript.segments.length,finishedAt:now()});
  }catch(e){console.error(e);writeJob({status:'failed',stage:'failed',error:String(e.message||e),message:'Não foi possível concluir o processamento',finishedAt:now()});process.exitCode=1;}
})();
