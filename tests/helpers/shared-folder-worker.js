import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { createSharedConnectionHost } from "../../demo/src/services/shared-connection-host.js";

// Real sockets run in a separate thread. Only the native SharedWorker connect event is adapted.
globalThis.WebSocket = class extends WebSocket {
  constructor(url) { super(url, { origin: workerData.origin }); }
};
const host = createSharedConnectionHost({ graceMs: workerData.graceMs });
parentPort.on("message", (port) => host.attach(port));
