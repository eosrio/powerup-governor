export const Configuration = {
	api: 'https://api.eosrio.io',
	broadcast: true,
	intervalSecs: 3600, // run every hour
	// managed accounts
	accounts: [
		{
			name: 'eosriobrazil',
			payer: 'eosriobrazil',
			requiredCPUAvailability: 150000,
			requiredNETAvailability: 4096
		}
	],
	// assigned payers
	payers: [
		{
			name: 'eosriobrazil',
			key: 'PVT_K1_',
			permission: 'powerup'
		}
	]
};
