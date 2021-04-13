export const Configuration = {
	api: 'https://api.eosrio.io',
	broadcast: true,
	intervalSecs: 3600, // run every hour
	// managed accounts
	accounts: [
		{
			name: 'TARGET_ACCOUNT',
			payer: 'PAYER_ACCOUNT',
			requiredCPUAvailability: 1600000,
			allowedExtraCPU: 100000,
			requiredNETAvailability: 300000,
			allowedExtraNET: 50000
		}
	],
	// assigned payers
	payers: [
		{
			name: 'PAYER_ACCOUNT',
			key: 'PAYER_PRIVATE_KEY',
			permission: 'powerup'
		}
	]
};
