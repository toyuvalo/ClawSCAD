// main/finder/adapters/thingiverse.js — a stub, on purpose.
//
// Thingiverse's API needs an application token that this app does not have, and
// the token must live in OneCLI, never in a file. Until the owner provisions one,
// this adapter exists so the site chip can say exactly what is missing instead
// of the site silently not being there.
//
// To switch it on later: provide THINGIVERSE_API_TOKEN in the process
// environment (the launcher injects it from OneCLI), and replace `search` with
// GET https://api.thingiverse.com/search/{term}?access_token=... at 1 req/s.
'use strict';

const { FinderError } = require('../errors.js');

function createThingiverseAdapter({ env = process.env } = {}) {
  const hasToken = Boolean(env && env.THINGIVERSE_API_TOKEN);

  const unavailable = () =>
    new FinderError(
      'needs-token',
      hasToken
        ? 'Thingiverse support is not built yet. A token is set, but the search code is still a stub.'
        : 'Thingiverse needs an API token, which this app does not have yet.',
      { site: 'thingiverse' }
    );

  return {
    id: 'thingiverse',
    label: 'Thingiverse',
    available: false,
    reason: 'needs-token',
    async search() {
      throw unavailable();
    },
    async detail() {
      throw unavailable();
    },
    async download() {
      throw unavailable();
    },
  };
}

module.exports = { createThingiverseAdapter };
