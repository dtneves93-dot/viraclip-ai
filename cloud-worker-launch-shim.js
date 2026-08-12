'use strict';

const childProcess=require('child_process');
const path=require('path');
const previousSpawn=childProcess.spawn;

childProcess.spawn=function viraClipCloudWorkerSpawn(command,args=[],options={}){
  const cloudReady=Boolean(process.env.CLOUDINARY_CLOUD_NAME&&process.env.CLOUDINARY_API_KEY&&process.env.CLOUDINARY_API_SECRET);
  const isNode=path.basename(String(command||'')).toLowerCase().startsWith('node');
  const ix=Array.isArray(args)?args.findIndex(a=>String(a).includes('clip-worker-v2.js')):-1;
  if(cloudReady&&isNode&&ix>=0){
    const next=[...args];
    next[ix]=path.join(__dirname,'cloud-worker.js');
    console.log('ViraClip: clip job routed to Cloudinary renderer');
    return previousSpawn.call(childProcess,command,next,options);
  }
  return previousSpawn.call(childProcess,command,args,options);
};
