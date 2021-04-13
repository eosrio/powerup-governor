export interface PowerUpResState {
	version: number;
	weight: string;
	weight_ratio: string;
	assumed_stake_weight: string;
	initial_weight_ratio: string;
	target_weight_ratio: string;
	initial_timestamp: string;
	target_timestamp: string;
	exponent: string;
	decay_secs: number;
	min_price: string;
	max_price: string;
	utilization: string;
	adjusted_utilization: string;
	utilization_timestamp: string;
}

export interface PowerUpState {
	version: number;
	cpu: PowerUpResState;
	net: PowerUpResState;
	powerup_days: number;
	min_powerup_fee: string;
}
