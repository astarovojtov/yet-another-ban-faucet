const express = require("express");
const app = express();
const banano = require("@bananocoin/bananojs");
const database = require("./db");
const config = {
  faucetWallet:
    "ban_3gahaiusraz8qnotf3skqn3myo74o9f7hroqw8hhny51zkkx5ikbxsbat69c",
  claimAmount: 0.01,
  claimCooldown: 24 * 60 * 60 * 1000,
  oneBanRaw: 100000000000000000000000000000,
  clasimAmountRaw: this.claimAmount * this.oneBanRaw,
};

let db;
database.initDb().then((sqlite) => {
  db = sqlite;
});

app.use(express.json());
app.use(express.static(__dirname + "/static"));

app.get("/asd", async function (req, res) {
  const sql = "SELECT * FROM Users";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  const getAll = await database.all(sql);
  res.json(await getAll);
  //res.sendFile(path.join(__dirname, "/static/index.html"));
});

/**************************/

app.post("/claim", async function (req, res) {
  const address = req.body.address;
  if (!address) {
    res.json({ error: "Provide valid BAN address to continue" });
    return;
  }
  const currentIp =
    req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress;

  banano.bananodeApi.setUrl("https://kaliumapi.appditto.com/api");

  /* 1. Validate address */
  const bAddressValid = await banano.getBananoAccountValidationInfo(address)
    .valid;
  if (!bAddressValid) {
    res.status(500).json({ error: "Invalid BAN address" });
    return;
  }

  /* 2. Unopened */
  const accHistory = await banano.getAccountHistory(address, -1);
  const bIsUnopened = accHistory.history.length === 0;
  if (bIsUnopened) {
    res.status(418).json({ error: "Unopened account" });
    return;
  }

  /* 3. Balance */
  const faucetWalletInfo = await banano.getAccountInfo(config.faucetWallet);

  if (Number(faucetWalletInfo.balance_decimal) < config.claimAmount) {
    res.status(500).json({ error: "Balance too low. Please try again later" });
    return;
  }

  /* 4. Check wether this address already grabbed a claim */

  const sql = `SELECT * FROM Users WHERE address='${address}'`;
  let user = await database.get(sql);

  if (!user) {
    user = await database.addUser(address, currentIp);
  }

  if (!claimCooldownPassed(user.lastClaim)) {
    res.status(418).json({ error: "Come back later" });
    return;
  }

  // 6. Check wether address is blacklisted
  if (user.banned) {
    res.status(418).json({ error: "You were banned. Bye" });
    return;
  }

  // 7. Check same IP-address already grabbed

  const usersWithSameIp = await database.all(
    `SELECT * FROM Users WHERE ip='${currentIp}'`
  );

  if (usersWithSameIp.length > 1) {
    const theUser = usersWithSameIp
      .sort(
        (user, nextUser) =>
          new Date(user.lastClaim) - new Date(nextUser.lastClaim)
      )
      .pop();

    if (!claimCooldownPassed(theUser.lastClaim)) {
      res.status(418).json({ error: "Come back later" });
      return;
    }
  }
  // 8. All good. Send
  //GET seed from environment variable
  //banano.sendAmountToBananoAccount('seed', 0 /* index */, address, clasimAmountRaw, res => res, err => err);

  // 9. Update user ip, lastClaim
  const setIpSql = `UPDATE Users SET ip = '${currentIp}', lastClaim = '${new Date().toISOString()}' WHERE address ='${address}'`;
  database
    .run(setIpSql)
    .then((result) => {
      res.json(result);
    })
    .catch((err) => {
      console.log(err);
      res.status(500).json({ error: "Something went wrong. Hold on" });
    });
});

app.listen(3000);

function claimCooldownPassed(usersLastClaim) {
  const lastClaim = new Date(usersLastClaim);
  const nextClaimAvailableAt = new Date(
    lastClaim.getTime() + 24 * 60 * 60 * 1000
  );
  if (nextClaimAvailableAt > new Date()) {
    return false;
  }
  return true;
}
