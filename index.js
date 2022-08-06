const express = require("express");
const app = express();
const banano = require("@bananocoin/bananojs");
const database = require("./db");
const config = {
  faucetWallet:
    "ban_3f1o95qeeg1zignw11ew5sfaxhzogsj3hzm377xjtmab8hwz535p6f96i5uu",
  claimAmount: 0.02,
  claimCooldown: 24 * 60 * 60 * 1000,
  oneBanRaw: 100000000000000000000000000000,
  claimAmountRaw: this.claimAmount * this.oneBanRaw,
  seed: process.env.BAN_SEED
};

banano.bananodeApi.setUrl("https://kaliumapi.appditto.com/api");

let db;
database.initDb(false /*pushMock*/).then(async (sqlite) => {
  db = sqlite;
  const entries = await database.all('SELECT * FROM Users');
  
  if (entries.length > 0) {
    return;
  }

  banano.getAccountHistory(config.faucetWallet, 200).then( (response, rej) => {
    const norm = [];

    response.history.filter( trx => trx.type === 'send')
      .forEach( (next) => {
        if (!norm.find( i => i.account === next.account)) {
          norm.push(next);
        }
    });
    //
    const sqlRows = norm.map( (item, index) => `('${item.account}', 0, '${new Date(item.local_timestamp * 1000).toISOString()}', '::1', 'Pushed from history')`);
    const sql = `INSERT INTO Users ( address, banned, lastClaim, ip, comment) VALUES `.concat(sqlRows.join(','));
    database.run(sql)
      .then(() => console.log('Pushed from history'))
      .catch(err => console.log(err));
  })
});

app.use(express.json());
app.use(express.static(__dirname + "/static"));


app.get("/users", async function (req, res) {
  const sql = "SELECT * FROM Users";
  const getAll = await database.all(sql);
  res.json(await getAll);
});

app.get("/balance", async function (req, res) {
  const balance = await banano.getAccountInfo(config.faucetWallet);
  
  res.json({ balance: balance.balance_decimal });
});

app.post("/claim", async function (req, res) {
  const address = req.body.address;
  const event = req.body.event;
  const currentIp =
  req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress;
  
  if (!event.isTrusted) {
    res.json({ error: "Somtheing vary bad happened!" });
    console.log('Event is not trusted');
    return;
  }
  console.log('Event is trusted');

  if (!address) {
    res.json({ error: "Provide valid BAN address to continue" });
    console.log('Ban address was not provided');
    return;
  }
  console.log('Address is present');

  /* 1. Validate address */
  const bAddressValid = await banano.getBananoAccountValidationInfo(address)
    .valid;
  if (!bAddressValid) {
    res.status(500).json({ error: "Invalid BAN address" });
    console.log('Address is invalid');
    return;
  }
  console.log('Address is valid');

  /* 2. Unopened */
  const accHistory = await banano.getAccountHistory(address, -1);
  const bIsUnopened = accHistory.history.length === 0;
  if (bIsUnopened) {
    res.status(418).json({ error: "Unopened account" });
    console.log('Account is unopened');
    return;
  }
  console.log('Account is opened');

  /* 3. Balance */
  const faucetWalletInfo = await banano.getAccountInfo(config.faucetWallet);

  if (Number(faucetWalletInfo.balance_decimal) < config.claimAmount) {
    res.status(500).json({ error: "Balance too low. Please try again later" });
    console.log('Balance low');
    return;
  }
  console.log('Balance is sufficient');
  /* 4. Check wether this address already grabbed a claim */

  const sql = `SELECT * FROM Users WHERE address='${address}'`;
  let user = await database.get(sql);

  if (!user) {
    user = await database.addUser(address, currentIp);
  }

  if (!claimCooldownPassed(user.lastClaim)) {
    res.status(418).json({ error: "Come back later" });
    console.log('User is on cooldown');
    return;
  }
  console.log('User is not on cooldown');
  // 6. Check wether address is blacklisted
  if (user.banned) {
    res.status(418).json({ error: "You were banned. Bye" });
    console.log('User banned');
    return;
  }
  console.log('User is not banned');
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
      console.log('Same IP check failed');
      return;
    }
  }
  console.log('IP check passed');
  // 8. All good. Send
  
  try {  
    const hash = await banano.sendBananoWithdrawalFromSeed(config.seed, 0 /* index */, address, config.claimAmount);
    res.json({ hash: hash });
  } catch (e) {
    res.status(500).json({ error: err });
    console.log('Send banano failed and catched');
  }

  // 8.1 Check transaction?!

  // 9. Update user ip, lastClaim
  const setIpSql = `UPDATE Users SET ip = '${currentIp}', lastClaim = '${new Date().toISOString()}' WHERE address ='${address}'`;
  database
    .run(setIpSql)
    .then(() => {
      //updates silently
      // res.json({ message: "Successful claim"});
      console.log('User updated after a claim');
    })
    .catch((err) => {
      console.log(err);
      res.status(500).json({ error: "Something went wrong. Hold on" });
    });
});

app.listen(process.env.PORT || 5000);

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
