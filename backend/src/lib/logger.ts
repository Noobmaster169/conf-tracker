import pino from "pino";

import { config } from "../config";

const root = pino({ level: config.LOG_LEVEL });

export function childLogger(bindings: { module: string }): pino.Logger {
  return root.child(bindings);
}
