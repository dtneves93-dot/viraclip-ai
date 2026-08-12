const http = require('http');

const originalCreateServer = http.createServer;
http.createServer = function patchedCreateServer(...args) {
  const server = originalCreateServer.apply(this, args);
  // Uploads de vídeo em redes móveis podem levar vários minutos.
  // Evita que o Node encerre a requisição no meio do envio.
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 125 * 1000;
  server.keepAliveTimeout = 120 * 1000;
  return server;
};
