const Vec3 = require('vec3');

class MobVipMacro {
  constructor(bot, config, emitLog, sharedStateManager) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.sharedState = sharedStateManager;
    this.running = false;
    this.isPaused = false;

    this.PERSONAL_SWORD_SLOT = 9;
    this.MIN_DURABILITY_THRESHOLD = 250;
    this.accumulatedBalance = 0;
    this.isTransferring = false;
    this.isSellingChests = false;

    this.lastCommandTime = 0;
    this.lastInventoryCheck = 0;
    this.isHandlingAfk = false;

    this.lastMobHitTimestamp = Date.now();
    this.isExecutingSafehomeRecovery = false;

    this.chatListener = async (message) => {
      const raw = message.toString();
      const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
      const lower = clean
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      if (lower.includes('voce ficou afk') || lower.includes('teleportado para um local seguro')) {
        this.emitLog('⚠️ [ANTI-AFK] Kick por AFK detectado! Retornando ao mob (VIP)...', true);
        this.handleAfkTeleport();
        return;
      }

      if (clean.includes('Total recebido:') && clean.includes('Coins')) {
        const match = clean.match(/Total recebido:\s*([\d,\.]+)\s*Coins/i);
        if (match && match[1]) {
          const rawNum = match[1].replace(/,/g, '');
          const val = parseFloat(rawNum);
          if (!isNaN(val)) {
            this.emitLog(`💵 Venda computada: +${val.toFixed(2)} Coins.`);
            this.sharedState.addProfit(this.config.username, val, true);

            this.accumulatedBalance += val;

            if (this.accumulatedBalance >= 1000000 && !this.isTransferring && this.config.username.toLowerCase() !== 'fatal') {
              this.isTransferring = true;
              const amountToSend = Math.floor(this.accumulatedBalance);
              this.emitLog(`💰 [VIP] Saldo atingiu 1kk (${amountToSend} Coins)! Transferindo para Fatal...`);

              try {
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                await this.sleep(1000);
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [VIP] Transferência confirmada! Saldo zerado.`);
                this.sharedState.registerMoneyTransfer(this.config.username, amountToSend);
                this.accumulatedBalance = 0;
              } catch (tErr) {
                this.emitLog(`❌ Erro na transferência VIP: ${tErr.message}`, true);
              } finally {
                this.isTransferring = false;
              }
            }
          }
        }
      }
    };
    this.bot.on('messagestr', this.chatListener);
  }

  async start() {
    this.running = true;
    this.isPaused = false;
    this.isSellingChests = false;
    this.lastMobHitTimestamp = Date.now();
    this.emitLog('👑 Macro MOB VIP iniciada...');

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no ciclo VIP: ${err.message}. Reiniciando em 3s...`, true);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro VIP pausada.');
  }

  resume() {
    this.isPaused = false;
    this.lastMobHitTimestamp = Date.now();
    this.emitLog('▶️ Macro VIP retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.isSellingChests = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.chatListener);
    this.emitLog('⏹️ Macro VIP finalizada.');
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stopMovement() {
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sprint', false);
  }

  async sendCommand(cmd, minDelayAfter = 1200) {
    const elapsed = Date.now() - this.lastCommandTime;
    if (elapsed < 1500) {
      await this.sleep(1500 - elapsed);
    }
    this.bot.chat(cmd);
    this.lastCommandTime = Date.now();
    await this.sleep(minDelayAfter);
  }

  async teleportVip(homeName) {
    this.emitLog(`📍 VIP teleportando para /${homeName}...`);

    let homeInvalida = false;
    const errorListener = (msg) => {
      const text = msg.toString().toLowerCase();
      if (text.includes('voce nao tem acesso a essa home') || text.includes('home nao encontrada')) {
        homeInvalida = true;
      }
    };

    this.bot.on('messagestr', errorListener);
    await this.sendCommand(`/${homeName}`, 1200);
    await this.sleep(1800);
    this.bot.removeListener('messagestr', errorListener);

    return !homeInvalida;
  }

  async handleAfkTeleport() {
    if (this.isHandlingAfk || !this.running) return;
    this.isHandlingAfk = true;
    this.stopMovement();

    try {
      await this.sleep(1000);
      await this.teleportVip('home mob');
      await this.restorePersonalSwordToHand();
      this.lastMobHitTimestamp = Date.now();
      this.emitLog('✅ Retorno do AFK VIP concluído!');
    } catch (e) {
      this.emitLog(`Erro ao retornar do AFK: ${e.message}`, true);
    } finally {
      this.isHandlingAfk = false;
    }
  }

  async handleNoMobInactivityWatchdog() {
    if (this.isExecutingSafehomeRecovery || !this.running) return;
    this.isExecutingSafehomeRecovery = true;
    this.stopMovement();

    this.emitLog('🚨 [WATCHDOG ERRO] VIP há 3 minutos sem atingir nenhum mob! Indo para safehome...', true);

    try {
      this.emitLog('📍 Teleportando para /home fatal safehome...');
      await this.teleportVip('home fatal safehome');

      this.emitLog('⏳ Aguardando repouso de 3 minutos em safehome...');
      const waitStart = Date.now();
      while (Date.now() - waitStart < 180000 && this.running && !this.isPaused) {
        await this.sleep(5000);
      }

      this.emitLog('🔄 Tempo de repouso concluído. Retornando ao mob e reiniciando ciclo...');
      await this.teleportVip('home mob');
      await this.restorePersonalSwordToHand();
      this.lastMobHitTimestamp = Date.now();
      this.emitLog('🎯 Retorno ao mob efetuado com sucesso!');
    } catch (err) {
      this.emitLog(`❌ Erro no procedimento de safehome: ${err.message}`, true);
    } finally {
      this.isExecutingSafehomeRecovery = false;
      this.lastMobHitTimestamp = Date.now();
    }
  }

  getSwordDurability(sword) {
    if (!sword) return 0;
    const maxDur = sword.maxDurability || 1561;
    let damage = 0;
    if (typeof sword.metadata === 'number' && sword.metadata > 0) {
      damage = sword.metadata;
    } else if (sword.nbt && sword.nbt.value && sword.nbt.value.Damage) {
      damage = sword.nbt.value.Damage.value || 0;
    } else if (typeof sword.durabilityUsed === 'number') {
      damage = sword.durabilityUsed;
    }
    return Math.max(0, maxDur - damage);
  }

  getDiamondSword() {
    const swords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    if (swords.length === 0) return null;
    swords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));
    return swords[0];
  }

  countDiamondBlocks() {
    let count = 0;
    for (const it of this.bot.inventory.items()) {
      if (it && it.name === 'diamond_block') count += it.count;
    }
    return count;
  }

  countFilledSlots() {
    let filled = 0;
    for (let s = 9; s <= 44; s++) {
      if (this.bot.inventory.slots[s]) filled++;
    }
    return filled;
  }

  async checkAndSellDrops() {
    const filled = this.countFilledSlots();

    if (filled >= 27) {
      this.emitLog(`📦 Condição de venda VIP (${filled} slots cheios >= 27). Executando /vender...`);
      await this.sendCommand('/vender farms', 1200);
      await this.sleep(800);
      await this.sendCommand('/vender mobs', 1200);
      await this.sleep(1000);
    }
  }

  getTargetChestInFront() {
    const target = this.bot.blockAtCursor(5);
    if (target && (target.name === 'chest' || target.name === 'trapped_chest')) {
      return target;
    }

    return this.bot.findBlock({
      matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest'),
      maxDistance: 4.5
    });
  }

  async ensureDiamondBlocksSupply() {
    if (this.countDiamondBlocks() >= 64) return;

    this.emitLog('📦 Menos de 64 blocos de diamante. Buscando nos baús...');
    await this.checkAndSellDrops();

    for (let i = 1; i <= 10; i++) {
      if (this.countDiamondBlocks() >= 64 || !this.running || this.isPaused) break;

      const home = `home fatal diamante${i}`;
      const success = await this.teleportVip(home);
      if (!success) continue;

      const chest = this.getTargetChestInFront();
      if (!chest) continue;

      try {
        const container = await this.bot.openContainer(chest);
        await this.sleep(1000);

        let totalChestBlocks = 0;
        for (const it of container.containerItems()) {
          if (it && it.name === 'diamond_block') totalChestBlocks += it.count;
        }

        this.sharedState.updateDiamondStock(`diamante${i}`, totalChestBlocks / 64);

        const diaItem = container.containerItems().find((it) => it.name === 'diamond_block');
        if (diaItem) {
          const needed = 64 - this.countDiamondBlocks();
          await container.withdraw(diaItem.type, null, Math.min(needed, diaItem.count));
          await this.sleep(500);
          this.emitLog(`💎 Blocos de diamante retirados de /${home}!`);
        }
        container.close();
        await this.sleep(600);
      } catch (err) {
        this.emitLog(`Erro ao abrir baú em /${home}: ${err.message}`, true);
      }
    }
  }

  async securePersonalSwordAndClearHotbar() {
    const allSwords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    allSwords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));

    if (allSwords.length > 0) {
      const bestSword = allSwords[0];
      if (bestSword.slot !== this.PERSONAL_SWORD_SLOT) {
        try {
          await this.bot.moveSlotItem(bestSword.slot, this.PERSONAL_SWORD_SLOT);
          await this.sleep(500);
        } catch (e) {}
      }
    }

    const items = this.bot.inventory.items();
    for (const item of items) {
      if (item.slot >= 36 && item.slot <= 44) {
        let emptySlot = null;
        for (let s = 10; s <= 35; s++) {
          if (!this.bot.inventory.slots[s]) {
            emptySlot = s;
            break;
          }
        }

        if (emptySlot !== null) {
          try {
            await this.bot.moveSlotItem(item.slot, emptySlot);
            await this.sleep(400);
          } catch (e) {}
        }
      }
    }
  }

  async restorePersonalSwordToHand() {
    const itemInSlot9 = this.bot.inventory.slots[this.PERSONAL_SWORD_SLOT];
    if (itemInSlot9 && itemInSlot9.name === 'diamond_sword') {
      try {
        await this.bot.equip(itemInSlot9, 'hand');
        await this.sleep(400);
        return true;
      } catch (e) {}
    }

    const anySword = this.getDiamondSword();
    if (anySword) {
      try {
        await this.bot.equip(anySword, 'hand');
        await this.sleep(400);
        return true;
      } catch (e) {}
    }

    return false;
  }

  async fetchEmergencySwordFromChest() {
    this.emitLog('🆘 [EMERGÊNCIA] VIP sem espada! Buscando reserva em /home fatal repararespadas1...', true);
    const success = await this.teleportVip('home fatal repararespadas1');
    if (!success) return false;

    const chest = this.getTargetChestInFront();
    if (!chest) return false;

    try {
      const container = await this.bot.openContainer(chest);
      await this.sleep(1500);

      const swords = container.slots.slice(0, container.inventoryStart).filter((it) => {
        return it && it.name === 'diamond_sword' && this.getSwordDurability(it) >= 1000;
      });

      if (swords.length > 0) {
        await this.bot.clickWindow(swords[0].slot, 0, 1);
        await this.sleep(800);
        container.close();
        await this.sleep(600);
        await this.teleportVip('home mob');
        await this.restorePersonalSwordToHand();
        this.lastMobHitTimestamp = Date.now();
        return true;
      }
      container.close();
      await this.sleep(600);
    } catch (e) {}

    return false;
  }

  async repairCurrentSword() {
    let sword = this.getDiamondSword();
    if (!sword) return false;

    await this.ensureDiamondBlocksSupply();

    this.emitLog(`🔨 Reparando espada própria no chão (${this.getSwordDurability(sword)}/1561)...`);
    try {
      await this.bot.equip(sword, 'hand');
      await this.sleep(500);
    } catch (e) {}

    await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
    await this.sleep(500);

    const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (blockBelow) {
      try { await this.bot.activateBlock(blockBelow); } catch (e) { this.bot.activateItem(); }
    } else {
      this.bot.activateItem();
    }

    await this.sleep(1000);
    const updatedSword = this.getDiamondSword();
    const newDur = this.getSwordDurability(updatedSword);
    this.emitLog(`✅ Espada própria reparada! Nova durabilidade: ${newDur}/1561.`);

    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    this.lastMobHitTimestamp = Date.now();
    return true;
  }

  getTargetSign() {
    const lookTarget = this.bot.blockAtCursor(4.5);
    if (lookTarget && (lookTarget.name.includes('sign') || lookTarget.name.includes('wall_sign'))) {
      return lookTarget;
    }
    return this.bot.findBlock({
      matching: (b) => b && (b.name.includes('sign') || b.name.includes('wall_sign')),
      maxDistance: 4.5
    });
  }

  async sellItemAtSign(homeName, itemName) {
    const success = await this.teleportVip(homeName);
    if (!success) {
      this.emitLog(`❌ Falha ao teleportar para /${homeName}`, true);
      return;
    }

    this.bot.chat('/esconder');
    await this.sleep(400);

    this.emitLog(`🏷️ Batendo na placa de venda rápida: ${itemName} (/esconder enviado)...`);

    let sign = this.getTargetSign();
    if (!sign) {
      await this.sleep(500);
      sign = this.getTargetSign();
    }

    if (!sign) {
      this.emitLog(`❌ Placa não localizada em /${homeName}!`, true);
      return;
    }

    await this.bot.lookAt(sign.position.offset(0.5, 0.5, 0.5), true);
    await this.sleep(300);

    for (let i = 1; i <= 3; i++) {
      try {
        this.bot.attack(sign);
        await this.sleep(250);
      } catch (err) {}
    }
  }

  async emptyInventoryAtSigns() {
    const targetDropNames = ['leather', 'beef', 'cooked_beef', 'cooked_steak', 'steak'];

    let tries = 0;
    while (tries < 3 && this.running && !this.isPaused) {
      tries++;
      const hasMeat = this.bot.inventory.items().some((i) => ['beef', 'cooked_beef', 'cooked_steak', 'steak'].includes(i.name.toLowerCase()));
      const hasLeather = this.bot.inventory.items().some((i) => i.name.toLowerCase() === 'leather');

      if (!hasMeat && !hasLeather) break;

      if (hasMeat) {
        await this.sellItemAtSign('home fatal vendercarne', 'Carne');
      }
      if (hasLeather) {
        await this.sellItemAtSign('home fatal vendercouro', 'Couro');
      }

      await this.sleep(400);
      const remaining = this.bot.inventory.items().filter((i) => targetDropNames.includes(i.name.toLowerCase()));
      if (remaining.length === 0) break;
    }
  }

  // Rotina de Venda dos Baús com trava de segurança anti-loop
  async processVipChestsSellRoutine() {
    if (this.isSellingChests) return;
    this.isSellingChests = true;

    const state = this.sharedState.getState();
    const maxChestAvailable = Math.min(30, Math.max(1, state.currentChestIndex || 1));
    this.emitLog(`💰 [VENDA VIP] Meta atingida! Iniciando venda de baús (varrendo de venda1 até venda${maxChestAvailable})...`);

    for (let chestNum = 1; chestNum <= maxChestAvailable; chestNum++) {
      // Se o usuário desligou a Venda VIP no slider a qualquer momento, cancela imediatamente!
      if (!this.running || this.isPaused || !this.sharedState.getVipSellEnabled()) {
        this.emitLog('🛑 [VENDA VIP] Venda VIP desativada pelo usuário! Abortando rotina de baús e voltando ao mob...');
        break;
      }

      const homeName = `home fatal venda${chestNum}`;
      this.emitLog(`📦 [VENDA VIP] Inspecionando baú /${homeName}...`);

      const success = await this.teleportVip(homeName);
      if (!success) {
        this.emitLog(`⚠️ Home /${homeName} não autorizada ou não existe. Encerrando ciclo de baús.`, true);
        break;
      }

      const chest = this.getTargetChestInFront();
      if (!chest) {
        this.emitLog(`⚠️ Baú não visto em /${homeName}. Prosseguindo...`);
        continue;
      }

      let chestFinished = false;
      while (!chestFinished && this.running && !this.isPaused && this.sharedState.getVipSellEnabled()) {
        const repairLimit = this.sharedState.getState().swordsRepairThreshold || 10;
        if (this.sharedState.getUsedSwords() >= repairLimit) {
          this.emitLog('🔨 [PRIORIDADE] Fila de reparo atingiu o limite! Esvaziando inventário e reparando...');
          await this.emptyInventoryAtSigns();
          await this.repairFakeSwordsRoutine();
          await this.teleportVip(homeName);
        }

        let container = null;
        try {
          container = await this.bot.openContainer(chest);
          await this.sleep(600);
        } catch (e) {
          break;
        }

        const chestItems = container.slots.slice(0, container.inventoryStart).filter((it) => it && ['leather', 'beef', 'cooked_beef', 'cooked_steak', 'steak'].includes(it.name.toLowerCase()));

        if (chestItems.length === 0) {
          this.emitLog(`✅ Baú /${homeName} está vazio de carne e couro.`);
          container.close();
          await this.sleep(400);
          chestFinished = true;
          break;
        }

        let pulledCount = 0;
        for (const item of chestItems) {
          if (this.countFilledSlots() >= 35) break;
          try {
            await this.bot.clickWindow(item.slot, 0, 1);
            await this.sleep(60);
            pulledCount++;
          } catch (err) {
            break;
          }
        }

        container.close();
        await this.sleep(400);

        this.emitLog(`📥 Retirados ${pulledCount} packs de drops de /${homeName}. Indo vender nas placas...`);
        await this.emptyInventoryAtSigns();

        if (pulledCount === 0) {
          chestFinished = true;
        }
      }
    }

    this.sharedState.resetCurrentChestIndex();
    this.isSellingChests = false;

    this.emitLog('✨ Ciclo de venda VIP finalizado com sucesso! Retornando para /home mob...');
    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    this.lastMobHitTimestamp = Date.now();
  }

  async repairSwordsInChestHome(homeName) {
    const success = await this.teleportVip(homeName);
    if (!success) return;

    const chest = this.getTargetChestInFront();
    if (!chest) return;

    let hasBrokenSwordsRemaining = true;
    let batchNumber = 0;
    let consecutiveEmptyCycles = 0;

    while (hasBrokenSwordsRemaining && this.running && !this.isPaused && consecutiveEmptyCycles < 2) {
      await this.securePersonalSwordAndClearHotbar();

      let container = null;
      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);
      } catch (err) {
        break;
      }

      const brokenInChest = container.slots.slice(0, container.inventoryStart).filter((it) => {
        return it && it.name === 'diamond_sword' && this.getSwordDurability(it) < 500;
      });

      if (brokenInChest.length === 0) {
        hasBrokenSwordsRemaining = false;
        container.close();
        await this.sleep(600);
        break;
      }

      batchNumber++;
      const batchToWithdraw = brokenInChest.slice(0, 8);
      let withdrawnCount = 0;

      for (const sw of batchToWithdraw) {
        try {
          await this.bot.clickWindow(sw.slot, 0, 1);
          await this.sleep(450);
          withdrawnCount++;
        } catch (wErr) {}
      }

      container.close();
      await this.sleep(800);

      if (withdrawnCount === 0) {
        consecutiveEmptyCycles++;
        continue;
      } else {
        consecutiveEmptyCycles = 0;
      }

      await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
      await this.sleep(800);

      let currentSwordsToFix = this.bot.inventory.items().filter((it) => {
        return it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) < 500;
      });

      for (let i = 0; i < currentSwordsToFix.length; i++) {
        if (!this.running || this.isPaused) break;

        let brokenSword = this.bot.inventory.items().find((it) => {
          return it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) < 500;
        });

        if (!brokenSword) break;

        let repaired = false;
        let attempts = 0;

        while (!repaired && attempts < 3 && this.running && !this.isPaused) {
          attempts++;
          try {
            await this.bot.equip(brokenSword, 'hand');
            await this.sleep(400);
          } catch (e) {}

          const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
          if (blockBelow) {
            try { await this.bot.activateBlock(blockBelow); } catch (e) { this.bot.activateItem(); }
          } else {
            this.bot.activateItem();
          }

          await this.sleep(900);
          const held = this.bot.heldItem;
          const currentDur = this.getSwordDurability(held);

          if (currentDur >= 1400) {
            repaired = true;
            this.sharedState.addRepairedSwords(1, this.config.username);
          } else {
            await this.sleep(800);
          }
        }
      }

      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);

        const repairedSwords = container.slots.slice(container.inventoryStart).filter((it) => {
          return it && it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) >= 1400;
        });

        for (const sw of repairedSwords) {
          try {
            await this.bot.clickWindow(sw.slot, 0, 1);
            await this.sleep(450);
          } catch (dErr) {}
        }

        container.close();
        await this.sleep(800);
      } catch (err) {}
    }
  }

  async repairFakeSwordsRoutine() {
    this.emitLog('⚡ Quantidade de espadas usadas atingiu a meta! Limpando drops antes de reparar...');
    await this.checkAndSellDrops();
    await this.ensureDiamondBlocksSupply();

    const totalToFix = this.sharedState.getUsedSwords();
    await this.repairSwordsInChestHome('home fatal repararespadas1');

    if (totalToFix > 50) {
      await this.repairSwordsInChestHome('home fatal repararespadas2');
    }

    this.sharedState.setUsedSwords(0, `${this.config.username} (VIP)`);
    this.emitLog('✨ Todas as espadas foram reparadas! Fila resetada.');

    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    this.lastMobHitTimestamp = Date.now();
  }

  findNearbyMob() {
    const mobFilter = (e) => {
      if (!e || e === this.bot.entity) return false;
      if (e.type !== 'mob' && e.type !== 'hostile' && e.type !== 'animal') return false;
      if (!e.isValid || e.health <= 0) return false;
      return this.bot.entity.position.distanceTo(e.position) <= 4.2;
    };
    return this.bot.nearestEntity(mobFilter);
  }

  async mainLoop() {
    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    this.lastMobHitTimestamp = Date.now();

    this.emitLog('🎯 VIP combatendo mobs continuamente...');

    while (this.running && !this.isPaused) {
      if (this.isHandlingAfk || this.isExecutingSafehomeRecovery) {
        await this.sleep(1000);
        continue;
      }

      if (Date.now() - this.lastMobHitTimestamp >= 180000) {
        await this.handleNoMobInactivityWatchdog();
        continue;
      }

      const repairThreshold = this.sharedState.getState().swordsRepairThreshold || 10;
      if (this.sharedState.getUsedSwords() >= repairThreshold) {
        await this.repairFakeSwordsRoutine();
        continue;
      }

      // Gatilho ESTRITO de Venda de Baús do VIP: Somente se ativado e se atingiu a meta
      if (this.sharedState.getVipSellEnabled() && !this.isSellingChests) {
        const state = this.sharedState.getState();
        const maxChests = state.maxChestsBeforeSell || 10;
        const currentChest = state.currentChestIndex || 1;

        if (currentChest >= maxChests) {
          this.emitLog(`🚀 [DISPARO VENDA VIP] Meta de baús atingida (${currentChest} >= ${maxChests})! Iniciando venda...`);
          await this.processVipChestsSellRoutine();
          continue;
        }
      }

      let currentSword = this.bot.heldItem;
      if (!currentSword || currentSword.name !== 'diamond_sword') {
        const restored = await this.restorePersonalSwordToHand();
        currentSword = this.bot.heldItem;

        if (!restored || !currentSword || currentSword.name !== 'diamond_sword') {
          const hasAnySword = this.getDiamondSword();
          if (hasAnySword) {
            await this.repairCurrentSword();
          } else {
            const retrieved = await this.fetchEmergencySwordFromChest();
            if (!retrieved) {
              await this.sleep(5000);
            }
          }
          continue;
        }
      }

      let dur = this.getSwordDurability(currentSword);
      if (dur < this.MIN_DURABILITY_THRESHOLD) {
        await this.repairCurrentSword();
        continue;
      }

      if (Date.now() - this.lastInventoryCheck >= 4000) {
        await this.checkAndSellDrops();
        this.lastInventoryCheck = Date.now();
      }

      const mob = this.findNearbyMob();
      if (mob) {
        try {
          await this.bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true);
          this.bot.attack(mob);
          this.lastMobHitTimestamp = Date.now();
          this.sharedState.registerMobHit(this.config.username);

          const afterHitSword = this.bot.heldItem;
          const afterHitDur = this.getSwordDurability(afterHitSword);

          if (!afterHitSword || afterHitSword.name !== 'diamond_sword' || afterHitDur < this.MIN_DURABILITY_THRESHOLD) {
            await this.repairCurrentSword();
            continue;
          }

          await this.sleep(400);
        } catch (e) {
          await this.sleep(200);
        }
      } else {
        await this.sleep(250);
      }
    }
  }
}

module.exports = MobVipMacro;