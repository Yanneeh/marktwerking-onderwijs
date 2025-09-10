const Token = artifacts.require("Token");

module.exports = function (deployer) {
  deployer.deploy(Token, "HUToken", "HUT", 100000);
};