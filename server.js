const express = require('express');
const http = require('http');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { Server } = require('socket.io');
const cors = require('cors');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const resolveSrv = promisify(dns.resolveSrv);

// --- BLINDAGEM GLOBAL CONTRA CRASHES INESPERADOS ---
process.on('uncaughtException', (err) => {
  const errMsg = err && err.message ? err.message : String(err);
  console.error(`\x1b[31m[CRITICAL UNCAUGHT EXCEPTION PREVENTED]\x1b[0m ${errMsg}`);
  if (err && err.code) {
    console.error(`Código do erro: ${err.code} | Syscall: ${err.syscall || 'N/A'}`);
  }
});

process.on('unhandledRejection', (reason) => {
  const reasonMsg = reason && reason.message ? reason.message : String(reason);
  console.error(`\x1b[33m[UNHANDLED REJECTION PREVENTED]\x1b[0m ${reasonMsg}`);
});

const MobFarmerMacro = require('./macros/mob_farmer');
const MobVipMacro = require('./macros/mob_vip');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const CONFIG_FILE = path.join(__dirname, 'config.json');

class ConfigStorageManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      defaultPassword: '',
      proxiesText: '',
      proxyList: [],
      accounts: {},
      metrics: {},
      diamondStock: { home: 'diamante1', packs: 0 },
      sharedState: {
        totalProfit: 0,
        repairedSwordsCount: 0,
        usedSwordsCount: 0
      }
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          defaultPassword: parsed.defaultPassword || '',
          proxiesText: parsed.proxiesText || '',
          proxyList: parsed.proxyList || [],
          accounts: parsed.accounts || {},
          metrics: parsed.metrics || {},
          diamondStock: parsed.diamondStock || { home: 'diamante1', packs: 0 },
          sharedState: parsed.sharedState || {
            totalProfit: 0,
            repairedSwordsCount: 0,
            usedSwordsCount: 0
          }
        };
        console.log(`💾 [STORAGE] Configurações carregadas (${Object.keys(this.data.accounts).length} contas, ${this.data.proxyList.length} proxies na lista).`);
      } else {
        this.save();
      }
    } catch (err) {
      console.error(`❌ [STORAGE] Erro ao carregar config.json: ${err.message}`);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error(`❌ [STORAGE] Erro ao salvar config.json: ${err.message}`);
    }
  }

  setDefaultPassword(pass) {
    this.data.defaultPassword = pass;
    this.save();
  }

  getDefaultPassword() {
    return this.data.defaultPassword;
  }

  setProxies(proxiesText, proxyList) {
    this.data.proxiesText = proxiesText;
    this.data.proxyList = proxyList;
    this.save();
  }

  getProxiesText() {
    return this.data.proxiesText || '';
  }

  getProxyList() {
    return this.data.proxyList || [];
  }

  // Rotação de proxies: busca a próxima proxy válida da lista respeitando o teto de 2 contas
  getNextProxy(currentProxy, forUsername) {
    if (!this.data.proxyList || this.data.proxyList.length === 0) {
      return null;
    }

    const accounts = this.data.accounts || {};
    const usageCount = new Map();
    this.data.proxyList.forEach((_, idx) => {
      usageCount.set(idx, 0);
    });

    Object.values(accounts).forEach((acc) => {
      if (acc.username.toLowerCase() === forUsername.toLowerCase()) return;
      if (acc.macroType === 'mob_vip') return;
      if (acc.proxy && acc.proxy.host) {
        const foundIdx = this.data.proxyList.findIndex(
          (p) => p.host === acc.proxy.host && parseInt(p.port) === parseInt(acc.proxy.port)
        );
        if (foundIdx !== -1) {
          usageCount.set(foundIdx, (usageCount.get(foundIdx) || 0) + 1);
        }
      }
    });

    // Filtra proxies que sejam diferentes da que acabou de falhar
    let candidates = this.data.proxyList
      .map((p, idx) => ({ proxy: p, index: idx, count: usageCount.get(idx) || 0 }))
      .filter((item) => {
        if (!currentProxy || !currentProxy.host) return true;
        return !(item.proxy.host === currentProxy.host && parseInt(item.proxy.port) === parseInt(currentProxy.port));
      });

    // Prioriza proxies com menos de 2 contas alocadas
    const underLimit = candidates.filter((item) => item.count < 2);
    if (underLimit.length > 0) {
      candidates = underLimit;
    }

    if (candidates.length === 0) {
      return { ...this.data.proxyList[0] };
    }

    candidates.sort((a, b) => a.count - b.count);
    return { ...candidates[0].proxy };
  }

  getAccount(username) {
    return this.data.accounts[username.toLowerCase()] || null;
  }

  saveAccount(acc) {
    this.data.accounts[acc.username.toLowerCase()] = acc;
    this.save();
  }

  deleteAccount(username) {
    delete this.data.accounts[username.toLowerCase()];
    delete this.data.metrics[username];
    this.save();
  }

  getAccounts() {
    return this.data.accounts;
  }

  updateMetrics(username, metricsData) {
    this.data.metrics[username] = metricsData;
    this.save();
  }

  getMetrics(username) {
    return this.data.metrics[username] || null;
  }

  getAllMetrics() {
    return this.data.metrics;
  }

  setDiamondStock(stock) {
    this.data.diamondStock = stock;
    this.save();
  }

  getDiamondStock() {
    return this.data.diamondStock;
  }

  setSharedState(state) {
    this.data.sharedState = state;
    this.save();
  }

  getSharedState() {
    return this.data.sharedState;
  }
}

const configStorage = new ConfigStorageManager(CONFIG_FILE);

function rotateProxyForAccount(username) {
  const acc = configStorage.getAccount(username);
  if (!acc || acc.macroType === 'mob_vip') return null;

  const newProxy = configStorage.getNextProxy(acc.proxy, username);
  if (!newProxy) return null;

  acc.proxy = newProxy;
  configStorage.saveAccount(acc);
  io.emit('accounts_updated', configStorage.getAccounts());
  return newProxy;
}

async function resolveMinecraftServer(hostname, defaultPort = 25565) {
  try {
    const srvRecords = await resolveSrv(`_minecraft._tcp.${hostname}`);
    if (srvRecords && srvRecords.length > 0) {
      const best = srvRecords.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: best.name, port: best.port };
    }
  } catch (err) {}
  return { host: hostname, port: defaultPort };
}

function createHttpConnectTunnel(proxy, destination) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: proxy.host,
      port: parseInt(proxy.port),
      timeout: 12000
    });

    socket.once('connect', () => {
      let req = `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\n` +
                `Host: ${destination.host}:${destination.port}\r\n`;

      if (proxy.user && proxy.pass) {
        const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
        req += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      req += '\r\n';

      socket.write(req);
    });

    let headerBuf = '';
    const onData = (chunk) => {
      headerBuf += chunk.toString();
      if (headerBuf.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        const statusLine = headerBuf.split('\r\n')[0];
        if (statusLine.includes(' 200 ')) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`Proxy HTTP recusou o túnel: ${statusLine}`));
        }
      }
    };

    socket.on('data', onData);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout ao conectar na proxy HTTP'));
    });
    socket.once('error', (err) => {
      reject(err);
    });
  });
}

class SharedStateManager {
  constructor() {
    const persistedState = configStorage.getSharedState();
    this.totalProfit = persistedState.totalProfit || 0;
    this.repairedSwordsCount = persistedState.repairedSwordsCount || 0;
    this.usedSwordsCount = persistedState.usedSwordsCount || 0;
    this.diamondStock = configStorage.getDiamondStock();

    this.accountMetrics = new Map();
    const savedMetrics = configStorage.getAllMetrics();
    Object.keys(savedMetrics).forEach((user) => {
      this.accountMetrics.set(user, savedMetrics[user]);
    });
  }

  saveState() {
    configStorage.setSharedState(this.getState());
  }

  addProfit(botName, amount, isVip = false) {
    this.totalProfit += amount;
    this.saveState();
    broadcastSharedState();

    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      mobsKilled: 0,
      connectTime: Date.now(),
      isVip
    };

    current.dailyMoney += amount;
    this.accountMetrics.set(botName, current);
    configStorage.updateMetrics(botName, current);
    broadcastAccountMetrics(botName);
  }

  registerMobKill(botName) {
    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      mobsKilled: 0,
      connectTime: Date.now(),
      isVip: false
    };

    current.mobsKilled = (current.mobsKilled || 0) + 1;
    this.accountMetrics.set(botName, current);
    configStorage.updateMetrics(botName, current);
    broadcastAccountMetrics(botName);
  }

  updateAccountMoneyBalance(botName, parsedMoney) {
    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      mobsKilled: 0,
      connectTime: Date.now(),
      isVip: false
    };

    current.currentMoney = parsedMoney;
    this.accountMetrics.set(botName, current);
    configStorage.updateMetrics(botName, current);
    broadcastAccountMetrics(botName);
  }

  registerMoneyTransfer(botName, amount) {
    const current = this.accountMetrics.get(botName);
    if (current) {
      current.currentMoney = Math.max(0, current.currentMoney - amount);
      this.accountMetrics.set(botName, current);
      configStorage.updateMetrics(botName, current);
      broadcastAccountMetrics(botName);
    }
  }

  addDropsSold(botName, packs) {
    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      mobsKilled: 0,
      connectTime: Date.now(),
      isVip: false
    };

    current.dropsSoldPacks += packs;
    this.accountMetrics.set(botName, current);
    configStorage.updateMetrics(botName, current);
    broadcastAccountMetrics(botName);
  }

  updateDiamondStock(home, packs) {
    this.diamondStock = { home, packs };
    configStorage.setDiamondStock(this.diamondStock);
    io.emit('diamond_stock_update', this.diamondStock);
  }

  addRepairedSwords(count, botName) {
    this.repairedSwordsCount += count;
    this.saveState();
    broadcastSharedState();
  }

  async claimNextSwordSlot(botName) {
    this.usedSwordsCount++;
    this.saveState();
    emitLog('SISTEMA', `📌 Espada #${this.usedSwordsCount} reservada por ${botName}. Total na fila para reparo: ${this.usedSwordsCount}`, true);
    broadcastSharedState();
    return this.usedSwordsCount;
  }

  getUsedSwords() {
    return this.usedSwordsCount;
  }

  setUsedSwords(val, author) {
    this.usedSwordsCount = Math.max(0, val);
    this.saveState();
    emitLog('SISTEMA', `Variável [usedSwordsCount] alterada para ${this.usedSwordsCount} por ${author}.`, true);
    broadcastSharedState();
  }

  adjustUsedSwords(amount, author) {
    const step = amount > 0 ? 1 : -1;
    this.usedSwordsCount = Math.max(0, this.usedSwordsCount + step);
    this.saveState();
    emitLog('SISTEMA', `Fila de espadas ajustada para ${this.usedSwordsCount} por ${author}.`, true);
    broadcastSharedState();
  }

  getState() {
    return {
      totalProfit: this.totalProfit,
      repairedSwordsCount: this.repairedSwordsCount,
      usedSwordsCount: this.usedSwordsCount
    };
  }
}

const sharedState = new SharedStateManager();

const activeBots = new Map();
const activeMacros = new Map();
const botMetas = new Map();
const reconnectTimers = new Map();
const isReconnecting = new Set();

function emitLog(username, message, isSystem = false) {
  const time = new Date().toLocaleTimeString();
  const logData = {
    username: username || 'SISTEMA',
    message: message,
    time: time,
    isSystem: isSystem
  };

  const prefix = isSystem ? `[SISTEMA]` : `[${username}]`;
  console.log(`[${time}] ${prefix} ${message}`);
  io.emit('log_message', logData);
}

function broadcastSharedState() {
  io.emit('state_update', sharedState.getState());
}

function broadcastAccountMetrics(username) {
  const m = sharedState.accountMetrics.get(username);
  if (m) {
    io.emit('account_metrics_update', m);
  }
}

function broadcastBotStatus(username) {
  const meta = botMetas.get(username);
  if (!meta) return;

  io.emit('bot_status', {
    username,
    isVip: meta.isVip,
    macroName: meta.macroName,
    paused: meta.paused,
    connected: meta.connected
  });
}

function emitInventoryData(username, bot) {
  if (!bot || !bot.inventory) return;

  const slots = [];
  for (let s = 9; s <= 44; s++) {
    const item = bot.inventory.slots[s];
    if (item) {
      slots.push({
        slot: s,
        name: item.name,
        count: item.count,
        durabilityUsed: item.durabilityUsed !== undefined ? item.durabilityUsed : (item.metadata || 0)
      });
    }
  }

  io.emit('inventory_data', { username, slots });
}

function scheduleReconnect(username, botConfig) {
  const meta = botMetas.get(username);
  if (!meta || meta.manualDisconnect) return;

  if (isReconnecting.has(username)) {
    return;
  }
  isReconnecting.add(username);

  meta.connected = false;
  broadcastBotStatus(username);

  let newConfig = { ...botConfig };
  let delay = 30000 + Math.floor(Math.random() * 6000);

  // Se for conta SEM VIP e possuir proxy, rotaciona automaticamente para a próxima proxy da lista
  if (botConfig.macroType !== 'mob_vip' && botConfig.proxy) {
    const rotated = rotateProxyForAccount(username);
    if (rotated) {
      newConfig.proxy = rotated;
      botConfig.proxy = rotated;
      delay = 6000 + Math.floor(Math.random() * 3000); // Tenta a nova proxy em apenas 6s a 9s
      emitLog(username, `🔄 Proxy falhou. Alternando para nova proxy: ${rotated.host}:${rotated.port}. Reconectando em ${(delay / 1000).toFixed(0)}s...`);
    } else {
      emitLog(username, `⏳ Conexão/Proxy instável. Próxima tentativa em ${(delay / 1000).toFixed(0)}s...`);
    }
  } else {
    emitLog(username, `⏳ Conexão/DNS instável. Próxima tentativa em ${(delay / 1000).toFixed(0)}s...`);
  }

  const timer = setTimeout(() => {
    isReconnecting.delete(username);
    reconnectTimers.delete(username);

    const currentMeta = botMetas.get(username);
    if (currentMeta && !currentMeta.manualDisconnect) {
      emitLog(username, '🔄 Disparando tentativa de reconexão...');
      createBotInstance(newConfig);
    }
  }, delay);

  reconnectTimers.set(username, timer);
}

async function createBotInstance(botConfig) {
  const { username, password, host, port, macroType, proxy } = botConfig;

  if (activeMacros.has(username)) {
    try { activeMacros.get(username).stop(); } catch (e) {}
    activeMacros.delete(username);
  }
  if (activeBots.has(username)) {
    try {
      const oldBot = activeBots.get(username);
      oldBot.removeAllListeners();
      if (oldBot._client) oldBot._client.removeAllListeners();
      oldBot.quit();
    } catch (e) {}
    activeBots.delete(username);
  }

  const rawHost = host ? host.trim() : 'solaris.craftlandia.com.br';
  const rawPort = parseInt(port) || 25565;

  let resolvedTarget;
  try {
    resolvedTarget = await resolveMinecraftServer(rawHost, rawPort);
  } catch (err) {
    resolvedTarget = { host: rawHost, port: rawPort };
  }

  const options = {
    host: resolvedTarget.host,
    port: resolvedTarget.port,
    username: username,
    version: '1.8.9',
    viewDistance: 'tiny',
    skipValidation: true,
    checkTimeoutInterval: 45000
  };

  if (proxy && proxy.host && proxy.port) {
    options.connect = (client) => {
      SocksClient.createConnection({
        proxy: {
          host: proxy.host.trim(),
          port: parseInt(proxy.port),
          type: 5,
          userId: proxy.user ? proxy.user.trim() : undefined,
          password: proxy.pass ? proxy.pass.trim() : undefined
        },
        command: 'connect',
        destination: {
          host: resolvedTarget.host,
          port: resolvedTarget.port
        },
        timeout: 12000
      })
      .then(({ socket }) => {
        client.setSocket(socket);
        client.emit('connect');
      })
      .catch((socksErr) => {
        createHttpConnectTunnel(proxy, resolvedTarget)
          .then((httpSocket) => {
            client.setSocket(httpSocket);
            client.emit('connect');
          })
          .catch((httpErr) => {
            client.emit('error', httpErr);
          });
      });
    };
  }

  let bot;
  try {
    bot = mineflayer.createBot(options);
  } catch (err) {
    emitLog(username, `❌ Erro ao criar instância do bot: ${err.message}`);
    scheduleReconnect(username, botConfig);
    return;
  }

  const earlyErrorHandler = (err) => {
    emitLog(username, `⚠️ Falha de rede/DNS capturada: ${err ? err.message : 'Erro desconhecido'}`);
    handleDisconnectEvent('early_error');
  };

  bot.on('error', earlyErrorHandler);
  if (bot._client) {
    bot._client.on('error', earlyErrorHandler);
  }

  const isVip = macroType === 'mob_vip';
  const friendlyMacroName = isVip ? 'Mata Mob (VIP)' : 'Mata Mob (Sem VIP)';

  let meta = botMetas.get(username);
  if (!meta) {
    meta = {
      isVip,
      macroName: friendlyMacroName,
      paused: false,
      connected: false,
      password: password || null,
      spawned: false,
      manualDisconnect: false,
      config: botConfig
    };
    botMetas.set(username, meta);
  } else {
    meta.macroName = friendlyMacroName;
    meta.isVip = isVip;
    meta.config = botConfig;
  }

  meta.manualDisconnect = false;
  meta.connected = false;
  meta.spawned = false;
  activeBots.set(username, bot);

  const botLogger = (msg) => emitLog(username, msg);
  let macroInstance = null;

  if (macroType === 'mob_vip') {
    macroInstance = new MobVipMacro(bot, { username }, botLogger, sharedState);
  } else {
    macroInstance = new MobFarmerMacro(bot, { username }, botLogger, sharedState);
  }
  activeMacros.set(username, macroInstance);

  let connectionHandled = false;
  const connectionTimeout = setTimeout(() => {
    if (!meta.connected) {
      emitLog(username, '⚠️ Timeout ao aguardar resposta do servidor (proxy sem resposta)...');
      try { bot.quit(); } catch (e) {}
      handleDisconnectEvent('timeout');
    }
  }, 25000);

  bot._client.once('connect', () => {
    emitLog(username, '🔌 Handshake estabelecido.');
  });

  bot.once('login', () => {
    clearTimeout(connectionTimeout);
    emitLog(username, '🔑 Autenticado. Aguardando spawn do jogador...');
  });

  bot.on('messagestr', (message) => {
    const raw = message.toString().trim();
    if (!raw) return;

    io.emit('bot_chat_message', {
      username: username,
      message: raw,
      time: new Date().toLocaleTimeString()
    });

    const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
    const lower = clean.toLowerCase();

    if (lower.includes('saldo atual:') && lower.includes('coins')) {
      const match = clean.match(/saldo atual:\s*([\d,\.]+)\s*Coins/i);
      if (match && match[1]) {
        const rawNum = match[1].replace(/,/g, '');
        const val = parseFloat(rawNum);
        if (!isNaN(val)) {
          sharedState.updateAccountMoneyBalance(username, val);
          emitLog(username, `💵 Saldo atualizado: ${val.toFixed(2)} Coins.`);
        }
      }
    }

    if ((lower.includes('/login') || lower.includes('registre-se') || lower.includes('por favor digite')) && meta.password) {
      setTimeout(() => {
        bot.chat(`/login ${meta.password}`);
        emitLog(username, 'Comando /login enviado.');
      }, 1000);
    }
  });

  bot.once('spawn', () => {
    clearTimeout(connectionTimeout);
    isReconnecting.delete(username);
    if (reconnectTimers.has(username)) {
      clearTimeout(reconnectTimers.get(username));
      reconnectTimers.delete(username);
    }

    meta.connected = true;
    meta.spawned = true;
    emitLog(username, '✨ Spawn confirmado! Reiniciando macro...');
    broadcastBotStatus(username);

    if (!sharedState.accountMetrics.has(username)) {
      const initialMetrics = {
        username: username,
        currentMoney: 0,
        dailyMoney: 0,
        dropsSoldPacks: 0,
        mobsKilled: 0,
        connectTime: Date.now(),
        isVip
      };
      sharedState.accountMetrics.set(username, initialMetrics);
      configStorage.updateMetrics(username, initialMetrics);
      broadcastAccountMetrics(username);
    }

    setTimeout(() => {
      bot.chat('/money');
    }, 4000);

    const moneyInterval = setInterval(() => {
      if (activeBots.has(username) && meta.connected) {
        bot.chat('/money');
      } else {
        clearInterval(moneyInterval);
      }
    }, 3600000);

    if (bot.inventory) {
      bot.inventory.on('updateSlot', () => emitInventoryData(username, bot));
    }
    bot.on('playerCollect', () => emitInventoryData(username, bot));

    setTimeout(() => {
      emitInventoryData(username, bot);
      macroInstance.start().catch((err) => {
        emitLog(username, `Erro na execução da macro: ${err.message}`);
      });
    }, 2500);
  });

  const handleDisconnectEvent = (reason) => {
    if (connectionHandled) return;
    connectionHandled = true;

    clearTimeout(connectionTimeout);

    if (activeMacros.has(username)) {
      try { activeMacros.get(username).stop(); } catch (e) {}
    }

    if (!meta.manualDisconnect) {
      scheduleReconnect(username, botConfig);
    }
  };

  bot.on('kicked', (reason) => {
    const text = typeof reason === 'object' ? JSON.stringify(reason) : reason;
    emitLog(username, `Expulso: ${text}`);
    handleDisconnectEvent('kicked');
  });

  bot.on('end', () => {
    emitLog(username, 'Conexão encerrada pelo servidor.');
    handleDisconnectEvent('end');
  });
}

function cleanupBot(username) {
  const meta = botMetas.get(username);
  if (meta) {
    meta.manualDisconnect = true;
  }

  isReconnecting.delete(username);
  if (reconnectTimers.has(username)) {
    clearTimeout(reconnectTimers.get(username));
    reconnectTimers.delete(username);
  }

  const macro = activeMacros.get(username);
  if (macro) {
    try { macro.stop(); } catch (e) {}
    activeMacros.delete(username);
  }

  const bot = activeBots.get(username);
  if (bot) {
    try {
      bot.removeAllListeners();
      if (bot._client) bot._client.removeAllListeners();
      bot.quit();
    } catch (e) {}
    activeBots.delete(username);
  }

  botMetas.delete(username);
  io.emit('bot_removed', { username });
  emitLog('SISTEMA', `Conta ${username} desconectada manualmente.`, true);
}

async function executeTwoStepTransfer(bot, username, targetUser, amount) {
  if (!bot || amount <= 0 || username.toLowerCase() === targetUser.toLowerCase()) return;
  const floorVal = Math.floor(amount);

  emitLog(username, `💸 Transferindo ${floorVal} Coins para ${targetUser} (Etapa 1/2)...`);
  bot.chat(`/money pay ${targetUser} ${floorVal}`);

  setTimeout(() => {
    emitLog(username, `💸 Confirmando envio de ${floorVal} Coins para ${targetUser} (Etapa 2/2)...`);
    bot.chat(`/money pay ${targetUser} ${floorVal}`);
    sharedState.registerMoneyTransfer(username, floorVal);
  }, 1000);
}

io.on('connection', (socket) => {
  const activeList = [];
  botMetas.forEach((meta, user) => {
    activeList.push({
      username: user,
      isVip: meta.isVip,
      macroName: meta.macroName,
      paused: meta.paused,
      connected: meta.connected
    });
  });

  const allMetrics = Array.from(sharedState.accountMetrics.values());

  socket.emit('init_state', {
    sharedState: sharedState.getState(),
    activeBots: activeList,
    diamondStock: sharedState.diamondStock,
    allAccountMetrics: allMetrics,
    savedAccounts: configStorage.getAccounts(),
    defaultPassword: configStorage.getDefaultPassword(),
    proxiesText: configStorage.getProxiesText()
  });

  socket.on('save_default_password', ({ password }) => {
    configStorage.setDefaultPassword(password);
    io.emit('default_password_updated', { password });
    emitLog('SISTEMA', '🔑 Senha padrão atualizada no disco (config.json).', true);
  });

  socket.on('start_bot', (data) => {
    if (!data || !data.username) return;

    configStorage.saveAccount({
      username: data.username,
      useDefaultPassword: data.useDefaultPassword || false,
      password: data.useDefaultPassword ? '' : (data.password || ''),
      host: data.host || 'solaris.craftlandia.com.br',
      port: data.port || 25565,
      macroType: data.macroType || 'mob_farmer',
      proxy: data.proxy || null
    });

    io.emit('accounts_updated', configStorage.getAccounts());

    const effectivePass = data.useDefaultPassword
      ? configStorage.getDefaultPassword()
      : data.password;

    createBotInstance({
      ...data,
      password: effectivePass
    });
  });

  socket.on('update_account_macro', ({ username, macroType }) => {
    const acc = configStorage.getAccount(username);
    if (acc) {
      acc.macroType = macroType;
      configStorage.saveAccount(acc);
      io.emit('accounts_updated', configStorage.getAccounts());
      emitLog('SISTEMA', `Macro da conta ${username} alterada para ${macroType} no config.json.`, true);
    }
  });

  socket.on('delete_account', ({ username }) => {
    cleanupBot(username);
    configStorage.deleteAccount(username);
    sharedState.accountMetrics.delete(username);
    io.emit('accounts_updated', configStorage.getAccounts());
    emitLog('SISTEMA', `Conta ${username} removida do config.json.`, true);
  });

  socket.on('apply_batch_proxies', ({ proxiesText }) => {
    const lines = (proxiesText || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const parsedProxies = [];

    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        parsedProxies.push({
          host: parts[0].trim(),
          port: parseInt(parts[1].trim()),
          user: parts[2] ? parts[2].trim() : undefined,
          pass: parts[3] ? parts[3].trim() : undefined
        });
      }
    }

    if (parsedProxies.length === 0) return;

    // Salva a lista de proxies completa no config.json
    configStorage.setProxies(proxiesText, parsedProxies);

    const proxyPool = [];
    parsedProxies.forEach((p) => {
      proxyPool.push({ ...p });
      proxyPool.push({ ...p });
    });

    const allAccounts = configStorage.getAccounts();
    const nonVipAccounts = Object.values(allAccounts).filter((acc) => acc.macroType !== 'mob_vip');

    let assignedCount = 0;
    nonVipAccounts.forEach((acc, idx) => {
      if (idx >= proxyPool.length) return;
      acc.proxy = proxyPool[idx];
      configStorage.saveAccount(acc);
      assignedCount++;

      cleanupBot(acc.username);

      setTimeout(() => {
        const pass = acc.useDefaultPassword ? configStorage.getDefaultPassword() : acc.password;
        createBotInstance({
          username: acc.username,
          password: pass,
          host: acc.host,
          port: acc.port,
          macroType: acc.macroType,
          proxy: acc.proxy
        });
      }, 1500 + idx * 500);
    });

    io.emit('accounts_updated', configStorage.getAccounts());
    io.emit('proxies_updated', { proxiesText });
    emitLog('SISTEMA', `🔄 Distribuição de proxies em lote concluída: ${assignedCount} contas atualizadas no disco.`, true);
  });

  socket.on('toggle_pause', ({ username }) => {
    const macro = activeMacros.get(username);
    const meta = botMetas.get(username);
    if (!macro || !meta) return;

    if (meta.paused) {
      macro.resume();
      meta.paused = false;
      emitLog(username, 'Macro retomada pelo painel.');
    } else {
      macro.pause();
      meta.paused = true;
      emitLog(username, 'Macro pausada pelo painel.');
    }
    broadcastBotStatus(username);
  });

  socket.on('stop_bot', ({ username }) => {
    cleanupBot(username);
  });

  socket.on('reconnect_all_bots', () => {
    const accounts = Object.values(configStorage.getAccounts());
    if (accounts.length === 0) return;

    accounts.forEach((acc) => cleanupBot(acc.username));

    accounts.forEach((acc, idx) => {
      setTimeout(() => {
        const pass = acc.useDefaultPassword ? configStorage.getDefaultPassword() : acc.password;
        createBotInstance({
          username: acc.username,
          password: pass,
          host: acc.host,
          port: acc.port,
          macroType: acc.macroType,
          proxy: acc.proxy
        });
      }, 1200 + idx * 600);
    });

    emitLog('SISTEMA', `🔄 Reiniciando todas as ${accounts.length} contas salvas no disco...`, true);
  });

  socket.on('bot_chat', ({ username, message }) => {
    const bot = activeBots.get(username);
    if (!bot) return;

    emitLog(username, `[CHAT ENVIADO] ${message}`);
    bot.chat(message);
  });

  socket.on('request_inventory', ({ username }) => {
    const bot = activeBots.get(username);
    if (bot) {
      emitInventoryData(username, bot);
    }
  });

  socket.on('adjust_used_swords', ({ amount }) => {
    const step = amount > 0 ? 1 : -1;
    sharedState.adjustUsedSwords(step, 'Painel Web');
  });

  socket.on('reset_used_swords', () => {
    sharedState.setUsedSwords(0, 'Painel Web');
  });

  socket.on('transfer_all_to_fatal', () => {
    activeBots.forEach((bot, user) => {
      const metric = sharedState.accountMetrics.get(user);
      if (metric && metric.currentMoney > 0 && user.toLowerCase() !== 'fatal') {
        executeTwoStepTransfer(bot, user, 'Fatal', metric.currentMoney);
      }
    });
  });

  socket.on('transfer_single_to_fatal', ({ username }) => {
    const bot = activeBots.get(username);
    const metric = sharedState.accountMetrics.get(username);
    if (bot && metric && metric.currentMoney > 0) {
      executeTwoStepTransfer(bot, username, 'Fatal', metric.currentMoney);
    }
  });
});

function autoStartAllPersistedAccounts() {
  const accounts = Object.values(configStorage.getAccounts());
  if (accounts.length === 0) {
    console.log('ℹ️ [AUTO-BOOT] Nenhuma conta cadastrada no config.json para iniciar.');
    return;
  }

  console.log(`🚀 [AUTO-BOOT] Iniciando ${accounts.length} conta(s) salvas no disco em lote escalonado...`);
  accounts.forEach((acc, idx) => {
    setTimeout(() => {
      const pass = acc.useDefaultPassword ? configStorage.getDefaultPassword() : acc.password;
      createBotInstance({
        username: acc.username,
        password: pass,
        host: acc.host,
        port: acc.port,
        macroType: acc.macroType,
        proxy: acc.proxy
      });
    }, 1500 + idx * 800);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Painel e Backend ativos na porta ${PORT}`);
  console.log(`🌐 Interface: http://localhost:${PORT}`);
  console.log(`📁 Armazenamento persistente: ${CONFIG_FILE}`);
  console.log(`====================================================`);

  autoStartAllPersistedAccounts();
});