const DAOCoursePlatform = artifacts.require("DAOCoursePlatform");
// Replace with deployed ERC20 token address
const treasuryTokenAddress = "0x838474c723e39c3e6E5830Bc88bc71E0f80ae535";

module.exports = async function (deployer, network, accounts) {
  const initialBoard = [accounts[0]]; // first board member
  await deployer.deploy(DAOCoursePlatform, treasuryTokenAddress, initialBoard);
  const daoInstance = await DAOCoursePlatform.deployed();
  console.log("DAOCoursePlatform deployed at:", daoInstance.address);
};