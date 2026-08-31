#!/usr/bin/env node

import { getDebtRepository } from "../db.ts";
import { DebtHttpServer, parseInfoDebtHttpPort } from "./server.ts";

const repository = getDebtRepository();
const server = new DebtHttpServer({
	repository,
	port: parseInfoDebtHttpPort(process.env.PI_INFO_DEBT_HTTP_PORT),
});

async function shutdown(): Promise<void> {
	await server.stop();
	await repository.close();
}

process.once("SIGINT", () => {
	void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
	void shutdown().then(() => process.exit(0));
});

try {
	const address = await server.start();
	console.log(`Information Debt HTTP API listening on http://${address.host}:${address.port}`);
} catch (error) {
	await repository.close();
	throw error;
}
