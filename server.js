const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mineflayer = require('mineflayer');
const socks = require('socks').SocksClient;

const MobFarmerMacro = require('./macros/mob_farmer');
const MobVipMacro = require('./macros/mob_vip');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Gerenciador de Estado Global Compartilhado
class SharedStateManager {
  constructor() {
    this.totalProfit = 0;
    this.repairedSwordsCount = 0;
    this.usedSwordsCount = 0;
  }

  addProfit(botName, amount) {
    this.totalProfit += amount;
    broadcastSharedState();
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

  // Incremento e decremento estritamente de 1 em 1
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
const reconnectTimers = new Map(); // Controle de retentativas a cada 30s

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

  emitLog(username, '⏳ Servidor indisponível ou reiniciando. Tentando reconectar em 30 segundos...');
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

function createBotInstance(botConfig) {
  const { username, password, host, port, macroType, proxy } = botConfig;

  // Limpa instâncias ou sockets anteriores da mesma conta
  if (activeBots.has(username)) {
    try { activeBots.get(username).quit(); } catch (e) {}
    activeBots.delete(username);
  }
  if (activeMacros.has(username)) {
    try { activeMacros.get(username).stop(); } catch (e) {}
    activeMacros.delete(username);
  }

  const serverHost = host ? host.trim() : 'solaris.craftlandia.com.br';
  const serverPort = parseInt(port) || 25565;

  const options = {
    host: serverHost,
    port: serverPort,
    username: username,
    version: '1.8.9',
    viewDistance: 'tiny',
    skipValidation: true,
    checkTimeoutInterval: 45000
  };

  if (proxy && proxy.host && proxy.port) {
    emitLog(username, `Configurando conexão via Proxy SOCKS5 ${proxy.host}:${proxy.port}...`);
    options.connect = (client) => {
      const socksOptions = {
        proxy: {
          host: proxy.host,
          port: parseInt(proxy.port),
          type: 5
        },
        command: 'connect',
        destination: {
          host: serverHost,
          port: serverPort
        }
      };

      if (proxy.user && proxy.pass) {
        socksOptions.proxy.userId = proxy.user;
        socksOptions.proxy.password = proxy.pass;
      }

      socks.createConnection(socksOptions, (err, info) => {
        if (err) {
          emitLog(username, `❌ Erro na conexão via Proxy: ${err.message}`);
          scheduleReconnect(username, botConfig);
          return;
        }
        client.setSocket(info.socket);
        client.emit('connect');
      });
    };
  } else {
    emitLog(username, `Iniciando conexão direta com ${serverHost}:${serverPort}...`);
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
  }, 20000);

  bot._client.once('connect', () => {
    emitLog(username, '🔌 Socket TCP conectado.');
  });

  bot.once('login', () => {
    clearTimeout(connectionTimeout);
    emitLog(username, '🔑 Autenticado. Aguardando spawn...');
  });

  bot.on('messagestr', (message) => {
    const raw = message.toString().trim();
    if (!raw) return;

    io.emit('bot_chat_message', {
      username: username,
      message: raw,
      time: new Date().toLocaleTimeString()
    });

    const lower = raw.toLowerCase();
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
  emitLog('SISTEMA', `Conta ${username} desvinculada manualmente.`, true);
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

  socket.emit('init_state', {
    sharedState: sharedState.getState(),
    activeBots: activeList
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

  // Incremento / Decremento rigoroso de 1 em 1
  socket.on('adjust_used_swords', ({ amount }) => {
    const step = amount > 0 ? 1 : -1;
    sharedState.adjustUsedSwords(step, 'Painel Web');
  });

  socket.on('reset_used_swords', () => {
    sharedState.setUsedSwords(0, 'Painel Web');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Painel e Backend ativos na porta ${PORT}`);
  console.log(`🌐 Interface: http://localhost:${PORT}`);
  console.log(`====================================================`);
});