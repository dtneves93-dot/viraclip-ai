'use strict';

// ViraClip MVP: keep FFmpeg rendering light enough for Render Free.
// The main server imports spawnSync from child_process during startup, so this
// preload replaces spawnSync before server.js captures it.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const originalSpawnSync = childProcess.spawnSync;

function replaceArg(args, flag, value) {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) args[i + 1] = value;
}

childProcess.spawnSync = function viraClipFastSpawnSync(command, args = [], options = {}) {
  if (String(command).toLowerCase().includes('ffmpeg') && Array.isArray(args)) {
    const next = [...args];
    const vfIndex = next.indexOf('-vf');
    const codecIndex = next.indexOf('-c:v');
    const isClipRender = vfIndex >= 0 && codecIndex >= 0 && String(next[codecIndex + 1] || '').toLowerCase() === 'libx264';

    if (isClipRender) {
      let vf = String(next[vfIndex + 1] || '');
      vf = vf
        .replace(/scale=1080:1920/g, 'scale=720:1280')
        .replace(/crop=1080:1920/g, 'crop=720:1280')
        .replace(/FontSize=20/g, 'FontSize=18')
        .replace(/MarginV=140/g, 'MarginV=92');
      next[vfIndex + 1] = vf;

      replaceArg(next, '-preset', process.env.VIRACLIP_FFMPEG_PRESET || 'ultrafast');
      replaceArg(next, '-crf', process.env.VIRACLIP_FFMPEG_CRF || '27');
      replaceArg(next, '-b:a', process.env.VIRACLIP_AUDIO_BITRATE || '96k');

      // Avoid excessive CPU/RAM pressure on the free instance.
      if (!next.includes('-threads')) {
        const outIndex = Math.max(0, next.length - 1);
        next.splice(outIndex, 0, '-threads', process.env.VIRACLIP_FFMPEG_THREADS || '1');
      }

      console.log('ViraClip fast render: 720x1280, ultrafast, single-thread');
      return originalSpawnSync.call(childProcess, command, next, options);
    }
  }
  return originalSpawnSync.call(childProcess, command, args, options);
};

// Make the browser explain that render is still working instead of looking frozen.
try {
  const appPath = path.join(__dirname, 'app.js');
  const marker = '/* ViraClip render activity v1 */';
  let app = fs.readFileSync(appPath, 'utf8');
  if (!app.includes(marker)) {
    app += `\n\n${marker}\n
const __vcOriginalProgress = progress;
let __vcRenderStartedAt = 0;
progress = function(percent,title,text,done=0){
  if(String(title||'').toLowerCase().includes('renderizando')){
    if(!__vcRenderStartedAt) __vcRenderStartedAt = Date.now();
    const sec = Math.max(0,Math.floor((Date.now()-__vcRenderStartedAt)/1000));
    const min = Math.floor(sec/60), rem = sec%60;
    text = 'Renderização em andamento • '+(min?min+'m ':'')+rem+'s • não feche esta tela';
  } else if(Number(percent)>=100 || Number(percent)===0){
    __vcRenderStartedAt = 0;
  }
  return __vcOriginalProgress(percent,title,text,done);
};\n`;
    fs.writeFileSync(appPath, app, 'utf8');
  }
} catch (e) {
  console.warn('Render activity patch not applied:', e.message);
}
