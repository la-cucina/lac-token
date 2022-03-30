// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import '@openzeppelin/contracts/access/AccessControl.sol';
import '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import '@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol';
import '@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol';
import '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/utils/Counters.sol';
import '@openzeppelin/contracts/security/Pausable.sol';

import './library/LacTokenUtils.sol';
import './interfaces/IVaultLogic.sol';
import './interfaces/IVersionedContract.sol';
import './interfaces/IMasterVaultBase.sol';

contract TokenReleaseScheduleLogic is
	EIP712('TokenReleaseScheduleLogic', '1.0.0'),
	AccessControl,
	ReentrancyGuard,
	Pausable,
	IVaultLogic,
	IVersionedContract
{
	using Counters for Counters.Counter;
	using LacTokenUtils for uint256[];
	/*
   =======================================================================
   ======================== Structures ===================================
   ======================================================================
 */

	struct FundReceiver {
		string name;
		uint256 lacShare;
		uint256 totalAccumulatedFunds;
	}
	/*
   =======================================================================
   ======================== Constants ====================================
   =======================================================================
 */

	bytes32 public constant VAULT_KEEPER = keccak256('VAULT_KEEPER');

	/*
   =======================================================================
   ======================== Private Variables ============================
   =======================================================================
 */

	Counters.Counter internal receiverCounter;

	/*
   =======================================================================
   ======================== Public Variables ============================
   =======================================================================
 */

	IERC20 public Token;
	IMasterVaultBase public Vault;

	uint256 public totalShares;
	uint256 public initialStartBlock;
	uint256 public startBlock;
	uint256 public currentReleaseRatePerPeriod;
	uint256 public currentReleaseRatePerBlock;
	uint256 public finalReleaseRatePerPeriod;
	int256 public changePercentage;
	uint256 public blocksPerPeriod;
	uint256 public lastFundUpdatedBlock;
	uint256 public shareMultiplier;
	uint256[] public fundReceiversList;
	bool public isSetup;

	/// fundReceiverId => share percentage
	mapping(uint256 => FundReceiver) public fundReceivers;

	/// userAddress => nonce
	mapping(address => uint256) public userNonce;

	/*
   =======================================================================
   ======================== Constructor/Initializer ======================
   =======================================================================
 	*/

	/**
	 * @notice
	 */
	constructor(
		address _vaultAddress,
		address tokenAddress,
		uint256 _initialReleaseRatePerPeriod,
		uint256 _finalReleaseRatePerPeriod,
		int256 _changePercentage,
		uint256 _blocksPerPeriod
	)
		onlyValidReleaseRates(
			_initialReleaseRatePerPeriod,
			_finalReleaseRatePerPeriod,
			_changePercentage
		)
	{
		require(_vaultAddress != address(0), 'TokenReleaseScheduleLogic: INVALID_VAULT_ADDRESS');
		require(tokenAddress != address(0), 'TokenReleaseScheduleLogic: INVALID_LAC_ADDRESS');

		_setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

		Vault = IMasterVaultBase(_vaultAddress);
		Token = IERC20(tokenAddress);
		shareMultiplier = 1e12;
		currentReleaseRatePerPeriod = _initialReleaseRatePerPeriod;

		// calculate per block release rate ex. currentReleaseRatePerPeriod / _blocksPerPeriod.
		currentReleaseRatePerBlock = currentReleaseRatePerPeriod / _blocksPerPeriod;

		finalReleaseRatePerPeriod = _finalReleaseRatePerPeriod;
		changePercentage = _changePercentage;
		blocksPerPeriod = _blocksPerPeriod;
	}

	/*
   =======================================================================
   ======================== Events ====================================
   =======================================================================
 	*/
	event ReceiverAdded(uint256 indexed receiverId, uint256 indexed share);
	event ReceiverRemoved(uint256 indexed receiverId);
	event ReceiverShareUpdated(
		uint256 indexed receiver,
		uint256 indexed oldShare,
		uint256 indexed newShare,
		uint256 block
	);
	event ReceiverShrinked(
		uint256 indexed existingReceiverId,
		uint256 indexed newReceiverId,
		uint256 indexed oldReceiverShare,
		uint256 newShare
	);
	event ClaimTokens(address indexed user, address indexed tokenAddress, uint256 indexed amount);
	event TokenReleaseScheduleLogicParamsUpdated(
		uint256 indexed currentReleaseRatePerPeriod,
		uint256 indexed finalReleaseRatePerPeriod,
		int256 indexed changePercentage,
		uint256 blocksPerPeriod,
		uint256 blockNumber
	);

	/*
   =======================================================================
   ======================== Modifiers ====================================
   =======================================================================
 	*/

	modifier onlyAdmin() {
		require(
			hasRole(DEFAULT_ADMIN_ROLE, _msgSender()),
			'TokenReleaseScheduleLogic: ONLY_ADMIN_CAN_CALL'
		);
		_;
	}

	modifier onlyValidReleaseRates(
		uint256 _initialReleaseRatePerPeriod,
		uint256 _finalReleaseRatePerPeriod,
		int256 _changePercentage
	) {
		if (_changePercentage > 0) {
			require(_changePercentage >= 100, 'TokenReleaseScheduleLogic: INVALID_PERCENTAGE');
			require(
				_finalReleaseRatePerPeriod > _initialReleaseRatePerPeriod,
				'TokenReleaseScheduleLogic: INVALID_RATES'
			);
		} else if (_changePercentage < 0) {
			require(_changePercentage <= -100, 'TokenReleaseScheduleLogic: INVALID_PERCENTAGE');
			require(
				_finalReleaseRatePerPeriod < _initialReleaseRatePerPeriod,
				'TokenReleaseScheduleLogic: INVALID_RATES'
			);
		} else {
			require(
				_finalReleaseRatePerPeriod == _initialReleaseRatePerPeriod,
				'TokenReleaseScheduleLogic: INVALID_RATES'
			);
		}
		_;
	}

	/*
   =======================================================================
   ======================== Public Methods ===============================
   =======================================================================
 	*/

	/**
	 * @notice This method allows admin to setup the startblock and	 lastfund updated block and adds the initial receivers
	 * @param _fundReceivers - indicates the list of receivers
	 * @param _shares - indicates the list of shares of respective receivers
	 */
	function setup(string[] memory _fundReceivers, uint256[] memory _shares)
		external
		virtual
		onlyAdmin
	{
		require(!isSetup, 'TokenReleaseScheduleLogic: ALREADY_SETUP_DONE');
		require(
			_fundReceivers.length > 0 && _fundReceivers.length == _shares.length,
			'TokenReleaseScheduleLogic: INVALID_DATA'
		);

		for (uint256 i = 0; i < _fundReceivers.length; i++) {
			_addFundReceiver(_fundReceivers[i], _shares[i]);
		}

		lastFundUpdatedBlock = block.number;
		startBlock = block.number;
		initialStartBlock = block.number;
		isSetup = true;
	}

	/**
	 * @notice This method allows operators to claim the specified amount of LAC tokens from the fundReceiver
	 * @param  _amount - indicates the amount of tokens to claim
	 * @param _receiverId - indicates the fund receiver id from which funds to claim
	 * @param _referenceNumber - indicates the unique reference number for claim
	 * @param _signature - indicates the singature for claiming the tokens
	 */
	function claim(
		uint256 _amount,
		uint256 _receiverId,
		uint256 _referenceNumber,
		bytes calldata _signature
	) external virtual nonReentrant whenNotPaused {
		(bool isExists, ) = fundReceiversList.isNumberExists(_receiverId);
		require(isExists, 'TokenReleaseScheduleLogic: RECEIVER_DOES_NOT_EXISTS');

		// update allocated funds
		_updateAllocatedFunds();

		require(
			_amount > 0 && _amount <= fundReceivers[_receiverId].totalAccumulatedFunds,
			'TokenReleaseScheduleLogic: INSUFFICIENT_AMOUNT'
		);
		require(
			_verify(_hash(_amount, _receiverId, userNonce[msg.sender], _referenceNumber), _signature),
			'TokenReleaseScheduleLogic: INVALID_SIGNATURE'
		);

		// claim tokens from Vault
		require(
			Vault.claim(msg.sender, address(Token), _amount),
			'TokenReleaseScheduleLogic: TRANSFER_FAILED'
		);

		fundReceivers[_receiverId].totalAccumulatedFunds -= _amount;

		//update user nonce
		userNonce[msg.sender] += 1;

		emit Claimed(msg.sender, _receiverId, _amount, block.timestamp, _referenceNumber);
	}

	/**
	 * @notice This method allows admin to adds the receivers
	 * @param _fundReceivers - indicates the list of receivers
	 * @param _shares - indicates the list of shares of respective receivers
	 */
	function addFundReceivers(string[] memory _fundReceivers, uint256[] memory _shares)
		external
		virtual
		onlyAdmin
		whenPaused
	{
		require(
			_fundReceivers.length > 0 && _fundReceivers.length == _shares.length,
			'TokenReleaseScheduleLogic: INVALID_DATA'
		);

		_updateAllocatedFunds();

		for (uint256 i = 0; i < _fundReceivers.length; i++) {
			_addFundReceiver(_fundReceivers[i], _shares[i]);
		}
	}

	/**
	 * @notice This method allows admin to remove the receiver from being able to claim/receive LAC tokens.
	 * @param _receiverId indicates the receiver id to remove.
	 */
	function removeFundReceiver(uint256 _receiverId) external virtual onlyAdmin whenPaused {
		_updateAllocatedFunds();

		fundReceiversList.removeNumberFromList(_receiverId);

		// update total shares
		totalShares -= fundReceivers[_receiverId].lacShare;

		delete fundReceivers[_receiverId];

		emit ReceiverRemoved(_receiverId);
	}

	/**
	 * @notice This method allows admin to update the receiver`s share
	 * @param _receiverId - indicates the id of the fundReceiver
	 * @param _newShare - indicates the new share for the fundReceiver. ex. 100 = 1%
	 */
	function updateReceiverShare(uint256 _receiverId, uint256 _newShare)
		external
		virtual
		onlyAdmin
		whenPaused
	{
		_updateAllocatedFunds();

		(bool isExists, ) = fundReceiversList.isNumberExists(_receiverId);

		require(isExists, 'TokenReleaseScheduleLogic: RECEIVER_DOES_NOT_EXISTS');
		uint256 currentShare = fundReceivers[_receiverId].lacShare;

		require(currentShare != _newShare && _newShare > 0, 'TokenReleaseScheduleLogic: INVALID_SHARE');

		totalShares = (totalShares - fundReceivers[_receiverId].lacShare) + _newShare;
		fundReceivers[_receiverId].lacShare = _newShare;

		emit ReceiverShareUpdated(_receiverId, currentShare, _newShare, block.number);
	}

	/**
	 * @notice This method allows admin to add new receiver by shrinking the share of existing receiver.
	 * @param _existingReceiverId - indicates the id of the existing fundReceiver whose share will allocated to new receiver
	 * @param _newReceiverName - indicates the name of the new fundReceiver.
	 * @param _newShare - indicates the new share for the fundReceiver. ex. 100 = 1%
	 */
	function shrinkReceiver(
		uint256 _existingReceiverId,
		string memory _newReceiverName,
		uint256 _newShare
	) external virtual onlyAdmin whenPaused returns (uint256 receiverId) {
		require(bytes(_newReceiverName).length > 0, 'TokenReleaseScheduleLogic: INVALID_NAME');

		_updateAllocatedFunds();

		(bool isReceiverExists, ) = fundReceiversList.isNumberExists(_existingReceiverId);
		require(isReceiverExists, 'TokenReleaseScheduleLogic: RECEIVER_DOES_NOT_EXISTS');

		uint256 currentShare = fundReceivers[_existingReceiverId].lacShare;
		require(_newShare < currentShare && _newShare > 0, 'TokenReleaseScheduleLogic: INVALID_SHARE');

		receiverCounter.increment();
		receiverId = receiverCounter.current();

		fundReceivers[_existingReceiverId].lacShare = currentShare - _newShare;
		fundReceivers[receiverId].lacShare = _newShare;
		fundReceiversList.push(receiverId);

		emit ReceiverShrinked(_existingReceiverId, receiverId, currentShare, _newShare);
	}

	function updateTokenReleaseScheduleLogicParams(
		uint256 _newInitialReleaseRate,
		uint256 _newfinalReleaseRate,
		int256 _newPercentage,
		uint256 _newBlocksPerPeriod
	)
		external
		virtual
		onlyAdmin
		whenPaused
		onlyValidReleaseRates(_newInitialReleaseRate, _newfinalReleaseRate, _newPercentage)
	{
		// At least one param must be different
		require(
			_newInitialReleaseRate != currentReleaseRatePerPeriod ||
				_newfinalReleaseRate != finalReleaseRatePerPeriod ||
				_newPercentage != changePercentage ||
				_newBlocksPerPeriod != blocksPerPeriod,
			'TokenReleaseScheduleLogic: ALREADY_SET'
		);

		_updateAllocatedFunds();

		startBlock = block.number;

		currentReleaseRatePerPeriod = _newInitialReleaseRate;
		currentReleaseRatePerBlock = _newInitialReleaseRate / _newBlocksPerPeriod;

		finalReleaseRatePerPeriod = _newfinalReleaseRate;
		changePercentage = _newPercentage;
		blocksPerPeriod = _newBlocksPerPeriod;

		emit TokenReleaseScheduleLogicParamsUpdated(
			currentReleaseRatePerPeriod,
			finalReleaseRatePerPeriod,
			changePercentage,
			blocksPerPeriod,
			block.number
		);
	}

	/**
	 * @notice This method allows admin to claim all the tokens of specified address to given address
	 */
	function claimAllTokens(address _user, address _tokenAddress) external virtual onlyAdmin {
		require(_user != address(0), 'TokenReleaseScheduleLogic: INVALID_USER_ADDRESS');
		require(
			_tokenAddress != address(0) && _tokenAddress != address(Token),
			'TokenReleaseScheduleLogic: INVALID_TOKEN_ADDRESS'
		);

		uint256 tokenAmount = IERC20(_tokenAddress).balanceOf(address(this));

		require(IERC20(_tokenAddress).transfer(_user, tokenAmount));

		emit ClaimTokens(_user, _tokenAddress, tokenAmount);
	}

	/**
	 * @notice This method allows admin to transfer specified amount of the tokens of specified address to given address
	 */
	function claimTokens(
		address _user,
		address _tokenAddress,
		uint256 _amount
	) external virtual onlyAdmin {
		require(_user != address(0), 'TokenReleaseScheduleLogic: INVALID_USER_ADDRESS');
		require(
			_tokenAddress != address(0) && _tokenAddress != address(Token),
			'TokenReleaseScheduleLogic: INVALID_TOKEN_ADDRESS'
		);

		uint256 tokenAmount = IERC20(_tokenAddress).balanceOf(address(this));
		require(
			_amount > 0 && tokenAmount >= _amount,
			'TokenReleaseScheduleLogic: INSUFFICIENT_BALANCE'
		);

		require(IERC20(_tokenAddress).transfer(_user, _amount));

		emit ClaimTokens(_user, _tokenAddress, _amount);
	}

	/**
	 * @notice This method allows admin to pause the contract
	 */
	function pause() external virtual onlyAdmin {
		_pause();
	}

	/**
	 * @notice This method allows admin to un-pause the contract
	 */
	function unPause() external virtual onlyAdmin {
		_unpause();
	}

	/*
   =======================================================================
   ======================== Getter Methods ===============================
   =======================================================================
 	*/
	function supportsInterface(bytes4 interfaceId)
		public
		view
		virtual
		override(IERC165, AccessControl)
		returns (bool)
	{
		return interfaceId == type(IVaultLogic).interfaceId || interfaceId == type(IERC165).interfaceId;
	}

	/**
	 * This method returns the total number of fundReceivers available in logicContract
	 */
	function getTotalFundReceivers() external view virtual returns (uint256) {
		return fundReceiversList.length;
	}

	/**
	 * This method returns the share of specified fund receiver
	 */
	function getFundReceiverShare(uint256 _receiver) public view virtual returns (uint256) {
		return (fundReceivers[_receiver].lacShare * shareMultiplier) / totalShares;
	}

	/**
	 * This method returns fundReceiver`s accumulated funds
	 */
	function getPendingAccumulatedFunds(uint256 _receiver)
		public
		view
		virtual
		returns (uint256 accumulatedFunds)
	{
		uint256 receiverShare = getFundReceiverShare(_receiver);
		if (_isPeriodCompleted()) {
			uint256 totalBlocks;
			uint256 currentPerPeriodRate;
			uint256 perPeriodReleaseRate;
			uint256 perBlockReleaseRate;
			uint256 periodEndBlock = startBlock + blocksPerPeriod;

			// get total blocks before periods completed i.e periodsLastBlock - lastupdated block
			totalBlocks = periodEndBlock >= lastFundUpdatedBlock
				? periodEndBlock - lastFundUpdatedBlock
				: 0;

			accumulatedFunds =
				(currentReleaseRatePerBlock * totalBlocks * receiverShare) /
				shareMultiplier;

			// calculate number of periods before last update happened
			uint256 totalPeriodsCompleted = (block.number - (periodEndBlock)) / blocksPerPeriod;

			if (totalPeriodsCompleted > 0) {
				currentPerPeriodRate = currentReleaseRatePerPeriod;
				do {
					// get correct release rate according to periods
					(perPeriodReleaseRate, perBlockReleaseRate) = _getReleaseRateValues(
						int256(currentPerPeriodRate)
					);

					accumulatedFunds += (perPeriodReleaseRate * receiverShare) / shareMultiplier;

					periodEndBlock = periodEndBlock + blocksPerPeriod;
					currentPerPeriodRate = perPeriodReleaseRate;
				} while ((block.number - periodEndBlock) > blocksPerPeriod);
			}

			// total blocks passed in the current period
			totalBlocks = block.number - periodEndBlock;

			if (totalBlocks > 0) {
				(perPeriodReleaseRate, perBlockReleaseRate) = _getReleaseRateValues(
					int256(currentPerPeriodRate)
				);

				accumulatedFunds += (perBlockReleaseRate * totalBlocks * receiverShare) / shareMultiplier;
			}
		} else {
			accumulatedFunds =
				(currentReleaseRatePerBlock * blocksPassedSinceUpdate() * receiverShare) /
				shareMultiplier;
		}
	}

	/**
	 * This method returns the blocks passed since last fund update
	 */
	function blocksPassedSinceUpdate() public view virtual returns (uint256) {
		return (block.number - lastFundUpdatedBlock);
	}

	/**
	 * @notice This method returns the per block and per period release rate
	 */
	function getCurrentReleaseRate()
		external
		view
		virtual
		returns (
			uint256 _currentReleaseRatePerBlock,
			uint256 _currentReleaseRatePerPeriod,
			uint256 blockNumber
		)
	{
		if (_isPeriodCompleted()) {
			uint256 periodEndBlock = startBlock + blocksPerPeriod;

			// calculate number of periods before last update happened
			uint256 totalPeriodsCompleted = (block.number - (periodEndBlock)) / blocksPerPeriod;

			// get correct release rate according to periods
			(_currentReleaseRatePerPeriod, _currentReleaseRatePerBlock) = _getReleaseRateValues(
				int256(currentReleaseRatePerPeriod)
			);

			if (totalPeriodsCompleted > 0) {
				uint256 currentPerPeriodRate = _currentReleaseRatePerPeriod;
				do {
					// get correct release rate according to periods
					(_currentReleaseRatePerPeriod, _currentReleaseRatePerBlock) = _getReleaseRateValues(
						int256(currentPerPeriodRate)
					);

					periodEndBlock = periodEndBlock + blocksPerPeriod;
					currentPerPeriodRate = _currentReleaseRatePerPeriod;
				} while ((block.number - periodEndBlock) > blocksPerPeriod);
			}
		} else {
			_currentReleaseRatePerBlock = currentReleaseRatePerBlock;
			_currentReleaseRatePerPeriod = currentReleaseRatePerPeriod;
		}

		blockNumber = block.number;
	}

	/**
	 * @notice Returns the storage, major, minor, and patch version of the contract.
	 * @return The storage, major, minor, and patch version of the contract.
	 */
	function getVersionNumber() public pure virtual override returns (string memory) {
		return '1.0.0';
	}

	/*
   =======================================================================
   ======================== Internal Methods =============================
   =======================================================================
 	*/
	/**
	 * @notice This method allows admin to add the allocator to be able to claim/receive LAC tokens.
	 * @param _receiverName indicates the name of the receiver to add.
	 * @param _share indicates the share of the receiver in reward. 100 = 1%
	 */
	function _addFundReceiver(string memory _receiverName, uint256 _share)
		internal
		returns (uint256 receiverId)
	{
		require(bytes(_receiverName).length > 0, 'TokenReleaseScheduleLogic: INVALID_NAME');

		receiverCounter.increment();
		receiverId = receiverCounter.current();

		fundReceivers[receiverId] = FundReceiver(_receiverName, _share, 0);
		totalShares += _share;

		fundReceiversList.push(receiverId);

		emit ReceiverAdded(receiverId, _share);
	}

	function _isPeriodCompleted() public view returns (bool isCompleted) {
		return block.number > (startBlock + blocksPerPeriod);
	}

	/**
	 * @notice This method updates the totalAllocated funds for each receiver
	 */
	function _updateAllocatedFunds() internal virtual {
		if (blocksPassedSinceUpdate() > 0) {
			// update totalAllocated funds for all fundReceivers
			for (uint256 i = 0; i < fundReceiversList.length; i++) {
				uint256 funds = getPendingAccumulatedFunds(fundReceiversList[i]);

				fundReceivers[fundReceiversList[i]].totalAccumulatedFunds += funds;
			}
			if (_isPeriodCompleted()) {
				if (changePercentage == 0) {
					_updateReleaseRate();
				}

				if (currentReleaseRatePerPeriod != finalReleaseRatePerPeriod) {
					uint256 periodEndBlock = startBlock + blocksPerPeriod;

					// calculate number of periods before last update happened
					uint256 totalPeriodsCompleted = (block.number - (periodEndBlock)) / blocksPerPeriod;

					_updateReleaseRate();

					for (uint256 i = 0; i < totalPeriodsCompleted; i++) {
						if (currentReleaseRatePerPeriod == finalReleaseRatePerPeriod) {
							break;
						}
						_updateReleaseRate();
					}
				}
			}

			lastFundUpdatedBlock = block.number;
		}
	}

	function _updateReleaseRate() internal {
		if (changePercentage != 0) {
			(uint256 perPeriodReleaseRate, uint256 perBlockReleaseRate) = _getReleaseRateValues(
				int256(currentReleaseRatePerPeriod)
			);

			currentReleaseRatePerPeriod = perPeriodReleaseRate;
			currentReleaseRatePerBlock = perBlockReleaseRate;
		}

		// update start time
		startBlock = block.number;
	}

	function _getReleaseRateValues(int256 _currentPerPeriodReleaseRate)
		internal
		view
		virtual
		returns (uint256 perPeriodReleaseRate, uint256 perBlockReleaseRate)
	{
		// calculate amount to increase by
		int256 increaseAmount = (_currentPerPeriodReleaseRate * changePercentage) / 10000;

		if (increaseAmount < 0) {
			if ((_currentPerPeriodReleaseRate + increaseAmount) < int256(finalReleaseRatePerPeriod)) {
				// set per period release rate to max release rate in case current release rate exceeds min release rate
				perPeriodReleaseRate = finalReleaseRatePerPeriod;
			} else {
				perPeriodReleaseRate = uint256(_currentPerPeriodReleaseRate + increaseAmount);
			}
		} else {
			if ((_currentPerPeriodReleaseRate + increaseAmount) > int256(finalReleaseRatePerPeriod)) {
				// set per period release rate to max release rate in case current release rate exceeds max release rate
				perPeriodReleaseRate = finalReleaseRatePerPeriod;
			} else {
				perPeriodReleaseRate = uint256(_currentPerPeriodReleaseRate + increaseAmount);
			}
		}

		// update per block release rate
		perBlockReleaseRate = perPeriodReleaseRate / blocksPerPeriod;
	}

	function _hash(
		uint256 _amount,
		uint256 _receiver,
		uint256 _nonce,
		uint256 _referenceNumber
	) internal view returns (bytes32) {
		return
			_hashTypedDataV4(
				keccak256(
					abi.encode(
						keccak256(
							'Claim(address account,uint256 amount,uint256 receiver,uint256 nonce,uint256 referenceNumber)'
						),
						msg.sender,
						_amount,
						_receiver,
						_nonce,
						_referenceNumber
					)
				)
			);
	}

	function _verify(bytes32 _digest, bytes memory _signature) internal view returns (bool) {
		return hasRole(VAULT_KEEPER, ECDSA.recover(_digest, _signature));
	}
}
