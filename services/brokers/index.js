import { CONFIG } from "../../config.js";
import { paperBroker } from "./paper.js";
import { alpacaBroker } from "./alpaca.js";
import { ibkrBroker } from "./ibkr.js";
import { tradierBroker } from "./tradier.js";
import { schwabBroker } from "./schwab.js";

const BROKERS = {
  paper: paperBroker,
  alpaca: alpacaBroker,
  ibkr: ibkrBroker,
  tradier: tradierBroker,
  schwab: schwabBroker,
};

export const SUPPORTED_BROKERS = Object.keys(BROKERS);

/**
 * Return the active broker adapter configured via BROKER in .env.
 */
export function getBroker() {
  const key = (CONFIG.BROKER || "alpaca").toLowerCase();
  const broker = BROKERS[key];
  if (!broker) {
    throw new Error(
      `Unsupported BROKER="${CONFIG.BROKER}". Supported brokers: ${SUPPORTED_BROKERS.join(", ")}`
    );
  }
  return broker;
}
