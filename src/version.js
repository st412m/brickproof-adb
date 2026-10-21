'use strict';
// The version has one source: package.json.

const VERSION = require('../package.json').version;

// The image libraries' own versions, for `check` and the start line.
const PNGJS_VERSION = require('pngjs/package.json').version;
const JPEG_JS_VERSION = require('jpeg-js/package.json').version;

module.exports = { VERSION, PNGJS_VERSION, JPEG_JS_VERSION };
