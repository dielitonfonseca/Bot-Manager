const Vec3 = require('vec3');

class MobFarmerMacro {
  constructor(bot, config, emitLog, sharedStateManager) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.sharedState = sharedStateManager;
    this.running = false;
    this.isPaused = false;

    // Limiar de troca preventiva aumentado para 350 para blindagem total contra quebra
    this.MIN_DURABILITY_THRESHOLD = 350;
    this.accumulatedBalance = 0;
    this.isTransferring = false;

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
        this.emitLog('⚠️ [ANTI-AFK] Kick por AFK detectado! Retornando para /home mob (Sem VIP)...', true);
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
            this.sharedState.addProfit(this.config.username, val, false);

            this.accumulatedBalance += val;

            if (this.accumulatedBalance >= 1000000 && !this.isTransferring && this.config.username.toLowerCase() !== 'fatal') {
              this.isTransferring = true;
              const amountToSend = Math.floor(this.accumulatedBalance);
              this.emitLog(`💰 Saldo acumulou 1kk (${amountToSend} Coins)! Enviando para Fatal em 2 etapas...`);

              try {
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [1/2] /money pay Fatal ${amountToSend} enviado. Aguardando 1s...`);
                await this.sleep(1000);

                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [2/2] Confirmação enviada! Saldo individual zerado.`);
                this.sharedState.registerMoneyTransfer(this.config.username, amountToSend);
                this.accumulatedBalance = 0;
              } catch (tErr) {
                this.emitLog(`❌ Erro ao transferir money: ${tErr.message}`, true);
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
    this.lastMobHitTimestamp = Date.now();
    this.emitLog('⚔️ Macro Mata Mob sem VIP iniciada...');

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no ciclo de mobs: ${err.message}. Reiniciando em 3s...`, true);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro pausada.');
  }

  resume() {
    this.isPaused = false;
    this.lastMobHitTimestamp = Date.now();
    this.emitLog('▶️ Macro retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.chatListener);
    this.emitLog('⏹️ Macro finalizada.');
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

  async sendCommand(cmd, minDelayAfter = 1500) {
    const elapsed = Date.now() - this.lastCommandTime;
    if (elapsed < 2000) {
      await this.sleep(2000 - elapsed);
    }
    this.bot.chat(cmd);
    this.lastCommandTime = Date.now();
    await this.sleep(minDelayAfter);
  }

  async teleportSafe(homeName) {
    this.emitLog(`📍 Solicitando /${homeName}...`);

    let teleportConfirmed = false;
    const confirmListener = (msg) => {
      const text = msg.toString().toLowerCase();
      if (text.includes('teleportado')) {
        teleportConfirmed = true;
      }
    };

    this.bot.on('messagestr', confirmListener);
    await this.sendCommand(`/${homeName}`, 500);

    const startTime = Date.now();
    while (!teleportConfirmed && Date.now() - startTime < 8500) {
      await this.sleep(200);
    }

    this.bot.removeListener('messagestr', confirmListener);

    if (teleportConfirmed) {
      this.emitLog('✅ Teleporte confirmado pelo servidor! Aguardando 2s de estabilização...');
    } else {
      this.emitLog('⏳ Aguardando estabilização física (2s)...');
    }

    await this.sleep(2000);
  }

  async handleAfkTeleport() {
    if (this.isHandlingAfk || !this.running) return;
    this.isHandlingAfk = true;
    this.stopMovement();

    try {
      await this.sleep(1000);
      await this.teleportSafe('home mob');
      await this.ensureUsableSwordOrReplace();
      this.lastMobHitTimestamp = Date.now();
      this.emitLog('✅ Retorno do AFK concluído!');
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

    this.emitLog('🚨 [WATCHDOG ERRO] 3 minutos sem abater nenhum mob! Indo para safehome...', true);

    try {
      this.emitLog('📍 Teleportando para /home fatal safehome...');
      await this.teleportSafe('home fatal safehome');

      this.emitLog('⏳ Aguardando repouso de 3 minutos em safehome...');
      const waitStart = Date.now();
      while (Date.now() - waitStart < 180000 && this.running && !this.isPaused) {
        await this.sleep(5000);
      }

      this.emitLog('🔄 Tempo de repouso concluído. Retornando ao mob e reiniciando ciclo...');
      await this.teleportSafe('home mob');
      await this.ensureUsableSwordOrReplace();
      this.lastMobHitTimestamp = Date.now();
      this.emitLog('🎯 Retorno ao mob efetuado com sucesso!');
    } catch (err) {
      this.emitLog(`❌ Erro no procedimento de safehome: ${err.message}`, true);
    } finally {
      this.isExecutingSafehomeRecovery = false;
      this.lastMobHitTimestamp = Date.now();
    }
  }

  getSwordDurability(item) {
    if (!item) return 0;
    const maxDur = item.maxDurability || 1561;

    let damage = 0;
    if (typeof item.metadata === 'number' && item.metadata > 0) {
      damage = item.metadata;
    } else if (item.nbt && item.nbt.value && item.nbt.value.Damage) {
      damage = item.nbt.value.Damage.value || 0;
    } else if (typeof item.durabilityUsed === 'number') {
      damage = item.durabilityUsed;
    }

    return Math.max(0, maxDur - damage);
  }

  getDiamondSword() {
    const swords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    if (swords.length === 0) return null;
    swords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));
    return swords[0];
  }

  async ensureUsableSwordOrReplace() {
    let held = this.bot.heldItem;

    if (held && held.name === 'diamond_sword' && this.getSwordDurability(held) >= this.MIN_DURABILITY_THRESHOLD) {
      return true;
    }

    const bestSword = this.getDiamondSword();
    if (bestSword && this.getSwordDurability(bestSword) >= this.MIN_DURABILITY_THRESHOLD) {
      try {
        await this.bot.equip(bestSword, 'hand');
        await this.sleep(500);
        return true;
      } catch (e) {}
    }

    this.emitLog(`⚠️ Sem espada utilizável (limiar de segurança: ${this.MIN_DURABILITY_THRESHOLD}). Indo ao baú...`);
    const exchanged = await this.replaceSwordRoutine();
    return exchanged;
  }

  getMobDropsCount() {
    const dropNames = [
      'rotten_flesh', 'bone', 'arrow', 'string', 'spider_eye', 'gunpowder',
      'ender_pearl', 'leather', 'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop',
      'chicken', 'cooked_chicken', 'feather', 'slime_ball', 'ghast_tear', 'blaze_rod'
    ];
    return this.bot.inventory.items().filter((i) => dropNames.includes(i.name.toLowerCase()));
  }

  countFilledSlots() {
    let filled = 0;
    for (let s = 9; s <= 44; s++) {
      if (this.bot.inventory.slots[s]) filled++;
    }
    return filled;
  }

  getTargetChest() {
    const lookTarget = this.bot.blockAtCursor(5);
    if (lookTarget && (lookTarget.name === 'chest' || lookTarget.name === 'trapped_chest')) {
      return lookTarget;
    }

    return this.bot.findBlock({
      matching: (block) => block && (block.name === 'chest' || block.name === 'trapped_chest'),
      maxDistance: 4.5
    });
  }

  async depositDropsToVipChestLoop() {
    const targetDropNames = ['leather', 'beef', 'cooked_beef', 'cooked_steak', 'steak'];

    while (this.running && !this.isPaused) {
      const dropsRemaining = this.bot.inventory.items().filter((i) => targetDropNames.includes(i.name.toLowerCase()));
      if (dropsRemaining.length === 0) {
        this.emitLog('✅ Inventário limpo de drops! Retornando ao mob...');
        break;
      }

      let currentChestIdx = this.sharedState.getCurrentChestIndex();
      const homeName = `home fatal venda${currentChestIdx}`;
      this.emitLog(`📦 Indo descarregar drops em /${homeName}...`);

      await this.teleportSafe(homeName);
      const chestBlock = this.getTargetChest();
      if (!chestBlock) {
        this.emitLog(`❌ Baú de venda não encontrado em /${homeName}. Avançando baú...`, true);
        await this.sharedState.advanceChestIndex(this.config.username, currentChestIdx);
        continue;
      }

      await this.bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
      await this.sleep(400);

      let container = null;
      try {
        container = await this.bot.openContainer(chestBlock);
        await this.sleep(600);
      } catch (e) {
        this.emitLog(`Erro ao abrir baú em /${homeName}: ${e.message}`, true);
        continue;
      }

      let chestFull = false;
      const dropsToDeposit = container.slots.slice(container.inventoryStart).filter((it) => it && targetDropNames.includes(it.name.toLowerCase()));

      for (const item of dropsToDeposit) {
        try {
          await this.bot.clickWindow(item.slot, 0, 1);
          await this.sleep(60);
        } catch (err) {
          chestFull = true;
          break;
        }
      }

      const emptyInChest = container.slots.slice(0, container.inventoryStart).filter((s) => !s).length;
      if (emptyInChest === 0 || chestFull) {
        this.emitLog(`⚠️ Baú /${homeName} lotou! Avançando contador de baú...`);
        container.close();
        await this.sleep(500);
        await this.sharedState.advanceChestIndex(this.config.username, currentChestIdx);
      } else {
        container.close();
        await this.sleep(500);
      }
    }

    await this.teleportSafe('home mob');
    await this.ensureUsableSwordOrReplace();
    this.lastMobHitTimestamp = Date.now();
  }

  async checkAndHandleInventoryDischarge() {
    const filledSlots = this.countFilledSlots();

    if (filledSlots >= 27) {
      if (this.sharedState.getVipSellEnabled()) {
        this.emitLog(`📦 Inventário com ${filledSlots} slots cheios (>= 27). Guardando em baús...`);
        await this.depositDropsToVipChestLoop();
      } else {
        this.emitLog(`📦 Inventário com ${filledSlots} slots cheios (>= 27). Vendendo direto...`);
        const drops = this.getMobDropsCount();
        let totalItems = 0;
        for (const it of drops) totalItems += it.count;
        this.sharedState.addDropsSold(this.config.username, totalItems / 64);

        await this.sendCommand('/vender mobs', 1200);
        await this.sleep(600);
        await this.sendCommand('/vender farms', 1200);
        await this.sleep(800);
      }
    }
  }

  async replaceSwordRoutine() {
    const filledSlots = this.countFilledSlots();
    if (filledSlots >= 27) {
      await this.checkAndHandleInventoryDischarge();
    }

    // Varredura rigorosa: só considera sem espada se de fato não houver nenhuma
    let hasAnySword = false;
    for (let s = 9; s <= 44; s++) {
      const it = this.bot.inventory.slots[s];
      if (it && it.name === 'diamond_sword') {
        hasAnySword = true;
        break;
      }
    }

    const wasCompletelyWithoutSword = !hasAnySword;

    this.emitLog('🔨 [BAÚ DE ESPADAS] Verificando estoque de reposição...');
    const homes = ['home fatal repararespadas1', 'home fatal repararespadas2'];
    let swordExchanged = false;

    for (const home of homes) {
      if (swordExchanged || !this.running || this.isPaused) break;

      await this.teleportSafe(home);

      const chestBlock = this.getTargetChest();
      if (!chestBlock) {
        this.emitLog(`❌ [ERRO] Nenhum baú em /${home}. Tentando próxima home...`, true);
        continue;
      }

      await this.bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
      await this.sleep(600);

      let container = null;
      try {
        container = await this.bot.openContainer(chestBlock);
        await this.sleep(1800);
      } catch (openErr) {
        this.emitLog(`❌ Falha ao abrir baú em /${home}: ${openErr.message}`, true);
        continue;
      }

      if (!container || !this.bot.currentWindow) {
        continue;
      }

      try {
        const freshInChest = [];
        for (let s = 0; s < container.inventoryStart; s++) {
          const item = container.slots[s];
          if (item && item.name === 'diamond_sword' && this.getSwordDurability(item) >= 1200) {
            freshInChest.push({ slot: s, item: item, dur: this.getSwordDurability(item) });
          }
        }

        if (freshInChest.length === 0) {
          this.emitLog(`⚠️ Sem espadas aptas (>= 1200) em /${home}.`);
          if (this.bot.currentWindow) container.close();
          await this.sleep(800);
          continue;
        }

        // Localiza espada gasta do jogador (durabilidade < 500)
        let brokenSwordSlot = null;
        for (let s = container.inventoryStart; s < container.slots.length; s++) {
          const it = container.slots[s];
          if (it && it.name === 'diamond_sword') {
            const d = this.getSwordDurability(it);
            if (d < 500) {
              brokenSwordSlot = s;
              break;
            }
          }
        }

        let depositedBroken = false;
        if (brokenSwordSlot !== null) {
          let emptyChestSlot = null;
          for (let s = 0; s < container.inventoryStart; s++) {
            if (!container.slots[s]) {
              emptyChestSlot = s;
              break;
            }
          }

          if (emptyChestSlot !== null) {
            await this.bot.clickWindow(brokenSwordSlot, 0, 0);
            await this.sleep(500);
            await this.bot.clickWindow(emptyChestSlot, 0, 0);
            await this.sleep(500);
            depositedBroken = true;
          } else {
            await this.bot.clickWindow(brokenSwordSlot, 0, 1);
            await this.sleep(500);
            depositedBroken = true;
          }
        }

        // Retira a nova espada utilizável do baú
        const targetNew = freshInChest[0];
        await this.bot.clickWindow(targetNew.slot, 0, 1);
        await this.sleep(800);

        swordExchanged = true;

        // Só incrementa o contador de espadas quebradas SE pegou a nova espada com sucesso
        // E (estava sem espada OU devolveu uma gasta ao baú)
        if (wasCompletelyWithoutSword || depositedBroken) {
          await this.sharedState.claimNextSwordSlot(this.config.username);
          if (wasCompletelyWithoutSword) {
            this.emitLog(`⚔️ [REPOSIÇÃO CONFIRMADA] Conta estava sem espada: pegou uma nova no baú e incrementou o contador.`);
          }
        }

        if (this.bot.currentWindow) {
          container.close();
          await this.sleep(800);
        }

        this.emitLog(`✅ Espada retirada com sucesso em /${home}.`);
        break;
      } catch (err) {
        this.emitLog(`❌ Erro na manipulação do baú: ${err.message}`, true);
        if (this.bot.currentWindow) {
          try { container.close(); } catch (e) {}
        }
      }
    }

    const currentInventorySword = this.getDiamondSword();
    const hasValidSwordNow = currentInventorySword && this.getSwordDurability(currentInventorySword) >= 1000;

    if (!swordExchanged && !hasValidSwordNow) {
      this.emitLog('❌ Nenhuma espada utilizável encontrada. Pausando para evitar morte.', true);
      this.pause();
      return false;
    }

    await this.sleep(500);
    const bestSword = this.getDiamondSword();
    if (bestSword) {
      try {
        await this.bot.equip(bestSword, 'hand');
        await this.sleep(500);
        this.emitLog(`⚔️ Espada equipada na mão! Durabilidade: ${this.getSwordDurability(bestSword)}/1561.`);
      } catch (e) {}
    }

    this.emitLog('📍 Teleportando de volta para /home mob...');
    await this.teleportSafe('home mob');
    this.lastMobHitTimestamp = Date.now();
    return true;
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
    const hasSword = await this.ensureUsableSwordOrReplace();
    if (!hasSword) return;

    await this.teleportSafe('home mob');
    this.lastMobHitTimestamp = Date.now();
    this.emitLog('🎯 Abatendo mobs com proteção ativa contra quebra...');

    let hitsUntilNextCheck = 1;

    while (this.running && !this.isPaused) {
      if (this.isHandlingAfk || this.isExecutingSafehomeRecovery) {
        await this.sleep(1000);
        continue;
      }

      if (Date.now() - this.lastMobHitTimestamp >= 180000) {
        await this.handleNoMobInactivityWatchdog();
        continue;
      }

      // Verificação preditiva periódica da espada
      hitsUntilNextCheck--;
      if (hitsUntilNextCheck <= 0) {
        let currentSword = this.bot.heldItem;
        if (!currentSword || currentSword.name !== 'diamond_sword') {
          const bestInInv = this.getDiamondSword();
          if (bestInInv && this.getSwordDurability(bestInInv) >= this.MIN_DURABILITY_THRESHOLD) {
            try {
              await this.bot.equip(bestInInv, 'hand');
              await this.sleep(300);
              currentSword = this.bot.heldItem;
            } catch (e) {}
          }
        }

        const dur = this.getSwordDurability(currentSword);

        // Se atingir ou se aproximar do limiar de segurança (350), troca no baú
        if (!currentSword || currentSword.name !== 'diamond_sword' || dur <= this.MIN_DURABILITY_THRESHOLD) {
          this.emitLog(`🛡️ [PROTEÇÃO ATIVA] Durabilidade da espada atingiu ${dur}/1561 (limiar: ${this.MIN_DURABILITY_THRESHOLD}). Trocando no baú antes de bater...`);
          await this.replaceSwordRoutine();
          hitsUntilNextCheck = 1;
          continue;
        }

        // LÓGICA DE DEGRAUS:
        // Diferença até a durabilidade de troca
        const diff = dur - this.MIN_DURABILITY_THRESHOLD;
        if (diff < 150) {
          // Quando estiver a menos de 150 pontos da troca, verifica estritamente a cada 3 hits
          hitsUntilNextCheck = 3;
        } else {
          // Bate a metade da diferença antes de checar novamente (limitado entre 10 e 80 hits)
          hitsUntilNextCheck = Math.max(5, Math.min(80, Math.floor(diff / 2)));
        }
      }

      if (Date.now() - this.lastInventoryCheck >= 8000) {
        await this.checkAndHandleInventoryDischarge();
        this.lastInventoryCheck = Date.now();
      }

      const mob = this.findNearbyMob();
      if (mob) {
        try {
          await this.bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true);
          this.bot.attack(mob);
          this.lastMobHitTimestamp = Date.now();
          this.sharedState.registerMobHit(this.config.username);

          // Checagem de segurança rápida a cada golpe na mão para evitar quebras por lag
          const heldNow = this.bot.heldItem;
          if (heldNow && heldNow.name === 'diamond_sword') {
            const currentDurNow = this.getSwordDurability(heldNow);
            if (currentDurNow <= this.MIN_DURABILITY_THRESHOLD) {
              this.emitLog(`🛡️ [ALERTA DE SEGURANÇA] Durabilidade pós-hit: ${currentDurNow}/1561. Desarmando e trocando no baú...`);
              await this.replaceSwordRoutine();
              hitsUntilNextCheck = 1;
              continue;
            }
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

module.exports = MobFarmerMacro;