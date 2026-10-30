// Environment for the workspace terminals (and the Claude Code they run).
//
// CLAUDE.md tells Claude to check dimensions with "$OPENSCAD_BINARY". The
// bundled OpenSCAD is not on PATH, so without this variable that instruction
// fails on any machine with no system-wide OpenSCAD. Export the same binary
// the app renders with, so Claude's checks and the app's renders agree.
//
// Pure (no Electron) so tests/terminal-env.js can load it directly.

function terminalEnv(baseEnv, openscadBin) {
  return { ...baseEnv, COLORTERM: 'truecolor', OPENSCAD_BINARY: openscadBin };
}

module.exports = { terminalEnv };
