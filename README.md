# EOSIO Powerup Governor (beta)

Simple script to keep your account resources managed using eosio::powerup

#### 0. Clone this
```
git clone https://github.com/eosrio/powerup-governor.git
cd powerup-governor
```

#### 1. Create a special permission for automating powerup calls. (recommended)

#### 2. Rename `example.config.ts` to `config.ts` and update your settings. Add managed accounts and payer accounts.
```bash
cp example.config.ts config.ts
```

#### 3. Install and Build
```bash
npm install
npm run build
```

#### 4. Run
```bash
npm start
```
