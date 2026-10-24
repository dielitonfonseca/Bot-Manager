const express = require('express');
const http = require('http');
const net = require('net');
const dns = require('dns');
const { promisify } = require('util');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const resolveSrv = promisify(dns.resolveSrv);

const MobFarmerMacro = require('./macros/mob_farmer');
const MobVipMacro = require('./macros/mob_vip');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Resolução de registro SRV do servidor Minecraft antes de abrir o túnel
async function resolveMinecraftServer(hostname, defaultPort = 25565) {
  try {
    const srvRecords = await resolveSrv(`_minecraft._tcp.${hostname}`);
    if (srvRecords && srvRecords.length > 0) {
      const best = srvRecords.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: best.name, port: best.port };
    }
  } catch (err) {
    // Se não houver registro SRV, conecta direto no hostname informado
  }
  return { host: hostname, port: defaultPort };
}

// Criação de túnel HTTP CONNECT para proxies HTTP com autenticação
function createHttpConnectTunnel(proxy, destination) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: proxy.host,
      port: parseInt(proxy.port),
      timeout: 15000
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

// Gerenciador de Estado Global Compartilhado
class SharedStateManager {
  constructor() {
    this.totalProfit = 0;
    this.repairedSwordsCount = 0;
    this.usedSwordsCount = 0;
    this.diamondStock = { home: 'diamante1', packs: 0 };
    this.accountMetrics = new Map();
  }

  addProfit(botName, amount, isVip = false) {
    this.totalProfit += amount;
    broadcastSharedState();

    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      connectTime: Date.now(),
      isVip
    };

    current.dailyMoney += amount;
    this.accountMetrics.set(botName, current);
    broadcastAccountMetrics(botName);
  }

  updateAccountMoneyBalance(botName, parsedMoney) {
    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      connectTime: Date.now(),
      isVip: false
    };

    current.currentMoney = parsedMoney;
    this.accountMetrics.set(botName, current);
    broadcastAccountMetrics(botName);
  }

  registerMoneyTransfer(botName, amount) {
    const current = this.accountMetrics.get(botName);
    if (current) {
      current.currentMoney = Math.max(0, current.currentMoney - amount);
      this.accountMetrics.set(botName, current);
      broadcastAccountMetrics(botName);
    }
  }

  addDropsSold(botName, packs) {
    const current = this.accountMetrics.get(botName) || {
      username: botName,
      currentMoney: 0,
      dailyMoney: 0,
      dropsSoldPacks: 0,
      connectTime: Date.now(),
      isVip: false
    };

    current.dropsSoldPacks += packs;
    this.accountMetrics.set(botName, current);
    broadcastAccountMetrics(botName);
  }

  updateDiamondStock(home, packs) {
    this.diamondStock = { home, packs };
    io.emit('diamond_stock_update', this.diamondStock);
  }

  addRepairedSwords(count, botName) {
    this.repairedSwordsCount += count;
    broadcastSharedState();
  }

  async claimNextSwordSlot(botName) {
    this.usedSwordsCount++;
    emitLog('SISTEMA', `📌 Espada #${this.usedSwordsCount} reservada por ${botName}. Total na fila para reparo: ${this.usedSwordsCount}`, true);
    broadcastSharedState();
    return this.usedSwordsCount;
  }

  getUsedSwords() {
    return this.usedSwordsCount;
  }

  setUsedSwords(val, author) {
    this.usedSwordsCount = Math.max(0, val);
    emitLog('SISTEMA', `Variável [usedSwordsCount] alterada para ${this.usedSwordsCount} por ${author}.`, true);
    broadcastSharedState();
  }

  adjustUsedSwords(amount, author) {
    const step = amount > 0 ? 1 : -1;
    this.usedSwordsCount = Math.max(0, this.usedSwordsCount + step);
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

  if (reconnectTimers.has(username)) {
    clearTimeout(reconnectTimers.get(username));
  }

  meta.connected = false;
  broadcastBotStatus(username);

  emitLog(username, '⏳ Servidor indisponível ou reconectando. Tentando novamente em 30 segundos...');
  const timer = setTimeout(() => {
    reconnectTimers.delete(username);
    const currentMeta = botMetas.get(username);
    if (currentMeta && !currentMeta.manualDisconnect) {
      emitLog(username, '🔄 Tentando reconexão periódica agora...');
      createBotInstance(botConfig);
    }
  }, 30000);

  reconnectTimers.set(username, timer);
}

async function createBotInstance(botConfig) {
  const { username, password, host, port, macroType, proxy } = botConfig;

  if (activeBots.has(username)) {
    const existing = activeBots.get(username);
    if (existing && existing._client && !existing._client.destroyed) {
      return;
    }
  }

  const rawHost = host ? host.trim() : 'solaris.craftlandia.com.br';
  const rawPort = parseInt(port) || 25565;

  emitLog(username, `Resolvendo rota e registro SRV para ${rawHost}...`);
  const resolvedTarget = await resolveMinecraftServer(rawHost, rawPort);
  emitLog(username, `Destino resolvido com sucesso: ${resolvedTarget.host}:${resolvedTarget.port}`);

  const options = {
    host: resolvedTarget.host,
    port: resolvedTarget.port,
    username: username,
    version: '1.8.9', // Fixado para pular o ping de status conforme a dica 5
    viewDistance: 'tiny',
    skipValidation: true,
    checkTimeoutInterval: 45000
  };

  // Se houver proxy configurada, cria o túnel dedicado
  if (proxy && proxy.host && proxy.port) {
    emitLog(username, `Conectando túnel proxy ${proxy.host}:${proxy.port} -> ${resolvedTarget.host}:${resolvedTarget.port}...`);

    options.connect = (client) => {
      // 1. Tenta via SOCKS5
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
        timeout: 15000
      })
      .then(({ socket }) => {
        emitLog(username, '🔌 Túnel SOCKS5 estabelecido com sucesso!');
        client.setSocket(socket);
        client.emit('connect');
      })
      .catch((socksErr) => {
        emitLog(username, `⚠️ SOCKS5 falhou (${socksErr.message}). Tentando túnel HTTP CONNECT...`);

        // 2. Fallback para HTTP CONNECT (padrão Webshare)
        createHttpConnectTunnel(proxy, resolvedTarget)
          .then((httpSocket) => {
            emitLog(username, '🔌 Túnel HTTP CONNECT estabelecido com sucesso!');
            client.setSocket(httpSocket);
            client.emit('connect');
          })
          .catch((httpErr) => {
            emitLog(username, `❌ Todos os protocolos de proxy falharam: ${httpErr.message}`);
            // NUNCA conectar direto pelo IP local para não expor a máquina (Dica 7)
            client.emit('error', httpErr);
          });
      });
    };
  } else {
    emitLog(username, `Iniciando conexão direta com ${resolvedTarget.host}:${resolvedTarget.port}...`);
  }

  let bot;
  try {
    bot = mineflayer.createBot(options);
  } catch (err) {
    emitLog(username, `❌ Falha ao instanciar bot: ${err.message}`);
    scheduleReconnect(username, botConfig);
    return;
  }

  const isVip = macroType === 'mob_vip';
  const meta = botMetas.get(username) || {
    isVip,
    macroName: isVip ? 'Mata Mob (VIP)' : 'Mata Mob (Sem VIP)',
    paused: false,
    connected: false,
    password: password || null,
    spawned: false,
    manualDisconnect: false,
    config: botConfig
  };

  meta.manualDisconnect = false;
  meta.connected = false;
  meta.spawned = false;
  botMetas.set(username, meta);
  activeBots.set(username, bot);

  const botLogger = (msg) => emitLog(username, msg);
  let macroInstance = null;

  if (isVip) {
    macroInstance = new MobVipMacro(bot, { username }, botLogger, sharedState);
  } else {
    macroInstance = new MobFarmerMacro(bot, { username }, botLogger, sharedState);
  }

  activeMacros.set(username, macroInstance);

  const connectionTimeout = setTimeout(() => {
    if (!meta.connected) {
      emitLog(username, '⚠️ Timeout ao aguardar resposta do servidor.');
      try { bot.quit(); } catch (e) {}
      scheduleReconnect(username, botConfig);
    }
  }, 25000);

  bot._client.once('connect', () => {
    emitLog(username, '🔌 Handshake inicial concluído.');
  });

  bot.once('login', () => {
    clearTimeout(connectionTimeout);
    emitLog(username, '🔑 Autenticado na rede. Aguardando spawn do jogador...');
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
          emitLog(username, `💵 Saldo atualizado via /money: ${val.toFixed(2)} Coins.`);
        }
      }
    }

    if ((lower.includes('/login') || lower.includes('registre-se') || lower.includes('por favor digite')) && meta.password) {
      emitLog(username, 'Prompt de login identificado. Enviando senha em 1s...');
      setTimeout(() => {
        bot.chat(`/login ${meta.password}`);
        emitLog(username, 'Comando /login enviado.');
      }, 1000);
    }
  });

  bot.once('spawn', () => {
    clearTimeout(connectionTimeout);
    if (reconnectTimers.has(username)) {
      clearTimeout(reconnectTimers.get(username));
      reconnectTimers.delete(username);
    }

    meta.connected = true;
    meta.spawned = true;
    emitLog(username, '✨ Spawn confirmado! Retomando rotina...');
    broadcastBotStatus(username);

    if (!sharedState.accountMetrics.has(username)) {
      sharedState.accountMetrics.set(username, {
        username: username,
        currentMoney: 0,
        dailyMoney: 0,
        dropsSoldPacks: 0,
        connectTime: Date.now(),
        isVip
      });
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

  bot.on('kicked', (reason) => {
    clearTimeout(connectionTimeout);
    const reasonText = typeof reason === 'object' ? JSON.stringify(reason) : reason;
    emitLog(username, `Expulso do servidor: ${reasonText}`);
  });

  bot.on('error', (err) => {
    clearTimeout(connectionTimeout);
    emitLog(username, `Erro na conexão: ${err.message}`);
  });

  bot.on('end', () => {
    clearTimeout(connectionTimeout);
    emitLog(username, 'Conexão encerrada pelo servidor.');

    if (activeMacros.has(username)) {
      try { activeMacros.get(username).stop(); } catch (e) {}
    }

    if (!meta.manualDisconnect) {
      scheduleReconnect(username, botConfig);
    }
  });
}

function cleanupBot(username) {
  const meta = botMetas.get(username);
  if (meta) {
    meta.manualDisconnect = true;
  }

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
    try { bot.quit(); } catch (e) {}
    activeBots.delete(username);
  }

  botMetas.delete(username);
  io.emit('bot_removed', { username });
  emitLog('SISTEMA', `Conta ${username} desconectada.`, true);
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
    allAccountMetrics: allMetrics
  });

  socket.on('start_bot', (data) => {
    if (!data || !data.username) return;
    createBotInstance(data);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Painel e Backend ativos na porta ${PORT}`);
  console.log(`🌐 Interface: http://localhost:${PORT}`);
  console.log(`====================================================`);
});