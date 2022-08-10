const express = require("express");
const app = express();
const banano = require("@bananocoin/bananojs");
const database = require("./db");
const sanitizeHtml = require("sanitize-html");
const https = require('https');
const { response } = require("express");
const config = {
  faucetWallet:
    "ban_3f1o95qeeg1zignw11ew5sfaxhzogsj3hzm377xjtmab8hwz535p6f96i5uu",
  claimAmount: 0.04,
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
  const address = sanitizeHtml(req.body.address);
  const event = req.body.event;
  const currentIp =
  req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress;
  const logMessages = [];
  
  if (!event.isTrusted) {
    res.json({ error: "Somtheing vary bad happened!" });
    logMessages.push('Event is not trusted');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('Event is trusted');

  if (!address) {
    res.json({ error: "Provide valid BAN address to continue" });
    logMessages.push('Ban address was not provided');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('Address is present');

  /* 1. Validate address */
  const bAddressValid = await banano.getBananoAccountValidationInfo(address)
    .valid;
  if (!bAddressValid) {
    res.status(500).json({ error: "Invalid BAN address" });
    logMessages.push('Address is invalid');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('Address is valid');

  /* 2. Unopened */
  const accHistory = await banano.getAccountHistory(address, -1);
  const bIsUnopened = accHistory.history.length === 0;
  if (bIsUnopened) {
    res.status(418).json({ error: "Unopened account" });
    logMessages.push('Account is unopened');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('Account is opened');

  /* 3. Balance */
  const faucetWalletInfo = await banano.getAccountInfo(config.faucetWallet);

  if (Number(faucetWalletInfo.balance_decimal) < config.claimAmount) {
    res.status(500).json({ error: "Balance too low. Please try again later" });
    logMessages.push('Balance low');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('Balance is sufficient');
  /* 4. Check wether this address already grabbed a claim */

  const sql = `SELECT * FROM Users WHERE address='${address}'`;
  let user = await database.get(sql);

  if (!user) {
    user = await database.addUser(address, currentIp);
  }

  if (!claimCooldownPassed(user.lastClaim)) {
    const nextClaimAvailableAt = new Date(
      new Date(user.lastClaim).getTime() + 24 * 60 * 60 * 1000
    );
    const timeLeft = nextClaimAvailableAt.getTime() - new Date().getTime();
    const hours = Math.round(timeLeft/1000/60/60%24);

    res.status(418).json({ error: `Claim too soon. Come back in ${hours} ${hours > 1 ? 'hours' : 'hour'}` });
    logMessages.push('User is on cooldown');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('User is not on cooldown');
  // 6. Check wether address is blacklisted
  if (user.banned) {
    res.status(418).json({ error: "You were banned. Bye" });
    logMessages.push('User banned');
    console.log(logMessages.join(' '));
    return;
  }
  logMessages.push('User is not banned');
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
      res.status(418).json({ error: "Already claimed from this IP" });
      logMessages.push('Same IP check failed');
      console.log(logMessages.join(' '));
      return;
    }
  }
  logMessages.push('IP check passed');
  // 8. All good. Send
  
  try {  
    const hash = await banano.sendBananoWithdrawalFromSeed(config.seed, 0 /* index */, address, config.claimAmount);
    res.json({ hash: hash });
    logMessages.push(`Claim successfull, hash: ${hash}`);
  } catch (e) {
    res.status(500).json({ error: err });
    logMessages.push('Send banano failed and catched');
  }

  // 8.1 Check transaction?!

  // 9. Update user ip, lastClaim
  const setIpSql = `UPDATE Users SET ip = '${currentIp}', lastClaim = '${new Date().toISOString()}' WHERE address ='${address}'`;
  database
    .run(setIpSql)
    .then(() => {
      //updates silently
      // res.json({ message: "Successful claim"});
      logMessages.push('User updated after a claim');
      console.log(logMessages.join(' '));
      return;
    })
    .catch((err) => {
      logMessages.push(err);
      console.log(logMessages.join(' '));
      res.status(500).json({ error: "Something went wrong. Hold on" });
      return;
    });
});

app.get("/faucets", async function(req, res) {
  const faucetList = [{
    name: "BanFaucet",
    url: "banfaucet.com",
    frequency: "5 min",
    address: ""
  },
  {
    name: "K3i's Faucet",
    url: "bananofaucet.online",
    frequency: "30 min",
    address: ""
  },
  {
    name: "Banano Planet",
    url: "bananoplanet.cc",
    frequency: "2 hours",
    address: "ban_3p1anetee7arfx9zbmspwf9c8c5r88wy6zkgwcbt7rndtcqsoj6fzuy11na3"
  },
  {
    name: "Try Banano",
    url: "trybanano.com",
    frequency: "2 hours",
    address: "ban_33umod1td1x1szyjxj1a4c66j8s5escrii6ptnykz9axcsce93dqguwgwf78"
  },
  {
    name: "BanBucket",
    url: "www.banbucket.ninja",
    frequency: "15 hours",
    address: "ban_1j3rqseffoin7x5z5y1ehaqe1n7todza41kdf4oyga8phps3ea31u39ruchu"
  },
  {
    name: "NanSwap",
    url: "nanswap.com/get-free-banano",
    frequency: "daily",
    address: "ban_36seefx46pwcpyp6a8kukybamqioam6a7jef88s8esjpubyc8urccebjqgyj"
  },
  {
    name: "Nano2Go",
    url: "nano2go.herokuapp.com",
    frequency: "daily",
    address: "ban_36seefx46pwcpyp6a8kukybamqioam6a7jef88s8esjpubyc8urccebjqgyj"
  },
  {
    name: "icanhaznano faucet",
    url: "icanhaznano.monke42.tk",
    frequency: "daily",
    address: "ban_1monkecrqoqr6j6qzhtd9i8x49ujdnoqt7ramt9jmhd543icsrx5accoqtd5"
  },
  {
    name: "MonkeyTalks",
    url: "monkeytalks.cc",
    frequency: "daily",
    address: "ban_1monkeyt1x77a1rp9bwtthajb8odapbmnzpyt8357ac8a1bcron34i3r9y66"
  },
  {
    name: "TNV's Faucet",
    url: "banano-faucet.herokuapp.com",
    frequency: "daily",
    address: "ban_3uf1gx114fqm9ppiwp3sw1mywzzr9d8uwhrw9e85zpgdt48eopruqnqpdb68"
  },
  {
    name: "Prussia's Faucet",
    url: "faucet.prussia.dev",
    frequency: "daily",
    address: "ban_3346kkobb11qqpo17imgiybmwrgibr7yi34mwn5j6uywyke8f7fnfp94uyps"
  },
  {
    name: "BananoForest",
    url: "faucet.bananoforest.com",
    frequency: "daily",
    address: "ban_3sinkoff1yj9z5fougwao1gbjtsmb98u1j5p9kcrndqcc4irdxgzsjbem96e"
  },
  {
    name: "csquarednz's banano dispensary",
    url: "getban.csquared.nz",
    frequency: "daily",
    address: "ban_3jyqzypmcn94dmyp7eb3k85sug1568xwehzx738o5jniaxaf1jpxdakjz96r"
  },
  // {
  //   name: "BananoTime's Faucet",
  //   url: "faucet.bananotime.com",
  //   frequency: "daily",
  //   address: ""
  // },
  {
    name: "Perry's Banano Faucet",
    url: "banfaucet.perrypal21.repl.co",
    frequency: "daily",
    address: "ban_3tn9xt9sxbyw9injikki3yis5fbn6m47x37gco5cw6e6x6z7z4639cdgzke6"
  },
  {
    name: "iMalFect's Faucet",
    url: "getbanano.cc",
    frequency: "daily",
    address: "ban_1w9xjfydphp3cpmfjtnmfstjo3t4kr7n3zfwzaq4i7crpmjzc9535z1j5ahf"
  },
  {
    name: "OnlyBans",
    url: "www.only-bans.cc",
    frequency: "daily",
    address: "ban_1on1ybanskzzsqize1477wximtkdzrftmxqtajtwh4p4tg1w6awn1hq677cp"
  },
  {
    name: "Nord Faucet",
    url: "nord.valejo.net",
    frequency: "daily",
    address: ""
  },
  {
    name: "Bat's Faucet",
    url: "banhub.com",
    frequency: "daily",
    address: ""
  },
  {
    name: "BananoDrip",
    url: "bananodrip.com",
    frequency: "daily",
    address: ""
  },
  {
    name: "BananoFaucet.club",
    url: "www.bananofaucet.club", /* on sale */
    frequency: "",
    address: ""
  },
  {
    name: "Earns.cc Faucet",
    url: "ban.earns.cc",
    frequency: "daily",
    address: ""
  },
  {
    name: "BauCarp",
    url: "baucarp.herokuapp.com",
    frequency: "daily",
    address: ""
  },
  {
    name: "BananoFaucet",
    url: "bananofaucet.cc",
    frequency: "weekly",
    address: "ban_1faucetjuiyuwnz94j4c7s393r95sk5ac7p5usthmxct816osgqh3qd1caet"
  },
  {
    name: "Bonobo Faucet",
    url: "bonobo.cc/faucet",
    frequency: "weekly",
    address: "ban_3faubo4bfzexkbodi67c74ut1a6it64chofgobbag87yfmy1x457jbsdccd4"
  },
  {
    name: "Yet Another Ban Faucet",
    url: "yet-another-ban-faucet.herokuapp.com",
    frequency: "daily",
    address: ""
  },
  {
    name: "Pronoun Faucet",
    url: "banpridefaucet.repl.co",
    frequency: "daily",
    address: "ban_3eeq61ea33jdds5x37otx51esi8wsnxxjc8spjajyq7pj8h3nodkd19pride"
  },
  {
    name: "Barrel O' Bananos",
    url: "barrel.devinmontes.com",
    frequency: "daily",
    address: "ban_1barre1777qqdcg86788tk6ojy9jmkyb8ridreezbgkhr7btnoqcntejrxhf"
  }, {
    name: "Gorilla Nation",
    url: "gorillanation.ga",
    frequency: "daily",
    address: "ban_1gori11a7fz3tee6aydqxcehttzbuk93pjsctanfkgqmesa3dmo1cyw89xex"
  }];

  res.json(faucetList);
});

app.get('/faucetstatus', async (req, res) => {
  const url = req.query.url.split('/')[0];
  const path = req.query.url.split('/')[1];
  const account = req.query.account;
  
  const httpRequest = await https.request({
    host: url,
    path: path,
    method: 'HEAD'
  }, response => {
    response.on('data', () => {});
    response.on('error', err => { 
      console.log('I think we got an error here'); //doesn't work on connection refused
    })
    response.on('end', () => {
      
    })
  }).end();

  const info = {
    status: response.statusCode,
    lastTrx: {
      date: null,
      amount: null
    }
  };

  if (!account) {
    return res.status(418).json(info);
  }

  banano.getAccountHistory(account, 10)
    .then( acnt => { 
  
      const sent = acnt.history.filter( trx => trx.type === 'send' );
  
      if (sent.length === 0) {
        return res.json(info);
      }
      
      const lastTrx = sent.sort( (a,b) => new Date(a.local_timestamp * 1000) > new Date(b.local_timestamp * 1000)).pop();
      info.lastTrx.date = new Date(lastTrx.local_timestamp * 1000);
      info.lastTrx.amount = lastTrx.amount_decimal;
      return res.json(info);
    }).catch(e => {
      res.status(418).json(info);
    })
  
});

process.on('uncaughtException', function (err) {
  console.log(err);
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
