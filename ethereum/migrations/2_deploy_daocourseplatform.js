const DAOCoursePlatform = artifacts.require("DAOCoursePlatform");
// Replace with deployed ERC20 token address
const treasuryTokenAddress = "0x6ebb565D06597B23756c82a63943F78b97f4f662";

module.exports = async function (deployer, network, accounts) {
  const initialBoard = [accounts[0]]; // first board member
  await deployer.deploy(DAOCoursePlatform, treasuryTokenAddress, initialBoard);
  const daoInstance = await DAOCoursePlatform.deployed();
  console.log("DAOCoursePlatform deployed at:", daoInstance.address);
};
// --- IGNORE ---