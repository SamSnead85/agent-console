#!/usr/bin/env node
/*
 * The console's entry point.
 *
 * Deliberately thin: it resolves this package's own server and runs it in
 * THIS process rather than spawning a child. The version that shipped inside
 * the Muster CLI spawned one, which was right there — the CLI had its own
 * lifecycle to protect — and is wrong here, where there is nothing to protect
 * it from and a spawn only adds a process whose exit codes have to be
 * translated back.
 */

import "../server.js";
