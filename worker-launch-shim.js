'use strict';

// job-shim captures child_process.spawn during preload. Patch spawn first so the
// video worker always starts with the Groq retry layer even though job-shim clears
// NODE_OPTIONS for its child process.
const childProcess = require('child_process');
const path = require('path');
const originalSpawn = childProcess.spawn;

childProcess.spawn = function viraClipWorkerSpawn(command, args = [], options = {}) {
  const isNode = path.basename(String(command || '')).toLowerCase().startsWith('node');
  const isWorker = Array.isArray(args) && args.some(a => String(a).includes('clip-worker-v2.js'));
  if (isNode && isWorker) {
    const retryShim = path.join(__dirname, 'groq-retry-shim.js');
    const env = { ...(options.env || process.env), NODE_OPTIONS: `--require=${retryShim}` };
    console.log('ViraClip worker: Groq retry layer enabled');
    return originalSpawn.call(childProcess, command, args, { ...options, env });
  }
  return originalSpawn.call(childProcess, command, args, options);
};
