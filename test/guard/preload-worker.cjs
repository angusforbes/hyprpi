// J566: worker threads don't run `node --import` preloads, so the guard's preload patches worker_threads.Worker to add
// `--require` of this file to every worker's execArgv; it loads the same guard (preload.mjs) inside the worker.
require("./preload.mjs");
