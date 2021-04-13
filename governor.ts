import {JsSignatureProvider} from "eosjs/dist/eosjs-jssig";
import {Api, JsonRpc, RpcError} from "eosjs";
import {PowerUpResState, PowerUpState} from "./interfaces";
import * as BN from "bn.js";
import {fetch} from "cross-fetch";
import {assetToFloat} from "./functions";
import {Configuration} from "./config";
const config = Configuration;

// constants
const zero = new BN(0);
const decimals = 10000;
// 10e4 (EOS native)
const precision = new BN(decimals);
// 10e7
const precision2 = new BN(10000000);
// 10e15
const powerupFraction = new BN(1000000000000000);

export class PowerupGovernor {
	signatureProvider: JsSignatureProvider;
	rpc: JsonRpc;
	powerupState: PowerUpState;
	api: Api;
	mainLoop: NodeJS.Timeout;

	constructor() {
		this.init();
	}

	init() {
		this.signatureProvider = new JsSignatureProvider(config.payers.map(payer => payer.key));
		this.rpc = new JsonRpc(config.api, {fetch});
		this.api = new Api({
			rpc: this.rpc,
			signatureProvider: this.signatureProvider,
			textDecoder: new TextDecoder(),
			textEncoder: new TextEncoder()
		});
	}

	startLoop() {
		this.run().then(() => {
			console.log('Check scheduled every ' + config.intervalSecs + ' seconds...');
			this.mainLoop = setInterval(() => {
				this.run().catch(console.log);
			}, config.intervalSecs * 1000);
		});
	}

	async run() {
		await this.getPowerupState();
		await this.checkAccounts();
		console.log(`\n✅  done checking ${config.accounts.length} accounts`);
	}

	calculateFee(state: PowerUpResState, utilization_increase: BN): number {
		if (utilization_increase.lte(zero)) return 0;

		let fee = 0.0;
		let start_utilization = new BN(state.utilization);
		let end_utilization = start_utilization.add(utilization_increase);
		const weight = new BN(state.weight);

		const minPrice = assetToFloat(state.min_price);
		const maxPrice = assetToFloat(state.max_price);
		const exp = parseFloat(state.exponent);
		const nexp = exp - 1.0;

		const priceFunction = (utilization: BN): number => {
			let price = minPrice;
			if (nexp <= 0.0) {
				return maxPrice;
			} else {
				const d = (maxPrice - minPrice);
				const x = utilization.mul(precision).div(weight).toNumber() / precision.toNumber();
				price += d * Math.pow(x, nexp);
			}
			return price;
		};


		const priceIntegralDelta = (startUtilization: BN, endUtilization: BN): number => {
			const c = (maxPrice - minPrice) / exp;
			const start_u = startUtilization.mul(precision2).div(weight).toNumber() / precision2.toNumber();
			const end_u = endUtilization.mul(precision2).div(weight).toNumber() / precision2.toNumber();
			return (minPrice * end_u) - (minPrice * start_u) + (c * Math.pow(end_u, exp)) - (c * Math.pow(start_u, exp));
		};


		const adjustedUtilization = new BN(state.adjusted_utilization);
		if (start_utilization.lt(adjustedUtilization)) {
			const priceResult = priceFunction(adjustedUtilization);
			const min = BN.min(utilization_increase, adjustedUtilization.sub(start_utilization));
			const k = min.mul(precision2).div(weight).toNumber() / precision2.toNumber();
			fee += priceResult * k;
		}

		if (start_utilization < end_utilization) {
			fee += priceIntegralDelta(start_utilization, end_utilization);
		}

		return Math.ceil(fee * decimals) / decimals;
	}

	async checkAccounts() {
		for (const account of config.accounts) {
			console.log(`\nChecking resources for ${account.name}...`);
			const accountData = await this.rpc.get_account(account.name);
			let requiredNetFraction: BN = zero;
			let requiredCpuFraction: BN = zero;

			// calculate fraction for CPU
			const cpu = accountData.cpu_limit;
			const cpuWeight = new BN(accountData.cpu_weight);
			const weightPerUs = cpuWeight.div(new BN(cpu.max));
			const pctCpuFree = (cpu.available / cpu.max) * 100;
			console.log(`${accountData.account_name} has ${cpu.available} us of CPU available (${pctCpuFree.toFixed(2)}%)`);
			let requiredCpu = (new BN(account.requiredCPUAvailability - cpu.available)).mul(weightPerUs);

			if (requiredCpu.gt(zero)) {
				console.log(`${account.name} needs ${account.requiredCPUAvailability - cpu.available} us of CPU`);
				requiredCpuFraction = requiredCpu.mul(powerupFraction).div(new BN(this.powerupState.cpu.weight));
			}

			// calculate fraction for NET
			const net = accountData.net_limit;
			const netWeight = new BN(accountData.net_weight);
			const weightPerByte = netWeight.div(new BN(net.max));
			const pctNetFree = (net.available / net.max) * 100;
			console.log(`${accountData.account_name} has ${net.available} bytes of NET available (${pctNetFree.toFixed(2)}%)`);
			let requiredNet = (new BN(account.requiredNETAvailability - net.available)).mul(weightPerByte);
			if (requiredNet.gt(zero)) {
				console.log(`${account.name} needs ${account.requiredNETAvailability - net.available} us of CPU`);
				requiredNetFraction = requiredNet.mul(powerupFraction).div(new BN(this.powerupState.net.weight));
			}

			// calculate fee
			const feeAmount = this.calculateFee(this.powerupState.cpu, requiredCpu) + this.calculateFee(this.powerupState.net, requiredNet);

			if (feeAmount > 0) {
				const powerupActionData = {
					payer: account.payer,
					receiver: account.name,
					days: 1,
					net_frac: requiredNetFraction.toString(10),
					cpu_frac: requiredCpuFraction.toString(10),
					max_payment: feeAmount.toFixed(4) + ' EOS'
				};
				const payer = config.payers.find(value => value.name === account.payer);
				try {
					const transaction = {
						actions: [{
							name: 'powerup',
							account: 'eosio',
							authorization: [{actor: account.payer, permission: payer.permission}],
							data: powerupActionData
						}]
					};
					console.log(JSON.stringify(transaction, null, 2));
					const trxResponse = await this.api.transact(transaction, {
						useLastIrreversible: true,
						broadcast: config.broadcast,
						expireSeconds: 3600,
						sign: true
					});
					console.log(trxResponse);
				} catch (e) {
					console.log('\nCaught exception: ' + e);
					if (e instanceof RpcError) {
						console.log(JSON.stringify(e.json, null, 2));
					}
				}
			}
		}
	}

	async getPowerupState() {
		const data = await this.rpc.get_table_rows({
			json: true,
			code: 'eosio',
			table: 'powup.state'
		});
		this.powerupState = data.rows[0];
	}
}
