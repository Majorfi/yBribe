import React, {createContext, useCallback, useContext, useEffect, useState} from 'react';
import {Contract} from 'ethcall';
import {BigNumber} from 'ethers';
import {useWeb3} from '@yearn-finance/web-lib/contexts';
import {performBatchedUpdates, providers, toAddress} from '@yearn-finance/web-lib/utils';
import {useCurve} from 'contexts/useCurve';
import {allowanceKey} from 'utils';
import CURVE_BRIBE_V2 from 'utils/abi/curveBribeV2.abi';
import CURVE_BRIBE_V3 from 'utils/abi/curveBribeV3.abi';

import type {TCurveGaugeRewards} from 'types/curves.d';

export type	TBribesContext = {
	currentRewards: TCurveGaugeRewards,
	nextRewards: TCurveGaugeRewards,
	claimable: TCurveGaugeRewards,
	currentPeriod: number,
	nextPeriod: number,
	isLoading: boolean,
	refresh: () => Promise<void>
}
const	defaultProps: TBribesContext = {
	currentRewards: {},
	nextRewards: {},
	claimable: {},
	currentPeriod: 0,
	nextPeriod: 0,
	isLoading: true,
	refresh: async (): Promise<void> => undefined
};

function	getLastThursday(): number {
	const	lastThursday = new Date();
	lastThursday.setDate(lastThursday.getDate() - ((lastThursday.getDay() + 6) % 7) - 3);
	lastThursday.setHours(-22, 0, 0, 0); // Adapt to timezone
	return Math.floor(lastThursday.getTime() / 1000);
}

const	BribesContext = createContext<TBribesContext>(defaultProps);
export const BribesContextApp = ({children}: {children: React.ReactElement}): React.ReactElement => {
	const	{gauges} = useCurve();
	const	{provider, isActive, address} = useWeb3();
	const	[currentRewards, set_currentRewards] = useState<TCurveGaugeRewards>({});
	const	[nextRewards, set_nextRewards] = useState<TCurveGaugeRewards>({});
	const	[claimable, set_claimable] = useState<TCurveGaugeRewards>({});
	const	[isLoading, set_isLoading] = useState<boolean>(true);
	const	[currentPeriod, set_currentPeriod] = useState<number>(getLastThursday());
	const	[nextPeriod, set_nextPeriod] = useState<number>(getLastThursday() + (86400 * 7));

	/* 🔵 - Yearn Finance ******************************************************
	**	getSharedStuffFromBribes will help you retrieved some elements from the
	** 	Bribe contracts, not related to the user.
	***************************************************************************/
	const	getSharedStuffFromBribes = useCallback(async (): Promise<void> => {
		const	currentProvider = provider || providers.getProvider(1);
		const	ethcallProvider = await providers.newEthCallProvider(currentProvider);
		const	curveBribeV3Contract = new Contract(process.env.CURVE_BRIBE_V3_ADDRESS as string, CURVE_BRIBE_V3);
		const	[_currentPeriod] = await ethcallProvider.tryAll([curveBribeV3Contract.current_period()]) as [number];	

		performBatchedUpdates((): void => {
			set_currentPeriod(Number(_currentPeriod));
			set_nextPeriod(Number(_currentPeriod) + (86400 * 7));
		});
	}, [provider]);
	useEffect((): void => {
		getSharedStuffFromBribes();
	}, [getSharedStuffFromBribes]);
	

	/* 🔵 - Yearn Finance ******************************************************
	**	getBribes will call the bribeV2 contract to get all the rewards
	**	per gauge.
	***************************************************************************/
	const getRewardsPerGauges = useCallback(async (contract: Contract): Promise<string[][]> => {
		if (!isActive || !provider || (gauges || []).length === 0) {
			return [];
		}
		const	currentProvider = provider || providers.getProvider(1);
		const	ethcallProvider = await providers.newEthCallProvider(currentProvider);
		const	rewardsPerGaugesCalls = [];

		for (const gauge of gauges) {
			rewardsPerGaugesCalls.push(contract.rewards_per_gauge(gauge.gauge));	
		}
		const	_rewardsPerGauges = await ethcallProvider.tryAll(rewardsPerGaugesCalls) as string[][];
		return ([..._rewardsPerGauges]);
	}, [isActive, provider, gauges]);

	/* 🔵 - Yearn Finance ******************************************************
	**	getRewardsPerUser will help you retrieved the claimable and rewards
	** 	elements from the Bribe contracts, related to the user for a specific
	** 	list of gauges/tokens.
	***************************************************************************/
	const getRewardsPerUser = useCallback(async (
		contract: Contract,
		rewardsPerGauges: string[][]
	): Promise<{rewardsList: string[], multicallResult: any[]}> => {
		if (!isActive || !provider || (rewardsPerGauges || []).length === 0) {
			return ({rewardsList: [], multicallResult: []});
		}
		const	userAddress = '0xd63042a93525f33500c3a5c0387856d5a69bd1ec' || address;
		const	currentProvider = provider || providers.getProvider(1);
		const	ethcallProvider = await providers.newEthCallProvider(currentProvider);
		const	rewardsPerTokensPerGaugesCalls = [];
		const	rewardsList: string[] = [];

		const	_rewardsPerGauges = [...rewardsPerGauges];
		for (const gauge of gauges) {
			const	rewardPerGauge = _rewardsPerGauges.shift();
			if (rewardPerGauge && rewardPerGauge.length > 0) {
				if (!gauge.rewardPerGauge) {
					gauge.rewardPerGauge = [];
				}
				gauge.rewardPerGauge.push(...rewardPerGauge);
				for (const tokenAsReward of rewardPerGauge) {
					rewardsList.push(allowanceKey(gauge.gauge, tokenAsReward));
					rewardsPerTokensPerGaugesCalls.push(...[
						contract.reward_per_token(gauge.gauge, tokenAsReward),
						contract.active_period(gauge.gauge, tokenAsReward),
						contract.claimable(userAddress, gauge.gauge, tokenAsReward)
					]);
				}
			}
		}

		const	_rewardsPerTokensPerGaugesWithPeriods = await ethcallProvider.tryAll(rewardsPerTokensPerGaugesCalls) as BigNumber[];
		return ({rewardsList, multicallResult: [..._rewardsPerTokensPerGaugesWithPeriods]});
	}, [isActive, provider, gauges, address]);

	/* 🔵 - Yearn Finance ******************************************************
	**	getNextPeriodRewards will help you retrieved the the reward_per_gauge
	** 	and the claims_per_gauge elements from the Bribe V3 contracts to be
	** 	able to calculate the next period rewards.
	***************************************************************************/
	const getNextPeriodRewards = useCallback(async (
		contract: Contract,
		rewardsPerGauges: string[][]
	): Promise<{rewardsList: string[], multicallResult: any[]}> => {
		if (!isActive || !provider || (rewardsPerGauges || []).length === 0) {
			return ({rewardsList: [], multicallResult: []});
		}
		const	currentProvider = provider || providers.getProvider(1);
		const	ethcallProvider = await providers.newEthCallProvider(currentProvider);
		const	rewardsPerTokensPerGaugesCalls = [];
		const	rewardsList: string[] = [];

		const	_rewardsPerGauges = [...rewardsPerGauges];
		for (const gauge of gauges) {
			const	rewardPerGauge = _rewardsPerGauges.shift();
			if (rewardPerGauge && rewardPerGauge.length > 0) {
				for (const tokenAsReward of rewardPerGauge) {
					rewardsList.push(allowanceKey(gauge.gauge, tokenAsReward));
					rewardsPerTokensPerGaugesCalls.push(...[
						contract.reward_per_gauge(gauge.gauge, tokenAsReward),
						contract.claims_per_gauge(gauge.gauge, tokenAsReward)
					]);
				}
			}
		}

		const	multicallResult = await ethcallProvider.tryAll(rewardsPerTokensPerGaugesCalls) as BigNumber[];
		return ({rewardsList, multicallResult: [...multicallResult]});
	}, [isActive, provider, gauges]);

	/* 🔵 - Yearn Finance ******************************************************
	**	assignBribes will save the currentRewards,  periods and clamable values
	** 	for each gauge/token to the state to be used by the UI.
	***************************************************************************/
	const assignBribes = useCallback(async (rewardsList: string[], multicallResult: any[]): Promise<void> => {
		if (!multicallResult || multicallResult.length === 0 || rewardsList.length === 0) {
			return;
		}
		const	_currentRewards: TCurveGaugeRewards = {};
		const	_claimable: TCurveGaugeRewards = {};
		const	_periods: TCurveGaugeRewards = {};
		let	rIndex = 0;
		
		for (const rewardListKey of rewardsList) {
			const	rewardPerTokenPerGauge = multicallResult[rIndex++];
			const	periodPerTokenPerGauge = multicallResult[rIndex++];
			const	claimablePerTokenPerGauge = multicallResult[rIndex++];
			if (periodPerTokenPerGauge.toNumber() >= currentPeriod) {
				if (rewardListKey && rewardPerTokenPerGauge.gt(0)) {
					const	[gauge, token] = rewardListKey.split('_');
					if (!_currentRewards[toAddress(gauge)]) {
						_currentRewards[toAddress(gauge)] = {};
					}
					if (!_periods[toAddress(gauge)]) {
						_periods[toAddress(gauge)] = {};
					}
					if (!_claimable[toAddress(gauge)]) {
						_claimable[toAddress(gauge)] = {};
					}
					_currentRewards[toAddress(gauge)][toAddress(token)] = rewardPerTokenPerGauge;
					_periods[toAddress(gauge)][toAddress(token)] = periodPerTokenPerGauge;
					_claimable[toAddress(gauge)][toAddress(token)] = claimablePerTokenPerGauge;
				}
			}
		}
		set_currentRewards(_currentRewards);
		set_claimable(_claimable);
		set_isLoading(false);
	}, [currentPeriod]);

	/* 🔵 - Yearn Finance ******************************************************
	**	assignNextRewards will save the next period rewards values for each
	**	gauge/token to the state to be used by the UI.
	***************************************************************************/
	const assignNextRewards = useCallback(async (rewardsList: string[], multicallResult: any[]): Promise<void> => {
		if (!multicallResult || multicallResult.length === 0 || rewardsList.length === 0) {
			return;
		}
		const	_nextRewards: TCurveGaugeRewards = {};
		
		let	rIndex = 0;
		for (const rewardListKey of rewardsList) {
			const	rewardPerTokenPerGauge = multicallResult[rIndex++];
			const	claimsPerTokenPerGauge = multicallResult[rIndex++];
			if (rewardListKey) {
				const	[gauge, token] = rewardListKey.split('_');
				if (!_nextRewards[toAddress(gauge)]) {
					_nextRewards[toAddress(gauge)] = {};
				}
				const	pendingForNextPeriod = rewardPerTokenPerGauge.sub(claimsPerTokenPerGauge);
				_nextRewards[toAddress(gauge)][toAddress(token)] = pendingForNextPeriod;
			}
		}
		set_nextRewards(_nextRewards);
	}, []);

	/* 🔵 - Yearn Finance ******************************************************
	**	getBribes will start the process to retrieve the bribe information.
	***************************************************************************/
	const	getBribes = useCallback(async (): Promise<void> => {
		const	curveBribeV2Contract = new Contract(process.env.CURVE_BRIBE_V2_ADDRESS as string, CURVE_BRIBE_V2);
		const	curveBribeV3Contract = new Contract(process.env.CURVE_BRIBE_V3_ADDRESS as string, CURVE_BRIBE_V3);

		const	[rewardsPerGaugesV2, rewardsPerGaugesV3] = await Promise.all([
			getRewardsPerGauges(curveBribeV2Contract),
			getRewardsPerGauges(curveBribeV3Contract)
		]);
		const	[rewardsPerUserV2, rewardsPerUserV3, nextPeriodRewardsV3] = await Promise.all([
			getRewardsPerUser(curveBribeV2Contract, rewardsPerGaugesV2),
			getRewardsPerUser(curveBribeV2Contract, rewardsPerGaugesV3),
			getNextPeriodRewards(curveBribeV3Contract, rewardsPerGaugesV3)
		]);


		const	{rewardsList: rewardsListV2, multicallResult: multicallResultV2} = rewardsPerUserV2;
		const	{rewardsList: rewardsListV3, multicallResult: multicallResultV3} = rewardsPerUserV3;
		const	{rewardsList: nextRewardsListV3, multicallResult: nextMulticallResultV3} = nextPeriodRewardsV3;
		performBatchedUpdates((): void => {
			assignBribes(
				[...rewardsListV2, ...rewardsListV3],
				[...multicallResultV2, ...multicallResultV3]
			);
			assignNextRewards(nextRewardsListV3, nextMulticallResultV3);
		});
	}, [getRewardsPerGauges, getRewardsPerUser, getNextPeriodRewards, assignBribes, assignNextRewards]);
	useEffect((): void => {
		getBribes();
	}, [getBribes]);


	/* 🔵 - Yearn Finance ******************************************************
	**	Setup and render the Context provider to use in the app.
	***************************************************************************/
	return (
		<BribesContext.Provider
			value={{
				currentRewards: currentRewards || {},
				nextRewards: nextRewards || {},
				claimable: claimable || {},
				isLoading: isLoading,
				currentPeriod,
				nextPeriod,
				refresh: async (): Promise<void> => {
					await getBribes();
				}
			}}>
			{children}
		</BribesContext.Provider>
	);
};


export const useBribes = (): TBribesContext => useContext(BribesContext);
export default useBribes;