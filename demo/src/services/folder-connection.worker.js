import { createSharedConnectionHost } from "./shared-connection-host.js";

const host = createSharedConnectionHost();
self.onconnect = ({ ports }) => host.attach(ports[0]);
