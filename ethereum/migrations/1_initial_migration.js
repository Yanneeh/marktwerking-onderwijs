const MyToken = artifacts.require("MyToken");

module.exports = function (deployer) {
  deployer.deploy(MyToken, "MyToken", "MYT", 100000);
};
// --- IGNORE -