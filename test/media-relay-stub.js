// Unit tests of playout logic read media URLs unchanged; the relay itself and
// its wiring are tested against the real MediaRelay (media-relay.test.js).
const identityRelay = {
  issue: async (url) => url,
  renderMetrics: () => '',
};
module.exports = { identityRelay };
