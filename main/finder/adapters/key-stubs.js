// main/finder/adapters/key-stubs.js — adapters for sources requiring API keys.
//
// Thin delegate re-exporting real adapter implementations for Thingiverse,
// MyMiniFactory, and Cults3D. When their runtime env vars are unset, each adapter
// presents available:false with reason:'needs-key'.
'use strict';

const { FinderError } = require('../errors.js');
const { createThingiverseAdapter } = require('./thingiverse.js');
const { createMyMiniFactoryAdapter } = require('./myminifactory.js');
const { createCults3dAdapter } = require('./cults3d.js');

function createKeyStub({ id, label, envVar, env = process.env }) {
  const hasKey = Boolean(env && env[envVar]);
  const unavailable = () =>
    new FinderError(
      'needs-key',
      hasKey
        ? `${label} support is not built yet. A key is set (${envVar}), but the search code is still a stub.`
        : `${label} needs an API key, which this app does not have yet.`,
      { site: id }
    );
  return {
    id,
    label,
    available: false,
    reason: 'needs-key',
    envVar,
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

module.exports = { createKeyStub, createThingiverseAdapter, createMyMiniFactoryAdapter, createCults3dAdapter };
