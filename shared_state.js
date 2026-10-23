const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'shared_state.json');

class SharedStateManager {
  constructor(io, getActiveBotCallback) {
    this.io = io;
    this.getActiveBot = getActiveBotCallback;
    this.isLocking = false; // Mutex simples para evitar race conditions
    this.state = {
      usedSwordsCount: 0,
      totalRepairedSwords: 0,
      totalProfitCoins: 0,
      unpaidProfitAccumulated: 0
    };
    this.loadState();
  }

  loadState() {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        this.state = { ...this.state, ...JSON.parse(raw) };
      } catch (e) {
        console.error('Erro ao ler shared_state.json, inicializando padrão.');
      }
    }
    this.saveState();
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
      if (this.io) {
        this.io.emit('shared_state_update', this.state);
      }
    } catch (e) {
      console.error('Erro ao salvar shared_state.json:', e.message);
    }
  }

  getUsedSwords() {
    return this.state.usedSwordsCount;
  }

  // Reserva e incrementa a contagem de forma atômica
  async claimNextSwordSlot(username) {
    while (this.isLocking) {
      await new Promise(r => setTimeout(r, 50));
    }
    this.isLocking = true;
    try {
      const currentSlot = this.state.usedSwordsCount;
      this.state.usedSwordsCount++;
      this.saveState();
      if (this.io) {
        this.io.emit('bot_log', {
          username: username,
          msg: `📌 Espada #${currentSlot + 1} reservada e retirada do estoque. Total para reparar: ${this.state.usedSwordsCount}`,
          timestamp: new Date().toLocaleTimeString()
        });
      }
      return currentSlot;
    } finally {
      this.isLocking = false;
    }
  }

  setUsedSwords(count, modifierName = 'Sistema') {
    this.state.usedSwordsCount = Math.max(0, parseInt(count) || 0);
    this.saveState();
    if (this.io) {
      this.io.emit('bot_log', {
        username: 'SISTEMA',
        msg: `Variável [usedSwordsCount] alterada para ${this.state.usedSwordsCount} por ${modifierName}.`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  }

  addRepairedSwords(count, username) {
    this.state.totalRepairedSwords += count;
    this.saveState();
    if (this.io) {
      this.io.emit('bot_log', {
        username: username,
        msg: `✨ +${count} espadas reparadas! Total histórico reparado: ${this.state.totalRepairedSwords}`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  }

  addProfit(username, amount) {
    if (amount <= 0) return;
    this.state.totalProfitCoins += amount;
    this.state.unpaidProfitAccumulated += amount;
    this.saveState();

    if (this.state.unpaidProfitAccumulated >= 500000) {
      this.executeAutoMoneyPay(username);
    }
  }

  resetProfit() {
    this.state.totalProfitCoins = 0;
    this.state.unpaidProfitAccumulated = 0;
    this.saveState();
    if (this.io) {
      this.io.emit('bot_log', {
        username: 'SISTEMA',
        msg: `Lucro zerado manualmente pelo painel.`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  }

  async executeAutoMoneyPay(username) {
    const botObj = this.getActiveBot(username);
    if (!botObj || !botObj.botInstance) return;

    const bot = botObj.botInstance;
    const times = Math.floor(this.state.unpaidProfitAccumulated / 500000);

    for (let i = 0; i < times; i++) {
      if (this.io) {
        this.io.emit('bot_log', {
          username: username,
          msg: `💸 Meta de 500k atingida! Enviando /money pay @Fatal 500000...`,
          timestamp: new Date().toLocaleTimeString()
        });
      }

      bot.chat('/money pay @Fatal 500000');
      await new Promise((r) => setTimeout(r, 1000));
      bot.chat('/money pay @Fatal 500000');
      await new Promise((r) => setTimeout(r, 1500));

      this.state.unpaidProfitAccumulated -= 500000;
    }
    this.saveState();
  }
}

module.exports = SharedStateManager;