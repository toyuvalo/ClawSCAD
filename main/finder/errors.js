// main/finder/errors.js — one error type for everything Find & Print does.
//
// Every failure the UI can show has a `code` (stable, tested, safe to branch on)
// and a `message` written for a person. The renderer never sees a stack trace or
// a raw upstream body: `toJSON()` is the only shape that crosses IPC / HTTP.
'use strict';

class FinderError extends Error {
  /**
   * @param {string} code     stable machine code, e.g. 'timeout', 'needs-login'
   * @param {string} message  one plain sentence for the person using the app
   * @param {object} [extra]  small JSON-safe details (status, url, retryAfter)
   */
  constructor(code, message, extra) {
    super(message);
    this.name = 'FinderError';
    this.code = code;
    if (extra && typeof extra === 'object') this.extra = extra;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.extra || {}) };
  }
}

/** Anything thrown becomes a FinderError. Unknown errors keep their message. */
function asFinderError(err, fallbackCode = 'unknown') {
  if (err instanceof FinderError) return err;
  const message = String((err && err.message) || err || 'Unknown error');
  return new FinderError(fallbackCode, message);
}

module.exports = { FinderError, asFinderError };
