import {JsSignatureProvider} from "eosjs/dist/eosjs-jssig";
import {Api, JsonRpc, RpcError} from "eosjs";
import {PowerUpResState, PowerUpState} from "./interfaces";
import * as BN from "bn.js";
import {fetch} from "cross-fetch";
import {assetToFloat} from "./functions";
import {Configuration} from "./config";

const config = Configuration;

if (!config.intervalSecs) {
    config.intervalSecs = 3600;
} else {
    if (config.intervalSecs <= 30) {
        config.intervalSecs = 30;
    }
}

if (!config.api) {
    console.log('API URL not defined!');
    process.exit(1);
}

if (!config.accounts || config.accounts?.length === 0) {
    console.log('No accounts defined! Please check your config.ts file.');
    process.exit(1);
}

if (!config.payers || config.payers?.length === 0) {
    console.log('No payers defined! Please check your config.ts file.');
    process.exit(1);
}

// constants
const zero = new BN(0);
// 10e4 (EOS native)
const decimals = 10000;
const precision = new BN(decimals);
// 10e15
const precision2 = new BN(1000000000000000);
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
                const x = utilization.mul(precision2).div(weight).toNumber() / precision2.toNumber();
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

            start_utilization = adjustedUtilization;
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
            const cpuMax = new BN(cpu.max);
            const cpuWeight = new BN(accountData.cpu_weight);
            const weightPerUs = cpuMax.mul(precision2).div(cpuWeight).toNumber() / precision2.toNumber();
            const pctCpuFree = (cpu.available / cpu.max) * 100;
            console.log(`${accountData.account_name} has ${cpu.available} us of ${cpu.max} us CPU available (${pctCpuFree.toFixed(2)}%)`);
            let requiredCpu = new BN(account.requiredCPUAvailability - cpu.max);
            if (cpu.available === 0) {
                const usedExtra = cpu.used - cpu.max;
                if (usedExtra > 0) {
                    if (usedExtra > account.allowedExtraCPU) {
                        console.log(`${accountData.account_name} has used ${usedExtra} us and the maximum allowed to powerup is ${account.allowedExtraCPU}!`);
                        continue;
                    } else {
                        requiredCpu = new BN(account.allowedExtraCPU);
                    }
                }
            }

            if (requiredCpu.gt(zero)) {
                console.log(`${account.name} needs ${requiredCpu.toString()} us of CPU`);
                requiredCpu = new BN(requiredCpu.toNumber() / weightPerUs);
                requiredCpuFraction = requiredCpu.mul(powerupFraction).div(new BN(this.powerupState.cpu.weight));
            }

            // calculate fraction for NET
            const net = accountData.net_limit;
            const netWeight = new BN(accountData.net_weight);
            const netMax = new BN(net.max);
            const weightPerByte = netMax.mul(precision2).div(netWeight).toNumber() / precision2.toNumber();
            const pctNetFree = (net.available / net.max) * 100;
            console.log(`${accountData.account_name} has ${net.available} of ${net.max} bytes of NET available (${pctNetFree.toFixed(2)}%)`);
            let requiredNet = new BN(account.requiredNETAvailability - net.max);
            if (net.available === 0) {
                const usedExtra = net.used - net.max;
                if (usedExtra > 0) {
                    if (usedExtra > account.allowedExtraNET) {
                        console.log(`${accountData.account_name} has used ${usedExtra} bytes and the maximum allowed to powerup is ${account.allowedExtraNET}!`);
                        continue;
                    } else {
                        requiredNet = new BN(account.allowedExtraNET);
                    }
                }
            }
            if (requiredNet.gt(zero)) {
                console.log(`${account.name} needs ${requiredNet.toString()} bytes of NET`);
                requiredNet = new BN(requiredNet.toNumber() / weightPerByte );
                requiredNetFraction = requiredNet.mul(powerupFraction).div(new BN(this.powerupState.net.weight));
            }

            // calculate fee CPU + NET
            const feeCpu = this.calculateFee(this.powerupState.cpu, requiredCpu);
            const feeNet = this.calculateFee(this.powerupState.net, requiredNet);
            const feeAmount = feeCpu + feeNet;

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
                    console.log('Pushing transaction...');
                    console.log(JSON.stringify(transaction, null, 2));
                    const trxResponse = await this.api.transact(transaction, {
                        useLastIrreversible: true,
                        broadcast: config.broadcast,
                        expireSeconds: 3600,
                        sign: true
                    });
                    console.log(`Trx Id: ${trxResponse["transaction_id"]} on block ${trxResponse["processed"]["block_num"]}`);
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
