// main/finder/adapters/key-stubs.js — three sources that need an API key.
//
// Thingiverse, MyMiniFactory and Cults3D all issue API keys to registered apps,
// and this app has none. These adapters exist so the site chip can say exactly
// what is missing ("needs API key") instead of the site silently not being there.
// They never make a network request.
//
// To switch one on later: provide its key in the process environment (the
// launcher injects it from OneCLI; a key never goes in a file), then replace the
// stub's search/detail with the real calls at one request per second.
//
//   Thingiverse    THINGIVERSE_API_TOKEN   GET api.thingiverse.com/search/{term}
//   MyMiniFactory  MYMINIFACTORY_API_KEY   GET www.myminifactory.com/api/v2/search
//   Cults3D        CULTS3D_API_KEY         POST cults3d.com/graphql (metadata only;
//                                          its API gives no file download)
'use strict';

const { FinderError } = require('../errors.js');

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

const createThingiverseAdapter = ({ env } = {}) => createKeyStub({ id: 'thingiverse', label: 'Thingiverse', envVar: 'THINGIVERSE_API_TOKEN', env });
const createMyMiniFactoryAdapter = ({ env } = {}) => createKeyStub({ id: 'myminifactory', label: 'MyMiniFactory', envVar: 'MYMINIFACTORY_API_KEY', env });
const createCults3dAdapter = ({ env } = {}) => createKeyStub({ id: 'cults3d', label: 'Cults3D', envVar: 'CULTS3D_API_KEY', env });

module.exports = { createKeyStub, createThingiverseAdapter, createMyMiniFactoryAdapter, createCults3dAdapter };
