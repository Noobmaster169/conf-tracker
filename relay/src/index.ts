import { loadConfig } from "./config";
import { createRelay } from "./server";

const config = loadConfig();
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const server = createRelay(config, log);
server.listen(config.PORT, () => log({ msg: "relay listening", port: config.PORT, origins: config.ALLOWED_ORIGINS }));

const shutdown = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
