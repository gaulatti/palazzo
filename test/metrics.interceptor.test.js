const assert = require('node:assert/strict');
const test = require('node:test');
const { of, throwError, firstValueFrom } = require('rxjs');
const { MetricsInterceptor } = require('../dist/stream/metrics.interceptor');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { parseExposition, assertBoundedLabels } = require('./prometheus-exposition');

test('non-HTTP execution is returned without creating HTTP observations', () => {
  const output = of('rpc-result');
  const interceptor = new MetricsInterceptor({ observeHttp: () => assert.fail('RPC is not HTTP') });
  assert.equal(interceptor.intercept({ getType: () => 'rpc' }, { handle: () => output }), output);
});

test('HTTP interceptor records successes and real exception outcomes in the bounded collector', async () => {
  const telemetry = new PlaybackTelemetryService({ get: () => undefined });
  const interceptor = new MetricsInterceptor(telemetry);
  for (const [request, statusCode, error] of [
    [{ method: 'GET', routeOptions: { url: '/playback/state' } }, 200, undefined],
    [{ method: 'POST', routeOptions: { url: '/song' } }, 201, undefined],
    [{ method: 'POST' }, 200, { getStatus: () => 409 }],
    [{ method: 'WEIRD', routeOptions: {} }, 200, new Error('private detail')],
    [{ method: 'GET' }, 200, null],
    [{ method: 'GET' }, 200, 'failure'],
    [{ method: 'GET' }, 200, { getStatus: 400 }],
  ]) {
    const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode }) }) };
    const output = interceptor.intercept(context, { handle: () => error === undefined ? of('ok') : throwError(() => error) });
    if (error === undefined) assert.equal(await firstValueFrom(output), 'ok');
    else await assert.rejects(firstValueFrom(output), (actual) => actual === error);
  }
  const metrics = await telemetry.renderMetrics();
  assertBoundedLabels(parseExposition(metrics));
  assert.match(metrics, /status="4xx"/);
  assert.match(metrics, /status="5xx"/);
  assert.doesNotMatch(metrics, /private detail|WEIRD/);
  telemetry.shutdown();
});
