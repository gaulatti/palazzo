// Exercise the actual root module, Fastify adapter, listen, and CORS setup.
// The audio subprocess is tested separately in the pinned runtime container.
const { StreamService } = require('../dist/stream/stream.service');
StreamService.prototype.onModuleInit = async () => {};
const assert = require('node:assert/strict');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const listen = FastifyAdapter.prototype.listen;
FastifyAdapter.prototype.listen = function (port, ...args) {
  assert.equal(port, Number(process.env.PALAZZO_PORT));
  assert.equal(args[0], '0.0.0.0');
  // Let the OS allocate the fixture's port atomically, after verifying the
  // bootstrap's configured port and bind address at the adapter boundary.
  return listen.call(this, 0, ...args);
};
const { NestFactory } = require('@nestjs/core');
const create = NestFactory.create.bind(NestFactory);
NestFactory.create = async (...args) => {
  const app = await create(...args);
  app.getHttpServer().once('listening', () => {
    const address = app.getHttpServer().address();
    process.send({ origin: `http://${address.address}:${address.port}` });
  });
  process.on('message', async (message) => {
    if (message === 'close') {
      app.getHttpServer().closeAllConnections();
      await app.close();
      process.disconnect();
    }
  });
  return app;
};
require('../dist/main');
