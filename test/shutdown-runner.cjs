// A real process that installs the shutdown handlers around a fake application,
// so the test can send it a real SIGTERM.
const { installShutdownHandlers } = require('../dist/shutdown');
const mode = process.argv[2];
installShutdownHandlers({
  close: () => new Promise((resolve) => {
    if (mode === 'hang') return; // never finishes
    setTimeout(resolve, 50);
  }),
}, { graceMs: 400 });
// Keep the event loop alive, as the HTTP server does.
setInterval(() => {}, 1000);
process.send({ ready: true });
