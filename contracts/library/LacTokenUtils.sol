//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

library LacTokenUtils {
	/**
	 * @notice This method allows admin to add the receiver addresses.
	 * @param _address indicates the address to add.
	 */
	function addAddressInList(address[] storage _list, address _address) internal {
		require(_address != address(0), 'LacTokenUtils: CANNOT_ADD_ZERO_ADDRESS');

		(bool isExists, ) = isAddressExists(_list, _address);
		require(!isExists, 'LacTokenUtils: ADDRESS_ALREADY_EXISTS');

		_list.push(_address);
	}

	/**
	 * @notice This method allows user to remove the receiver address from the address list
	 */
	function removeAddressFromList(address[] storage _list, address _item) internal {
		uint256 listItems = _list.length;
		require(listItems > 0, 'LacTokenUtils: EMPTY_LIST');

		// check and remove if the last item is item to be removed.
		if (_list[listItems - 1] == _item) {
			_list.pop();
			return;
		}

		(bool isExists, uint256 index) = isAddressExists(_list, _item);
		require(isExists, 'LacTokenUtils: ITEM_DOES_NOT_EXISTS');

		// move supported token to last
		if (listItems > 1) {
			address temp = _list[listItems - 1];
			_list[index] = temp;
		}

		//remove supported token
		_list.pop();
	}

	/**
	 * @notice This method allows to check if particular address exists in list or not
	 * @param _list indicates list of addresses
	 * @param _item indicates address
	 * @return isExists - returns true if item exists otherwise returns false. index - index of the existing item from the list.
	 */
	function isAddressExists(address[] storage _list, address _item)
		internal
		view
		returns (bool isExists, uint256 index)
	{
		for (uint256 i = 0; i < _list.length; i++) {
			if (_list[i] == _item) {
				isExists = true;
				index = i;
				break;
			}
		}
	}
}