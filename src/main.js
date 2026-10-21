#!/usr/bin/env node
'use strict';
// The program: the npm bin and the entry point of the Claude Desktop
// extension. It runs the CLI whatever loaded it: a launcher that loads the
// entry through its own wrapper leaves require.main pointing elsewhere.

require('./cli.js').run(process.argv.slice(2));
