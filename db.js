const sqlite3 = require("sqlite3").verbose();
const dbFile = "./database.sqlite";
const fs = require("fs");
const dbExists = fs.existsSync(dbFile);

if (!dbExists) {
  fs.openSync(dbFile, "w");
}

const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    return console.error(err.message);
  }
  console.log("Successful connection to the database 'apptest.db'");
});

function initDb() {
  if (!dbExists) {
    const sqlCreate = `CREATE TABLE IF NOT EXISTS Users (
              "userId" INTEGER PRIMARY KEY AUTOINCREMENT,
              "address" VARCHAR(100) NOT NULL,
              "banned" INTEGER NOT NULL,
              "lastClaim" VARCHAR(100),
              "ip" VARCHAR(100),
              "comment" TEXT);`;
    const sqlInsert = `INSERT INTO Users (userId, address, banned, lastClaim, ip, comment) VALUES
              (1, 'ban_3gahaiusraz8qnotf3skqn3myo74o9f7hroqw8hhny51zkkx5ikbxsbat69c', 0, '2022-08-02 12:15:45.010', '::1', 'Butters, thats me'),
              (2, 'ban_3jo4o7j3z398xy4ywmjnaoqwfo1otnyrr4ubmd3pyshggf34hhcreuc6zkcw', 0, '2022-08-03 13:05:15.250', '192.168.0.1', 'Me me me me me me'),
              (3, 'ban_3qd5n746ituki74jxdruw4p38fp1rf9dyzh7woshuiz1j8eje95yw4mm955k', 0, '2022-08-03 22:03:11.123', '171.25.251.1', 'Unopened');`;

    const promise = new Promise((resolve, reject) => {
      db.run(sqlCreate, (err) => {
        if (err) {
          console.error(err.message);
          reject(err);
          return;
        }
        console.log("Created table Users");

        db.run(sqlInsert, (err) => {
          if (err) {
            console.error(err.message);
            reject(err);
            return;
          }
          console.log("Filled table Users with data");
          resolve(db);
        });
      });
    });
    return promise;
  }
  return Promise.resolve(db);
}

function get(sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, [], (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
}

function all(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
}

function run(sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, [], (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
}

function addUser(address, ip) {
  const sql = `INSERT INTO Users (address, banned, lastClaim, ip, comment) VALUES
    ('${address}', 0, '${"2000-01-01 01:01:01"}', '${ip}', 'Just created');`;
  return new Promise((resolve, reject) => {
    db.run(sql, [], (err) => {
      if (err) {
        reject(err);
      }
      get(`SELECT * FROM Users WHERE address='${address}'`)
        .then((user) => {
          resolve(user);
        })
        .catch((err) => {
          reject(err);
        });
    });
  });
}

module.exports = {
  initDb: initDb,
  get: get,
  all: all,
  run: run,
  addUser: addUser,
};
