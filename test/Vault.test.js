require('chai').should();

const Web3 = require('web3');
const {expect} = require('chai');
const {expectRevert, BN, ether, time} = require('@openzeppelin/test-helpers');
const {deployProxy, upgradeProxy} = require('@openzeppelin/truffle-upgrades');
const {ZERO_ADDRESS} = require('@openzeppelin/test-helpers/src/constants');
const {PRIVATE_KEY} = require('../secrets.test.json');
const {signTypedData_v4} = require('eth-sig-util');

const LacToken = artifacts.require('LacToken');
const Vault = artifacts.require('Vault');
const BlockData = artifacts.require('BlockData');
const SampleToken = artifacts.require('SampleToken');

const name = 'Vault';
const version = '1.0.0';

function getReceiverShare(perBlockAmount, receiverShare, totalShare, totalBlocks) {
	return perBlockAmount.mul(totalBlocks).mul(receiverShare).div(totalShare);
}

function weiToEth(Value) {
	return Value.div(ether('1'));
}

async function createSignature(
	pk,
	userAddress,
	claimAmount,
	nonceValue,
	receiverAddress,
	referenceNumberValue,
	contractAddress,
	chainId
) {
	const typedMessage = {
		data: {
			types: {
				EIP712Domain: [
					{name: 'name', type: 'string'},
					{name: 'version', type: 'string'},
					{name: 'chainId', type: 'uint256'},
					{name: 'verifyingContract', type: 'address'}
				],
				Claim: [
					{name: 'account', type: 'address'},
					{name: 'amount', type: 'uint256'},
					{name: 'receiver', type: 'address'},
					{name: 'nonce', type: 'uint256'},
					{name: 'referenceNumber', type: 'uint256'}
				]
			},
			domain: {
				name,
				version,
				chainId,
				verifyingContract: contractAddress
			},
			primaryType: 'Claim',
			message: {
				account: userAddress,
				amount: claimAmount,
				receiver: receiverAddress,
				nonce: nonceValue,
				referenceNumber: referenceNumberValue
			}
		}
	};

	signature = await signTypedData_v4(pk, typedMessage);
	return signature;
}

contract('Vault', (accounts) => {
	const owner = accounts[0];
	const minter = accounts[1];
	const user1 = accounts[2];
	const user2 = accounts[3];
	const user3 = accounts[4];
	const receiver1 = accounts[5];
	const receiver2 = accounts[6];
	const receiver3 = accounts[7];
	const vaultKeeper = accounts[8];
	const blocksPerWeek = Number(time.duration.hours('1')) / 3;
	let currentPerBlockAmount;
	before('deploy contract', async () => {
		// deploy LAC token
		this.LacToken = await LacToken.new('Lacucina Token', 'LAC', minter, ether('500000000'));

		// deploy Sample token
		this.SampleToken = await SampleToken.new();

		// deploy Vault
		this.Vault = await deployProxy(Vault, [
			'Vault',
			this.LacToken.address,
			ether('100000'),
			ether('1000000'),
			500, // 5%
			blocksPerWeek, // 1 hours = 1200 blocks
			blocksPerWeek // 1 hours = 1200 blocks
		]);
		// 1 - 1200/
		// mint LAC tokens to minter
		this.web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:8555'));

		// add account
		await this.web3.eth.accounts.wallet.add('0x' + PRIVATE_KEY);
		this.pk = Buffer.from(PRIVATE_KEY, 'hex');

		this.BlockData = await BlockData.new();
		this.chainId = await this.BlockData.getChainId();
	});

	describe('initialize()', () => {
		it('should initialize vault correctly', async () => {
			const lacTokenAddress = await this.Vault.LacToken();
			const startBlock = await this.Vault.startBlock();
			const currentReleaseRatePerPeriod = await this.Vault.currentReleaseRatePerPeriod();
			const currentReleaseRatePerBlock = await this.Vault.currentReleaseRatePerBlock();
			const maxReleaseRatePerPeriod = await this.Vault.maxReleaseRatePerPeriod();
			const increasePercentage = await this.Vault.increasePercentage();
			const increaseRateAfterPeriods = await this.Vault.increaseRateAfterPeriods();
			const lastFundUpdatedBlock = await this.Vault.lastFundUpdatedBlock();
			const totalBlocksPerWeek = await this.Vault.totalBlocksPerPeriod();

			console.log('currentReleaseRatePerBlock: ', currentReleaseRatePerBlock.toString());
			expect(lacTokenAddress).to.be.eq(this.LacToken.address);

			expect(startBlock).to.bignumber.be.gt(new BN('0'));
			expect(currentReleaseRatePerPeriod).to.bignumber.be.eq(ether('100000'));
			expect(currentReleaseRatePerBlock).to.bignumber.be.eq(new BN('83333333333333333333'));
			expect(maxReleaseRatePerPeriod).to.bignumber.be.eq(ether('1000000'));
			expect(increasePercentage).to.bignumber.be.eq(new BN('500'));
			expect(increaseRateAfterPeriods).to.bignumber.be.eq(
				new BN(new BN(Number(time.duration.hours(1).toString()) / 3))
			);
			expect(lastFundUpdatedBlock).to.bignumber.be.eq(startBlock);
			expect(totalBlocksPerWeek).to.bignumber.be.eq(
				new BN(Number(time.duration.hours(1).toString()) / 3)
			);

			currentPerBlockAmount = currentReleaseRatePerBlock;
		});
	});

	describe('addFundReceiverAddress()', () => {
		before('add fundReceiver', async () => {
			// grant vaultKeeper role
			const VAULT_KEEPER = await this.Vault.VAULT_KEEPER();
			await this.Vault.grantRole(VAULT_KEEPER, vaultKeeper, {from: owner});

			// add fund receiver1
			await this.Vault.addFundReceiverAddress(receiver1, 9000, {from: owner});
			await this.Vault.addFundReceiverAddress(receiver2, 1000, {from: owner});
		});

		it('should add fund receivers correctly', async () => {
			const fundReceiver1 = await this.Vault.fundReceiversList(0);
			const fundReceiver2 = await this.Vault.fundReceiversList(1);

			const fundReceiver1Details = await this.Vault.fundReceivers(receiver1);
			const fundReceiver2Details = await this.Vault.fundReceivers(receiver2);

			const receiver1Share = await this.Vault.getFundReceiverShare(receiver1);
			const receiver2Share = await this.Vault.getFundReceiverShare(receiver2);
			const totalShares = await this.Vault.totalShares();
			const totalReceivers = await this.Vault.getTotalFundReceivers();

			expect(fundReceiver1).to.be.eq(receiver1);
			expect(fundReceiver2).to.be.eq(receiver2);

			expect(fundReceiver1Details.lacShare).to.bignumber.be.eq(new BN('9000'));
			expect(fundReceiver1Details.totalAccumulatedFunds).to.bignumber.be.eq(
				new BN('83333333333333333333')
			);

			expect(fundReceiver2Details.lacShare).to.bignumber.be.eq(new BN('1000'));
			expect(fundReceiver2Details.totalAccumulatedFunds).to.bignumber.be.eq(new BN('0'));

			expect(receiver1Share).to.bignumber.be.eq(new BN('900000000000'));
			expect(receiver2Share).to.bignumber.be.eq(new BN('100000000000'));
			expect(totalShares).to.bignumber.be.eq(new BN('10000'));
			expect(totalReceivers).to.bignumber.be.eq(new BN('2'));
		});

		it('should revert when non-admin tries to add the fund receiver', async () => {
			await expectRevert(
				this.Vault.addFundReceiverAddress(receiver3, 1000, {from: minter}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when admin tries to add the zero address as fund receiver', async () => {
			await expectRevert(
				this.Vault.addFundReceiverAddress(ZERO_ADDRESS, 1000, {from: owner}),
				'LacTokenUtils: CANNOT_ADD_ZERO_ADDRESS'
			);
		});

		it('should revert when admin tries to add the already existing fund receiver', async () => {
			await expectRevert(
				this.Vault.addFundReceiverAddress(receiver1, 1000, {from: owner}),
				'LacTokenUtils: ADDRESS_ALREADY_EXISTS'
			);
		});

		it('should allocate funds correctly when new receiver is added', async () => {
			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			const currentBlock = await this.BlockData.getBlock();
			//increase time by 3 blocks per day = 28800 Number(57600)
			await time.advanceBlockTo(Number(currentBlock.toString()) + Number(3));

			const fundReceiver1Details = await this.Vault.fundReceivers(receiver1);
			const fundReceiver2Details = await this.Vault.fundReceivers(receiver2);

			const receiver1Pendings = await this.Vault.getPendingAccumulatedFunds(receiver1);
			const receiver2Pendings = await this.Vault.getPendingAccumulatedFunds(receiver2);

			// // add third fund receiver
			await this.Vault.shrinkReceiver(receiver1, receiver3, 1000, {from: owner});

			const receiver1PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver1);
			const receiver2PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver2);

			const fundReceiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			const fundReceiver2DetailsAfter = await this.Vault.fundReceivers(receiver2);
			const fundReceiver3DetailsAfter = await this.Vault.fundReceivers(receiver3);

			const totalShares = await this.Vault.totalShares();

			const receiver1Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('9000'),
				new BN('10000'),
				new BN('1')
			);
			const receiver2Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('1000'),
				new BN('10000'),
				new BN('1')
			);

			expect(fundReceiver1DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				fundReceiver1Details.totalAccumulatedFunds.add(receiver1Pendings).add(receiver1Share)
			);

			expect(fundReceiver2DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				fundReceiver2Details.totalAccumulatedFunds
					.add(receiver2Pendings)
					.add(receiver2Share)
					.add(new BN('1'))
			);

			expect(fundReceiver3DetailsAfter.lacShare).to.bignumber.be.eq(new BN('1000'));
			expect(fundReceiver3DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(new BN('0'));

			expect(receiver1PendingsAfter).to.bignumber.be.eq(new BN('0'));
			expect(receiver2PendingsAfter).to.bignumber.be.eq(new BN('0'));

			expect(totalShares).to.bignumber.be.eq(new BN('10000'));
		});
	});

	describe('removeFundReceiverAddress()', () => {
		let totalRecieversBefore;
		let receiver1Pendings;
		let receiver2Pendings;
		let receiver3Pendings;
		let fundReceiver1Details;
		let fundReceiver2Details;
		let fundReceiver3Details;

		before('remove fund receiver', async () => {
			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			fundReceiver1Details = await this.Vault.fundReceivers(receiver1);
			fundReceiver2Details = await this.Vault.fundReceivers(receiver2);
			fundReceiver3Details = await this.Vault.fundReceivers(receiver3);

			totalRecieversBefore = await this.Vault.getTotalFundReceivers();

			// remove receiver3
			await this.Vault.removeFundReceiverAddress(receiver3, {from: owner});
		});

		it('should remove the fundReceiver correctly', async () => {
			const totalReceivers = await this.Vault.getTotalFundReceivers();
			const totalShare = await this.Vault.totalShares();

			const fundReceiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			const fundReceiver2DetailsAfter = await this.Vault.fundReceivers(receiver2);
			const fundReceiver3DetailsAfter = await this.Vault.fundReceivers(receiver3);

			const receiver1Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('8000'),
				new BN('10000'),
				new BN('1')
			);
			const receiver2Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('1000'),
				new BN('10000'),
				new BN('1')
			);
			const receiver3hare = getReceiverShare(
				currentPerBlockAmount,
				new BN('1000'),
				new BN('10000'),
				new BN('1')
			);

			expect(totalRecieversBefore).to.bignumber.be.eq(new BN('3'));
			expect(totalReceivers).to.bignumber.be.eq(new BN('2'));
			expect(totalShare).to.bignumber.be.eq(new BN('9000'));

			expect(fundReceiver1DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				fundReceiver1Details.totalAccumulatedFunds.add(receiver1Share)
			);

			expect(fundReceiver2DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				fundReceiver2Details.totalAccumulatedFunds.add(receiver2Share)
			);
			expect(fundReceiver3DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(new BN('0'));
			expect(fundReceiver3DetailsAfter.lacShare).to.bignumber.be.eq(new BN('0'));

			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			expect(fundReceiver3Details.totalAccumulatedFunds).to.bignumber.be.eq(receiver3hare);
			expect(fundReceiver1DetailsAfter.lacShare).to.bignumber.be.eq(new BN('8000'));

			const receiver1PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver1);
			const receiver2PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver2);

			expect(receiver1PendingsAfter).to.bignumber.be.eq(new BN('0'));
			expect(receiver2PendingsAfter).to.bignumber.be.eq(new BN('0'));
		});

		it('should revert when non-admin tries remove the fund receiver address', async () => {
			await expectRevert(
				this.Vault.removeFundReceiverAddress(receiver3, {from: minter}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when admin tries remove the fund receiver address which already removed', async () => {
			await expectRevert(
				this.Vault.removeFundReceiverAddress(receiver3, {from: owner}),
				'LacTokenUtils: ITEM_DOES_NOT_EXISTS'
			);
		});
	});

	describe('updateReceiverShare()', () => {
		let receiver1DetailsBefore;
		let receiver1DetailsAfter;
		let totalSharesBefore;
		let totalSharesAfter;

		it('should decrease the receiver`s share correctly', async () => {
			receiver1DetailsBefore = await this.Vault.fundReceivers(receiver1);
			totalSharesBefore = await this.Vault.totalShares();

			// update receiver1` share
			await this.Vault.updateReceiverShare(receiver1, new BN('7000'), {from: owner});

			receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			totalSharesAfter = await this.Vault.totalShares();

			expect(receiver1DetailsBefore.lacShare).to.bignumber.be.eq(new BN('8000'));
			expect(receiver1DetailsAfter.lacShare).to.bignumber.be.eq(new BN('7000'));
			expect(totalSharesBefore).to.bignumber.be.eq(new BN('9000'));
			expect(totalSharesAfter).to.bignumber.be.eq(new BN('8000'));
		});

		it('should increase the receiver`s share correctly', async () => {
			receiver1DetailsBefore = await this.Vault.fundReceivers(receiver1);
			totalSharesBefore = await this.Vault.totalShares();

			// update receiver1` share
			await this.Vault.updateReceiverShare(receiver1, new BN('9000'), {from: owner});

			receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			totalSharesAfter = await this.Vault.totalShares();

			expect(receiver1DetailsBefore.lacShare).to.bignumber.be.eq(new BN('7000'));
			expect(receiver1DetailsAfter.lacShare).to.bignumber.be.eq(new BN('9000'));
			expect(totalSharesBefore).to.bignumber.be.eq(new BN('8000'));
			expect(totalSharesAfter).to.bignumber.be.eq(new BN('10000'));
		});

		it('should revert when non-owner tries to update the fundreceiver`s share', async () => {
			await expectRevert(
				this.Vault.updateReceiverShare(receiver1, new BN('7000'), {from: minter}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});
		it('should revert when owner tries to update the fundreceiver`s share with already set value', async () => {
			await expectRevert(
				this.Vault.updateReceiverShare(receiver1, new BN('9000'), {from: owner}),
				'Vault: INVALID_SHARE'
			);
			await expectRevert(
				this.Vault.updateReceiverShare(receiver1, new BN('0'), {from: owner}),
				'Vault: INVALID_SHARE'
			);
		});

		it('should revert when owner tries to update the non-existant fundreceiver`s share', async () => {
			await expectRevert(
				this.Vault.updateReceiverShare(receiver3, new BN('7000'), {from: owner}),
				'Vault: RECEIVER_DOES_NOT_EXISTS'
			);
		});
	});

	describe('shrinkReceiver()', () => {
		let receiver1DetailsBefore;
		let receiver1DetailsAfter;
		let receiver3DetailsBefore;
		let receiver3DetailsAfter;
		let totalSharesBefore;
		let totalSharesAfter;
		it('should shrink receiver correctly', async () => {
			receiver1DetailsBefore = await this.Vault.fundReceivers(receiver1);
			receiver3DetailsBefore = await this.Vault.fundReceivers(receiver3);
			totalSharesBefore = await this.Vault.totalShares();

			// shrink receiver
			await this.Vault.shrinkReceiver(receiver1, receiver3, new BN('1000'), {from: owner});

			receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			receiver3DetailsAfter = await this.Vault.fundReceivers(receiver3);
			totalSharesAfter = await this.Vault.totalShares();

			const totalReceivers = await this.Vault.getTotalFundReceivers();

			expect(totalReceivers).to.bignumber.be.eq(new BN('3'));
			expect(receiver1DetailsBefore.lacShare).to.bignumber.be.eq(new BN('9000'));
			expect(receiver1DetailsAfter.lacShare).to.bignumber.be.eq(new BN('8000'));
			expect(receiver3DetailsBefore.lacShare).to.bignumber.be.eq(new BN('0'));
			expect(receiver3DetailsAfter.lacShare).to.bignumber.be.eq(new BN('1000'));

			expect(totalSharesBefore).to.bignumber.be.eq(new BN('10000'));
			expect(totalSharesAfter).to.bignumber.be.eq(new BN('10000'));
		});

		it('should revert when non-owner tries to shrink fund receiver', async () => {
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, receiver3, new BN('1000'), {from: user1}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when owner tries to shrink non-existing receiver', async () => {
			await expectRevert(
				this.Vault.shrinkReceiver(minter, receiver3, new BN('1000'), {from: owner}),
				'Vault: RECEIVER_DOES_NOT_EXISTS'
			);
		});

		it('should revert when owner tries to shrink existing receiver with invalid share', async () => {
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, receiver3, new BN('10000'), {from: owner}),
				'Vault: INVALID_SHARE'
			);
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, receiver3, new BN('8000'), {from: owner}),
				'Vault: INVALID_SHARE'
			);
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, receiver3, new BN('0'), {from: owner}),
				'Vault: INVALID_SHARE'
			);
		});

		it('should revert when owner tries to shrink receiver to add already existing receiver', async () => {
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, receiver3, new BN('5000'), {from: owner}),
				'LacTokenUtils: ADDRESS_ALREADY_EXISTS'
			);
		});

		it('should revert when owner tries to shrink receiver to add zero address as receiver', async () => {
			await expectRevert(
				this.Vault.shrinkReceiver(receiver1, ZERO_ADDRESS, new BN('5000'), {from: owner}),
				'LacTokenUtils: CANNOT_ADD_ZERO_ADDRESS'
			);
		});
	});

	describe('claim()', () => {
		let currentNonce;
		before(async () => {
			const VAULT_KEEPER = await this.Vault.VAULT_KEEPER();
			await this.Vault.grantRole(VAULT_KEEPER, receiver1);
			await this.Vault.grantRole(VAULT_KEEPER, receiver2);
			await this.Vault.grantRole(VAULT_KEEPER, receiver3);

			await this.Vault.grantRole(VAULT_KEEPER, '0x0055f67515c252860fe9b27f6903d44fcfc3a727');

			// get current nonce of user
			currentNonce = await this.Vault.userNonce(user1);
		});

		it('should allow user to claim', async () => {
			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			const receiver1Details = await this.Vault.fundReceivers(receiver1);

			// transfer lac tokens to Vault
			await this.LacToken.transfer(this.Vault.address, receiver1Details.totalAccumulatedFunds, {
				from: minter
			});

			signature = await createSignature(
				this.pk,
				user1,
				receiver1Details.totalAccumulatedFunds,
				currentNonce,
				receiver1,
				5,
				this.Vault.address,
				this.chainId
			);

			const user1Bal = await this.LacToken.balanceOf(user1);

			const receiver1Pendings = await this.Vault.getPendingAccumulatedFunds(receiver1);

			//claim tokens
			await this.Vault.claim(receiver1Details.totalAccumulatedFunds, receiver1, 5, signature, {
				from: user1
			});

			const receiver1Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('8000'),
				new BN('10000'),
				new BN('2')
			);

			const user1BalAfter = await this.LacToken.balanceOf(user1);
			const receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			const nonceAfter = await this.Vault.userNonce(user1);

			expect(currentNonce).to.bignumber.be.eq(new BN('0'));
			expect(nonceAfter).to.bignumber.be.eq(new BN('1'));
			expect(user1Bal).to.bignumber.be.eq(new BN('0'));
			expect(user1BalAfter).to.bignumber.be.eq(receiver1Details.totalAccumulatedFunds);
			expect(receiver1DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(receiver1Share);
		});

		it('should revert when user tries to claim more amount that receiver accumulated', async () => {
			// update allocated funds
			await this.Vault.updateAllocatedFunds();

			// transfer lac tokens to Vault
			await this.LacToken.transfer(this.Vault.address, ether('50000000'), {
				from: minter
			});

			//stash user1 lac tokens
			await this.LacToken.transfer(accounts[9], await this.LacToken.balanceOf(user1), {
				from: user1
			});
			const nonceAfter = await this.Vault.userNonce(user1);

			signature = await createSignature(
				this.pk,
				user1,
				ether('250'),
				nonceAfter,
				receiver1,
				6,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('500'), receiver1, 6, signature, {
					from: user1
				}),
				'Vault: INSUFFICIENT_AMOUNT'
			);
		});

		it('should revert when user tries to claim zero tokens', async () => {
			signature = await createSignature(
				this.pk,
				user1,
				ether('0'),
				currentNonce,
				receiver1,
				7,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0'), receiver1, 7, signature, {
					from: user1
				}),
				'Vault: INSUFFICIENT_AMOUNT'
			);
		});

		it('should revert when user tries to claim tokens from invalid receiver', async () => {
			signature = await createSignature(
				this.pk,
				user1,
				ether('1'),
				currentNonce,
				user2,
				8,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('1'), user2, 8, signature, {
					from: user1
				}),
				'Vault: RECEIVER_DOES_NOT_EXISTS'
			);
		});

		it('should revert when param value mismatches with signature value', async () => {
			signature = await createSignature(
				this.pk,
				user1,
				ether('2'),
				currentNonce,
				receiver1,
				9,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 9, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			signature = await createSignature(
				this.pk,
				user2,
				ether('0.1'),
				currentNonce,
				receiver1,
				5,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 5, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver2,
				6,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 6, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver1,
				7,
				this.BlockData.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 7, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver1,
				8,
				this.Vault.address,
				new BN('111')
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 8, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver1,
				8,
				this.Vault.address,
				new BN('111')
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 9, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);
		});

		it('should revert when another user tries to reuse the signature', async () => {
			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver1,
				8,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 8, signature, {
					from: user2
				}),
				'Vault: INVALID_SIGNATURE'
			);
		});

		it('should revert when user tries to reuse the signature with old nonce value', async () => {
			signature = await createSignature(
				this.pk,
				user1,
				ether('0.1'),
				currentNonce,
				receiver1,
				9,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await expectRevert(
				this.Vault.claim(ether('0.1'), receiver1, 9, signature, {
					from: user1
				}),
				'Vault: INVALID_SIGNATURE'
			);

			// should be able to claim with latest nonce
			currentNonce = await this.Vault.userNonce(user1);

			signature = await createSignature(
				this.pk,
				user1,
				ether('0.2'),
				currentNonce,
				receiver1,
				3,
				this.Vault.address,
				this.chainId
			);

			//claim tokens
			await this.Vault.claim(ether('0.2'), receiver1, 3, signature, {
				from: user1
			});

			const nonceAfter = await this.Vault.userNonce(user1);
			expect(nonceAfter).to.bignumber.be.eq(new BN('2'));
		});
	});

	describe('updateAllocatedFunds()', () => {
		let receiver1Pendings;
		let receiver2Pendings;
		let receiver3Pendings;
		let receiver1PendingsAfter;
		let receiver2PendingsAfter;
		let receiver3PendingsAfter;

		let receiver1Details;
		let receiver2Details;
		let receiver3Details;
		let receiver1DetailsAfter;
		let receiver2DetailsAfter;
		let receiver3DetailsAfter;
		it('it should update the allocated funds correctly', async () => {
			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			const lastFundUpdatedBlock = await this.Vault.lastFundUpdatedBlock();

			receiver1Details = await this.Vault.fundReceivers(receiver1);
			receiver2Details = await this.Vault.fundReceivers(receiver2);
			receiver3Details = await this.Vault.fundReceivers(receiver3);

			const currentBlock = await this.BlockData.getBlock();
			//get total blocks after last update
			const totalBlocks = new BN(5); //new BN(new BN(time.duration.hours('1')).div(new BN('3')));

			//increase time by 5 blocks,  per day = 28800 Number(57600)
			await time.advanceBlockTo(currentBlock.add(totalBlocks));

			receiver1Pendings = await this.Vault.getPendingAccumulatedFunds(receiver1);
			receiver2Pendings = await this.Vault.getPendingAccumulatedFunds(receiver2);
			receiver3Pendings = await this.Vault.getPendingAccumulatedFunds(receiver3);

			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			const lastFundUpdatedBlockAfter = await this.Vault.lastFundUpdatedBlock();

			receiver1PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver1);
			receiver2PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver2);
			receiver3PendingsAfter = await this.Vault.getPendingAccumulatedFunds(receiver3);

			receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			receiver2DetailsAfter = await this.Vault.fundReceivers(receiver2);
			receiver3DetailsAfter = await this.Vault.fundReceivers(receiver3);

			const receiver1Share = getReceiverShare(
				currentPerBlockAmount,
				receiver1Details.lacShare,
				new BN('10000'),
				totalBlocks
			);
			const receiver2Share = getReceiverShare(
				currentPerBlockAmount,
				receiver2Details.lacShare,
				new BN('10000'),
				totalBlocks
			);
			const receiver3Share = getReceiverShare(
				currentPerBlockAmount,
				receiver3Details.lacShare,
				new BN('10000'),
				totalBlocks
			);

			const receiver1PerBlockShare = getReceiverShare(
				currentPerBlockAmount,
				receiver1Details.lacShare,
				new BN('10000'),
				new BN('1')
			);
			const receiver2PerBlockShare = getReceiverShare(
				currentPerBlockAmount,
				receiver2Details.lacShare,
				new BN('10000'),
				new BN('1')
			);
			const receiver3PerBlockShare = getReceiverShare(
				currentPerBlockAmount,
				receiver3Details.lacShare,
				new BN('10000'),
				new BN('1')
			);

			expect(lastFundUpdatedBlock).to.bignumber.be.eq(currentBlock);

			expect(lastFundUpdatedBlockAfter).to.bignumber.be.eq(
				currentBlock.add(totalBlocks).add(new BN('1'))
			);

			expect(receiver1Pendings).to.bignumber.be.eq(receiver1Share);
			expect(receiver2Pendings).to.bignumber.be.eq(receiver2Share);
			expect(receiver3Pendings).to.bignumber.be.eq(receiver3Share);

			expect(receiver1Details.totalAccumulatedFunds).to.bignumber.be.gt(new BN('0'));
			expect(receiver2Details.totalAccumulatedFunds).to.bignumber.be.gt(new BN('0'));
			expect(receiver3Details.totalAccumulatedFunds).to.bignumber.be.gt(new BN('0'));

			expect(receiver1PendingsAfter).to.bignumber.be.eq(new BN('0'));
			expect(receiver2PendingsAfter).to.bignumber.be.eq(new BN('0'));
			expect(receiver3PendingsAfter).to.bignumber.be.eq(new BN('0'));

			expect(receiver1DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				receiver1Details.totalAccumulatedFunds.add(receiver1Pendings).add(receiver1PerBlockShare)
			);
			expect(receiver2DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				receiver2Details.totalAccumulatedFunds.add(receiver2Pendings).add(receiver2PerBlockShare)
			);
			expect(receiver3DetailsAfter.totalAccumulatedFunds).to.bignumber.be.eq(
				receiver3Details.totalAccumulatedFunds.add(receiver3Pendings).add(receiver3PerBlockShare)
			);
		});

		it('should update the release rates correctly once the period is completed', async () => {
			const currentReleaseRatePerPeriod = await this.Vault.currentReleaseRatePerPeriod();
			const currentReleaseRatePerBlock = await this.Vault.currentReleaseRatePerBlock();
			const startBlock = await this.Vault.startBlock();
			const currentBlock = await this.BlockData.getBlock();
			const totalBlocks = new BN(time.duration.hours('2') / 3);

			console.log(
				'currentReleaseRatePerPeriod: ',
				weiToEth(currentReleaseRatePerPeriod).toString()
			);
			console.log('currentReleaseRatePerBlock: ', weiToEth(currentReleaseRatePerBlock).toString());

			console.log('currentBlock: ', currentBlock.toString());
			console.log('startBlock: ', startBlock.toString());

			const receiver1Details = await this.Vault.fundReceivers(receiver1);
			const receiver2Details = await this.Vault.fundReceivers(receiver2);
			const receiver3Details = await this.Vault.fundReceivers(receiver3);

			console.log(
				'receiver1Details: ',
				weiToEth(receiver1Details.totalAccumulatedFunds).toString()
			);
			console.log(
				'receiver2Details: ',
				weiToEth(receiver2Details.totalAccumulatedFunds).toString()
			);
			console.log(
				'receiver3Details: ',
				weiToEth(receiver3Details.totalAccumulatedFunds).toString()
			);

			// increase by 1205 blocks
			// complete one period by increasing time. 3 hours are already passed
			await time.advanceBlockTo(currentBlock.add(totalBlocks).add(new BN('5')));

			const currentBlock1 = await this.BlockData.getBlock();
			console.log('currentBlock1: ', currentBlock1.toString());

			// update allocated funds
			await this.Vault.updateAllocatedFunds();

			// 1270 - 69 / 1200
			const currentReleaseRatePerPeriodAfter = await this.Vault.currentReleaseRatePerPeriod();
			const currentReleaseRatePerBlockAfter = await this.Vault.currentReleaseRatePerBlock();

			console.log(
				'currentReleaseRatePerPeriodAfter: ',
				weiToEth(currentReleaseRatePerPeriodAfter).toString()
			);

			console.log(
				'currentReleaseRatePerBlockAfter: ',
				weiToEth(currentReleaseRatePerBlockAfter).toString()
			);

			const startBlockAfter = await this.Vault.startBlock();
			console.log('startBlockAfter: ', startBlockAfter.toString());

			const lastFundUpdatedBlockAfter = await this.Vault.lastFundUpdatedBlock();
			console.log('lastFundUpdatedBlockAfter: ', lastFundUpdatedBlockAfter.toString());

			const receiver1DetailsAfter = await this.Vault.fundReceivers(receiver1);
			const receiver2DetailsAfter = await this.Vault.fundReceivers(receiver2);
			const receiver3DetailsAfter = await this.Vault.fundReceivers(receiver3);

			console.log(
				'receiver1DetailsAfter: ',
				weiToEth(receiver1DetailsAfter.totalAccumulatedFunds).toString()
			);
			console.log(
				'receiver2DetailsAfter: ',
				weiToEth(receiver2DetailsAfter.totalAccumulatedFunds).toString()
			);
			console.log(
				'receiver3DetailsAfter: ',
				weiToEth(receiver3DetailsAfter.totalAccumulatedFunds).toString()
			);

			// increase currentReleaseRatePerPeriod amount by this amount
			const increaseAmount = currentReleaseRatePerPeriod.mul(new BN('500')).div(new BN('10000'));

			expect(currentReleaseRatePerPeriod).to.bignumber.be.eq(ether('100000'));
			expect(currentReleaseRatePerBlock).to.bignumber.be.eq(
				currentReleaseRatePerPeriod.div(new BN(time.duration.hours('1').div(new BN('3'))))
			);
			expect(startBlock).to.bignumber.be.gt(new BN('0'));

			expect(currentReleaseRatePerPeriodAfter).to.bignumber.be.eq(ether('110250'));
			expect(currentReleaseRatePerBlockAfter).to.bignumber.be.eq(ether('91.875'));
			expect(startBlockAfter).to.bignumber.be.eq(new BN('2409'));
		});

		it('should reach the maxReleaseRatePerWeek on time correctly', async () => {
			let currentReleaseRatePerPeriod = await this.Vault.currentReleaseRatePerPeriod();
			let maxReleaseRatePerPeriod = await this.Vault.maxReleaseRatePerPeriod();

			// 	let noOfWeeks = 0;
			// while (!currentReleaseRatePerPeriod.eq(maxReleaseRatePerPeriod)) {
			// 	await time.increase(time.duration.hours('1'));

			// 	// await updateAllocated funds
			// 	await this.Vault.updateAllocatedFunds();

			// 	currentReleaseRatePerPeriod = await this.Vault.currentReleaseRatePerPeriod();
			// 	maxReleaseRatePerPeriod = await this.Vault.maxReleaseRatePerPeriod();

			// 	noOfWeeks++;
			// }
			// // 46 hours required to reach max release rate
			// console.log('Total no of hours: ', noOfWeeks.toString());

			const startBlock = await this.Vault.startBlock();
			const currentBlock = await this.BlockData.getBlock();
			const totalBlocks = new BN(time.duration.hours('46') / 3);

			// increase time
			await time.advanceBlockTo(currentBlock.add(totalBlocks));
			// await updateAllocated funds
			await this.Vault.updateAllocatedFunds();

			const currentReleaseRatePerPeriodAfter = await this.Vault.currentReleaseRatePerPeriod();
			const maxReleaseRatePerPeriodAfter = await this.Vault.maxReleaseRatePerPeriod();

			const currentReleaseRatePerBlock = await this.Vault.currentReleaseRatePerBlock();

			const startBlockAfter = await this.Vault.startBlock();

			expect(startBlockAfter).to.bignumber.be.eq(
				startBlock.add(new BN(time.duration.hours('46') / 3))
			);

			expect(currentReleaseRatePerPeriodAfter).to.bignumber.be.eq(maxReleaseRatePerPeriodAfter);
			expect(maxReleaseRatePerPeriodAfter).to.bignumber.be.eq(ether('1000000'));
			expect(currentReleaseRatePerBlock).to.bignumber.be.eq(
				maxReleaseRatePerPeriodAfter.div(new BN(time.duration.hours('1') / 3))
			);
		});

		it('should not increase the currentReleaseRatePerPeriod after maxReleaRatePerWeek reaches', async () => {
			const currentReleaseRatePerPeriod = await this.Vault.currentReleaseRatePerPeriod();
			const maxReleaseRatePerPeriod = await this.Vault.maxReleaseRatePerPeriod();
			const currentReleaseRatePerBlock = await this.Vault.currentReleaseRatePerBlock();

			const currentBlock = await this.BlockData.getBlock();
			const totalBlocks = new BN(time.duration.hours('1') / 3);

			// increase time
			await time.advanceBlockTo(currentBlock.add(totalBlocks));

			// update accumulated funds
			await this.Vault.updateAllocatedFunds();

			const currentReleaseRatePerPeriodAfter = await this.Vault.currentReleaseRatePerPeriod();
			const maxReleaseRatePerPeriodAfter = await this.Vault.maxReleaseRatePerPeriod();
			const currentReleaseRatePerBlockAfter = await this.Vault.currentReleaseRatePerBlock();

			expect(currentReleaseRatePerPeriod).to.bignumber.be.eq(currentReleaseRatePerPeriodAfter);
			expect(maxReleaseRatePerPeriod).to.bignumber.be.eq(maxReleaseRatePerPeriodAfter);
			expect(currentReleaseRatePerBlock).to.bignumber.be.eq(currentReleaseRatePerBlockAfter);
		});
	});

	describe('updateMaxReleaseRatePerPeriod()', async () => {
		it('should update the maxReleaseRatePerPeriod correctly', async () => {
			const maxReleaseRatePerPeriod = await this.Vault.maxReleaseRatePerPeriod();

			//update max release rate
			await this.Vault.updateMaxReleaseRatePerPeriod(ether('20000000'), {from: owner});

			const maxReleaseRatePerPeriodAfter = await this.Vault.maxReleaseRatePerPeriod();

			expect(maxReleaseRatePerPeriod).to.bignumber.be.eq(ether('1000000'));
			expect(maxReleaseRatePerPeriodAfter).to.bignumber.be.eq(ether('20000000'));
		});

		it('should revert when non-owner tries to update the release rate', async () => {
			await expectRevert(
				this.Vault.updateMaxReleaseRatePerPeriod(ether('2000000'), {from: user1}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when owner tries to update the release rate with already set value', async () => {
			await expectRevert(
				this.Vault.updateMaxReleaseRatePerPeriod(ether('20000000'), {from: owner}),
				'Vault: ALREADY_SET'
			);
		});
	});

	describe('updateIncreasePercentage()', async () => {
		it('should update the updateIncreasePercentage correctly', async () => {
			const increasePercentage = await this.Vault.increasePercentage();

			//update increase percentage
			await this.Vault.updateIncreasePercentage('700', {from: owner});

			const increasePercentageAfter = await this.Vault.increasePercentage();

			expect(increasePercentage).to.bignumber.be.eq(new BN('500'));
			expect(increasePercentageAfter).to.bignumber.be.eq(new BN('700'));
		});

		it('should revert when non-owner tries to update the increase percentage', async () => {
			await expectRevert(
				this.Vault.updateIncreasePercentage('700', {from: user1}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when owner tries to update the increase percentage with already set value', async () => {
			await expectRevert(
				this.Vault.updateIncreasePercentage('700', {from: owner}),
				'Vault: ALREADY_SET'
			);
		});
	});

	describe('updateIncreaseRateAfterPeriod()', async () => {
		it('should update the updateIncreaseRateAfterPeriod correctly', async () => {
			const increaseRateAfterPeriods = await this.Vault.increaseRateAfterPeriods();

			//update increase period duration
			await this.Vault.updateIncreaseRateAfterPeriod(4 * blocksPerWeek, {
				from: owner
			});

			const increaseRateAfterPeriodsAfter = await this.Vault.increaseRateAfterPeriods();

			expect(increaseRateAfterPeriods).to.bignumber.be.eq(new BN(blocksPerWeek));
			expect(increaseRateAfterPeriodsAfter).to.bignumber.be.eq(new BN(4 * blocksPerWeek));
		});

		it('should revert when non-owner tries to update the increase period duration', async () => {
			await expectRevert(
				this.Vault.updateIncreaseRateAfterPeriod(blocksPerWeek, {from: user1}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when owner tries to update the increase period duration with already set value', async () => {
			await expectRevert(
				this.Vault.updateIncreaseRateAfterPeriod(blocksPerWeek * 4, {from: owner}),
				'Vault: ALREADY_SET'
			);
		});
	});

	describe('updateTotalBlocksPerPeriod()', async () => {
		it('should update the updateTotalBlocksPerPeriod correctly', async () => {
			const totalBlocksPerPeriod = await this.Vault.totalBlocksPerPeriod();

			//update block time
			await this.Vault.updateTotalBlocksPerPeriod(2, {from: owner});

			const totalBlocksPerPeriodAfter = await this.Vault.totalBlocksPerPeriod();

			expect(totalBlocksPerPeriod).to.bignumber.be.eq(new BN('1200'));
			expect(totalBlocksPerPeriodAfter).to.bignumber.be.eq(new BN('2'));
		});

		it('should revert when non-owner tries to update the block time', async () => {
			await expectRevert(
				this.Vault.updateTotalBlocksPerPeriod('7', {from: user1}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when owner tries to update the increase period duration with already set value', async () => {
			await expectRevert(
				this.Vault.updateTotalBlocksPerPeriod('2', {from: owner}),
				'Vault: ALREADY_SET'
			);
		});
	});

	describe('claimAllTokens()', () => {
		it('should claim tokens send to vault contract', async () => {
			//transfer tokens to Vault
			await this.SampleToken.mint(this.Vault.address, ether('5'), {from: owner});

			const vaultTokenBalBefore = await this.SampleToken.balanceOf(this.Vault.address);
			const owenerTokenBalBefore = await this.SampleToken.balanceOf(owner);

			// claim all tokens
			await this.Vault.claimAllTokens(owner, this.SampleToken.address, {from: owner});

			const vaultTokenBalAfter = await this.SampleToken.balanceOf(this.Vault.address);
			const owenerTokenBalAfter = await this.SampleToken.balanceOf(owner);

			expect(vaultTokenBalBefore).to.bignumber.be.eq(ether('5'));
			expect(owenerTokenBalBefore).to.bignumber.be.eq(new BN('0'));

			expect(vaultTokenBalAfter).to.bignumber.be.eq(new BN('0'));
			expect(owenerTokenBalAfter).to.bignumber.be.eq(ether('5'));
		});

		it('should revert when non-admin tries to claim all the tokens', async () => {
			await expectRevert(
				this.Vault.claimAllTokens(owner, this.SampleToken.address, {from: minter}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when admin tries to claim all the tokens to zero user address', async () => {
			await expectRevert(
				this.Vault.claimAllTokens(ZERO_ADDRESS, this.SampleToken.address, {from: owner}),
				'Vault: INVALID_USER_ADDRESS'
			);
		});
		it('should revert when admin tries to claim all the tokens for zero token address', async () => {
			await expectRevert(
				this.Vault.claimAllTokens(owner, ZERO_ADDRESS, {from: owner}),
				'Vault: INVALID_TOKEN_ADDRESS'
			);
		});
		it('should revert when admin tries to claim all the tokens for LAC token address', async () => {
			await expectRevert(
				this.Vault.claimAllTokens(owner, this.LacToken.address, {from: owner}),
				'Vault: INVALID_TOKEN_ADDRESS'
			);
		});
	});

	describe('claimTokens()', () => {
		it('should claim specified amount of tokens send to Vault contract', async () => {
			//transfer tokens to Vault
			await this.SampleToken.mint(this.Vault.address, ether('5'), {from: owner});

			const vaultTokenBalBefore = await this.SampleToken.balanceOf(this.Vault.address);
			const minterTokenBalBefore = await this.SampleToken.balanceOf(minter);

			// claim all tokens
			await this.Vault.claimTokens(minter, this.SampleToken.address, ether('4'), {
				from: owner
			});

			const vaultTokenBalAfter = await this.SampleToken.balanceOf(this.Vault.address);
			const minterTokenBalAfter = await this.SampleToken.balanceOf(minter);

			expect(vaultTokenBalBefore).to.bignumber.be.eq(ether('5'));

			expect(vaultTokenBalAfter).to.bignumber.be.eq(ether('1'));
			expect(minterTokenBalAfter).to.bignumber.be.eq(minterTokenBalBefore.add(ether('4')));
		});

		it('should revert when non-admin tries to claim given no. of the tokens', async () => {
			await expectRevert(
				this.Vault.claimTokens(owner, this.SampleToken.address, ether('4'), {from: minter}),
				'Vault: ONLY_ADMIN_CAN_CALL'
			);
		});

		it('should revert when admin tries to claim  given no. of the tokens to zero user address', async () => {
			await expectRevert(
				this.Vault.claimTokens(ZERO_ADDRESS, this.SampleToken.address, ether('4'), {
					from: owner
				}),
				'Vault: INVALID_USER_ADDRESS'
			);
		});

		it('should revert when admin tries to claim  given no. of the tokens for zero token address', async () => {
			await expectRevert(
				this.Vault.claimTokens(owner, ZERO_ADDRESS, ether('4'), {from: owner}),
				'Vault: INVALID_TOKEN_ADDRESS'
			);
		});

		it('should revert when admin tries to claim  given no. of the tokens for LAC token address', async () => {
			await expectRevert(
				this.Vault.claimTokens(owner, this.LacToken.address, ether('4'), {from: owner}),
				'Vault: INVALID_TOKEN_ADDRESS'
			);
		});

		it('should revert when admin tries to claim invalid amount of tokens', async () => {
			await expectRevert(
				this.Vault.claimTokens(owner, this.SampleToken.address, ether('0'), {from: owner}),
				'Vault: INSUFFICIENT_BALANCE'
			);
			await expectRevert(
				this.Vault.claimTokens(owner, this.SampleToken.address, ether('2'), {from: owner}),
				'Vault: INSUFFICIENT_BALANCE'
			);
		});
	});

	describe('getTotalFundReceivers()', () => {
		it('should return total fund receivers correctly', async () => {
			const totalReceivers = await this.Vault.getTotalFundReceivers();
			expect(totalReceivers).to.bignumber.be.eq(new BN('3'));
		});
	});

	describe('getFundReceiverShare()', () => {
		it('should return fund receivers share correctly', async () => {
			const receiver1Share = await this.Vault.getFundReceiverShare(receiver1);
			const receiver2Share = await this.Vault.getFundReceiverShare(receiver2);
			const receiver3Share = await this.Vault.getFundReceiverShare(receiver3);
			expect(receiver1Share).to.bignumber.be.eq(new BN('800000000000'));
			expect(receiver2Share).to.bignumber.be.eq(new BN('100000000000'));
			expect(receiver3Share).to.bignumber.be.eq(new BN('100000000000'));
		});
	});

	describe('getPendingAccumulatedFunds()', () => {
		it('should get the pending accumulated funds correctly', async () => {
			//update allocated funds
			await this.Vault.updateAllocatedFunds();

			const currentPerBlockAmount = await this.Vault.currentReleaseRatePerBlock();

			const receiver1Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('8000'),
				new BN('10000'),
				new BN('1')
			);
			const receiver2Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('1000'),
				new BN('10000'),
				new BN('1')
			);
			const receiver3Share = getReceiverShare(
				currentPerBlockAmount,
				new BN('1000'),
				new BN('10000'),
				new BN('1')
			);

			const currentBlock = await this.BlockData.getBlock();
			await time.advanceBlockTo(currentBlock.add(new BN('1')));

			//get pending accumulated funds
			const pendingFunds1 = await this.Vault.getPendingAccumulatedFunds(receiver1);
			const pendingFunds2 = await this.Vault.getPendingAccumulatedFunds(receiver2);
			const pendingFunds3 = await this.Vault.getPendingAccumulatedFunds(receiver3);

			expect(pendingFunds1).to.bignumber.be.eq(receiver1Share);
			expect(pendingFunds2).to.bignumber.be.eq(receiver2Share);
			expect(pendingFunds3).to.bignumber.be.eq(receiver3Share);
		});
	});

	describe('getMultiplier()', async () => {
		it('should get the multiplier correctly', async () => {
			const multiplier = await this.Vault.getMultiplier();

			const currentBlock = await this.BlockData.getBlock();
			const lastFundUpdatedBlock = await this.Vault.lastFundUpdatedBlock();

			// increase time by 6 seconds
			await time.advanceBlockTo(currentBlock.add(new BN('2')));

			const multiplierAfter = await this.Vault.getMultiplier();

			expect(currentBlock).to.bignumber.be.eq(lastFundUpdatedBlock.add(new BN('1')));
			expect(multiplier).to.bignumber.be.eq(new BN('1'));
			expect(multiplierAfter).to.bignumber.be.eq(new BN('3'));
		});
	});
});
